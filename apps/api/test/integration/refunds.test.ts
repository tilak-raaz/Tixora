import { randomUUID } from 'node:crypto';
import {
  createEmailQueue,
  createRefundQueue,
  createRefundWorker,
  startOutboxRelay,
  startRefundSweeper,
} from '@bmt/jobs';
import { createFakeGateway, GatewayError, sendRefund, type FakeGateway } from '@bmt/payments';
import { createLogger } from '@bmt/platform';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';
import { createApp } from '../../src/app';
import { createTestDeps } from './helpers';
import { checkInvariants } from './invariants';
import {
  bookingStatus,
  createCheckout,
  expireHoldNow,
  refundsOf,
  type Checkout,
} from './payment-fixtures';
import { deliver, paymentEvent, WEBHOOK_SECRET } from './webhooks';

/** Getting recorded refunds to Razorpay: the job, its retries, the sweeper and refund webhooks. */

const logger = createLogger({ name: 'test', level: 'silent' });
const prefix = `bmt-test-${randomUUID()}`;
let deps: ReturnType<typeof createTestDeps>;
let gateway: FakeGateway;
let app: ReturnType<typeof createApp>;
const shows: string[] = [];

beforeAll(() => {
  deps = createTestDeps();
});
beforeEach(() => {
  gateway = createFakeGateway();
  app = createApp({ ...deps, paymentGateway: gateway, paymentWebhookSecret: WEBHOOK_SECRET });
});
afterEach(async () => {
  expect(await checkInvariants(deps.pool, shows)).toEqual([]);
});
afterAll(async () => {
  await deps.close();
});

/** A payment that arrived after its hold ran out: recorded, with a PENDING refund. */
async function latePayment(
  onApp = app,
): Promise<Checkout & { refundId: string; paymentId: string }> {
  const c = await createCheckout(onApp, deps.pool);
  shows.push(c.showId);
  await expireHoldNow(deps.pool, c.bookingId);
  const paid = gateway.capture(c.orderId);
  const res = await deliver(
    onApp,
    paymentEvent('payment.captured', {
      orderId: c.orderId,
      paymentId: paid.id,
      amountPaise: c.amountPaise,
    }),
  );
  expect(res.status).toBe(200);
  const [refund] = await refundsOf(deps.pool, c.bookingId);
  expect(refund).toMatchObject({ reason: 'HOLD_ENDED' });
  // Nothing sends it until a relay runs, so it must still be waiting.
  expect(refund!.status).toBe('PENDING');
  return { ...c, refundId: refund!.id, paymentId: paid.id };
}

function refundEvent(
  type: 'refund.processed' | 'refund.failed',
  refund: { id: string; paymentId: string; receipt: string },
) {
  return {
    entity: 'event',
    event: type,
    contains: ['refund', 'payment'],
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      refund: {
        entity: {
          id: refund.id,
          payment_id: refund.paymentId,
          receipt: refund.receipt,
          status: type === 'refund.processed' ? 'processed' : 'failed',
        },
      },
    },
  };
}

describe('sending a refund', () => {
  it('refunds the full payment once and records it as processed', async () => {
    const late = await latePayment();

    expect(await sendRefund(deps.pool, gateway, late.refundId)).toBe('processed');
    expect(await sendRefund(deps.pool, gateway, late.refundId)).toBe('not_pending');

    expect(gateway.calls.refundPayment).toBe(1);
    expect(gateway.refunds).toMatchObject([
      { paymentId: late.paymentId, amountPaise: late.amountPaise, receipt: late.refundId },
    ]);
    const [refund] = await refundsOf(deps.pool, late.bookingId);
    expect(refund).toMatchObject({ status: 'PROCESSED', razorpayRefundId: gateway.refunds[0]!.id });
  });

  it('keeps a refund Razorpay is still processing PENDING, and checks on it later', async () => {
    const late = await latePayment();
    gateway.refundStatus = 'pending';

    expect(await sendRefund(deps.pool, gateway, late.refundId)).toBe('pending');
    gateway.settleRefund(gateway.refunds[0]!.id, 'processed');
    expect(await sendRefund(deps.pool, gateway, late.refundId)).toBe('processed');

    expect(gateway.calls.refundPayment).toBe(1); // the second run only asked
  });

  it('finds the refund an earlier attempt made but never recorded, instead of refunding twice', async () => {
    const late = await latePayment();
    // As if the worker died right after Razorpay answered.
    await gateway.refundPayment({
      paymentId: late.paymentId,
      amountPaise: late.amountPaise,
      receipt: late.refundId,
    });

    expect(await sendRefund(deps.pool, gateway, late.refundId)).toBe('processed');
    expect(gateway.refunds).toHaveLength(1);
  });

  it('fails without touching the refund while Razorpay is down, so the job retries', async () => {
    const late = await latePayment();
    gateway.failNext();

    await expect(sendRefund(deps.pool, gateway, late.refundId)).rejects.toBeInstanceOf(
      GatewayError,
    );
    expect((await refundsOf(deps.pool, late.bookingId))[0]!.status).toBe('PENDING');

    expect(await sendRefund(deps.pool, gateway, late.refundId)).toBe('processed');
  });
});

describe('refund webhooks', () => {
  it('records refund.processed, even before the job has stored the Razorpay id', async () => {
    const late = await latePayment();
    gateway.refundStatus = 'pending';
    const atRazorpay = await gateway.refundPayment({
      paymentId: late.paymentId,
      amountPaise: late.amountPaise,
      receipt: late.refundId,
    });

    const event = refundEvent('refund.processed', {
      id: atRazorpay.id,
      paymentId: late.paymentId,
      receipt: late.refundId,
    });
    expect((await deliver(app, event)).status).toBe(200);

    expect((await refundsOf(deps.pool, late.bookingId))[0]).toMatchObject({
      status: 'PROCESSED',
      razorpayRefundId: atRazorpay.id,
    });
  });

  it('records refund.failed, and never moves a settled refund again', async () => {
    const late = await latePayment();
    gateway.refundStatus = 'pending';
    await sendRefund(deps.pool, gateway, late.refundId);
    const id = gateway.refunds[0]!.id;
    const ids = { id, paymentId: late.paymentId, receipt: late.refundId };

    await deliver(app, refundEvent('refund.failed', ids));
    await deliver(app, refundEvent('refund.processed', ids)); // late and contradictory

    expect((await refundsOf(deps.pool, late.bookingId))[0]!.status).toBe('FAILED');
  });
});

describe('the refund job and sweeper', () => {
  it('refunds a late payment end to end: webhook, outbox, relay, queue, worker, Razorpay', async () => {
    const queue = createRefundQueue(inject('redisUrl'), { prefix: `${prefix}-e2e` });
    const emails = createEmailQueue(inject('redisUrl'), { prefix: `${prefix}-e2e` });
    const worker = createRefundWorker(
      { redisUrl: inject('redisUrl'), pool: deps.pool, gateway, logger },
      { prefix: `${prefix}-e2e` },
    );
    const late = await latePayment();
    // The relay also picks up events other test files left unpublished; their
    // refunds go to this fake Razorpay too, which is harmless.
    const relay = startOutboxRelay(
      { pool: deps.pool, queues: { refunds: queue, email: emails }, logger },
      { intervalMs: 100 },
    );

    try {
      await vi.waitFor(
        async () =>
          expect((await refundsOf(deps.pool, late.bookingId))[0]!.status).toBe('PROCESSED'),
        { timeout: 10_000, interval: 100 },
      );
      expect(await bookingStatus(deps.pool, late.bookingId)).toBe('PENDING_PAYMENT');
      // The same event also queued the refund email (sent from M4 PR 2).
      const { rows } = await deps.pool.query<{ id: string }>(
        "SELECT id FROM outbox WHERE topic = 'refund.recorded' AND aggregate_id = $1",
        [late.refundId],
      );
      expect((await emails.getJob(rows[0]!.id))?.name).toBe('refund-recorded');
    } finally {
      await relay.stop();
      await worker.close();
      for (const q of [queue, emails]) {
        await q.obliterate({ force: true });
        await q.close();
      }
    }
  });

  it('sends a refund that was never queued once the sweeper finds it', async () => {
    const queue = createRefundQueue(inject('redisUrl'), { prefix: `${prefix}-sweep` });
    const worker = createRefundWorker(
      { redisUrl: inject('redisUrl'), pool: deps.pool, gateway, logger },
      { prefix: `${prefix}-sweep` },
    );
    const late = await latePayment(); // no relay is running: nothing was queued

    const sweeper = startRefundSweeper(
      { pool: deps.pool, queue, logger },
      { intervalMs: 60_000, olderThanSeconds: 0 },
    );
    try {
      await vi.waitFor(
        async () =>
          expect((await refundsOf(deps.pool, late.bookingId))[0]!.status).toBe('PROCESSED'),
        { timeout: 10_000, interval: 100 },
      );
      // Exactly one refund for this payment (the sweeper also picks up refunds other test files left PENDING).
      expect(gateway.refunds.filter((r) => r.paymentId === late.paymentId)).toHaveLength(1);
    } finally {
      await sweeper.stop();
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
