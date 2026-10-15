import {
  createFakeGateway,
  reconcileOnce,
  type FakeGateway,
  type ReconcileOptions,
} from '@bmt/payments';
import { createLogger, createPool, type Pool } from '@bmt/platform';
import { startReconciler, type RefundScheduler } from '@bmt/jobs';
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

/** The reconciler: payments whose webhook never arrived. */

const logger = createLogger({ name: 'test', level: 'silent' });
let deps: ReturnType<typeof createTestDeps>;
let gateway: FakeGateway;
let app: ReturnType<typeof createApp>;
const shows: string[] = [];

// Orders in these tests are moved 3 hours into the past and the window is set
// around them, so orders other test files leave behind are never claimed.
const OPTIONS: ReconcileOptions = {
  minAgeSeconds: 2 * 60 * 60,
  maxAgeSeconds: 4 * 60 * 60,
  recheckSeconds: 10 * 60,
  batchSize: 50,
};

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

async function checkout(): Promise<Checkout> {
  const c = await createCheckout(app, deps.pool);
  shows.push(c.showId);
  return c;
}

/** Puts an order inside the test window, as if it were created 3 hours ago. */
async function age(orderId: string): Promise<void> {
  await deps.pool.query(
    "UPDATE payment_orders SET created_at = now() - interval '3 hours' WHERE razorpay_order_id = $1",
    [orderId],
  );
}

describe('the reconciler', () => {
  it('confirms a paid booking whose webhook never came', async () => {
    const c = await checkout();
    gateway.capture(c.orderId);
    await age(c.orderId);

    const report = await reconcileOnce(deps.pool, gateway, OPTIONS);

    expect(report.outcomes).toMatchObject([{ kind: 'confirmed', bookingId: c.bookingId }]);
    expect(await bookingStatus(deps.pool, c.bookingId)).toBe('CONFIRMED');
  });

  it('records a refund for a payment captured after the hold ended', async () => {
    const c = await checkout();
    await expireHoldNow(deps.pool, c.bookingId);
    gateway.capture(c.orderId);
    await age(c.orderId);

    await reconcileOnce(deps.pool, gateway, OPTIONS);

    expect(await refundsOf(deps.pool, c.bookingId)).toMatchObject([
      { status: 'PENDING', reason: 'HOLD_ENDED' },
    ]);
  });

  it('applies a payment once when the webhook arrives as well', async () => {
    const c = await checkout();
    await expireHoldNow(deps.pool, c.bookingId);
    const paid = gateway.capture(c.orderId);
    await deliver(
      app,
      paymentEvent('payment.captured', {
        orderId: c.orderId,
        paymentId: paid.id,
        amountPaise: c.amountPaise,
      }),
    );
    await age(c.orderId);

    const report = await reconcileOnce(deps.pool, gateway, OPTIONS);

    expect(report.checked).toBe(1);
    expect(report.outcomes).toEqual([]);
    expect(await refundsOf(deps.pool, c.bookingId)).toHaveLength(1);
  });

  it('leaves orders that are too new, and does not ask about an order twice in a row', async () => {
    const fresh = await checkout();
    const old = await checkout();
    await age(old.orderId);

    const first = await reconcileOnce(deps.pool, gateway, OPTIONS);
    const second = await reconcileOnce(deps.pool, gateway, OPTIONS);

    expect(first.checked).toBe(1);
    expect(second.checked).toBe(0);
    expect(gateway.calls.listOrderPayments).toBe(1);
    expect(await bookingStatus(deps.pool, fresh.bookingId)).toBe('PENDING_PAYMENT');
  });

  it('splits the orders between reconcilers running at once, asking about each one once', async () => {
    const checkouts = await Promise.all(Array.from({ length: 6 }, () => checkout()));
    for (const c of checkouts) {
      gateway.capture(c.orderId);
      await age(c.orderId);
    }
    const workers: Pool[] = Array.from({ length: 3 }, () =>
      createPool({
        connectionString: inject('databaseUrl'),
        max: 2,
        applicationName: 'bmt-test',
        logger,
      }),
    );

    try {
      const reports = await Promise.all(
        workers.map((p) => reconcileOnce(p, gateway, { ...OPTIONS, batchSize: 2 })),
      );
      expect(reports.reduce((n, r) => n + r.checked, 0)).toBe(6);
      expect(gateway.calls.listOrderPayments).toBe(6);
      for (const c of checkouts)
        expect(await bookingStatus(deps.pool, c.bookingId)).toBe('CONFIRMED');
    } finally {
      await Promise.all(workers.map((p) => p.end()));
    }
  });

  it('moves on when Razorpay cannot be asked about one order', async () => {
    const a = await checkout();
    const b = await checkout();
    gateway.capture(a.orderId);
    gateway.capture(b.orderId);
    await age(a.orderId);
    await age(b.orderId);
    gateway.failNext();

    const report = await reconcileOnce(deps.pool, gateway, OPTIONS);

    expect(report).toMatchObject({ checked: 2, failed: 1 });
    expect(report.outcomes).toHaveLength(1);
    // The failed one is still owed: settle it so the invariant check after this test holds.
    await deps.pool.query(
      'UPDATE payment_orders SET checked_at = NULL WHERE razorpay_order_id = ANY($1)',
      [[a.orderId, b.orderId]],
    );
    await reconcileOnce(deps.pool, gateway, OPTIONS);
    expect(await bookingStatus(deps.pool, a.bookingId)).toBe('CONFIRMED');
    expect(await bookingStatus(deps.pool, b.bookingId)).toBe('CONFIRMED');
  });

  it('queues the refunds it records when running in the worker', async () => {
    const c = await checkout();
    await expireHoldNow(deps.pool, c.bookingId);
    gateway.capture(c.orderId);
    await age(c.orderId);
    const scheduled: string[] = [];
    const refunds: RefundScheduler = { schedule: async (id) => void scheduled.push(id) };

    const reconciler = startReconciler(
      { pool: deps.pool, gateway, refunds, logger },
      { intervalMs: 60_000, ...OPTIONS },
    );
    try {
      await vi.waitFor(() => expect(scheduled).toHaveLength(1), { timeout: 5_000, interval: 50 });
      expect(scheduled[0]).toBe((await refundsOf(deps.pool, c.bookingId))[0]!.id);
    } finally {
      await reconciler.stop();
    }
  });
});
