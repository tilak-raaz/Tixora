# 0007. Payments: the webhook confirms, late and duplicate payments are refunded

- Status: Accepted
- Date: 2026-10-15

## Context

A booking is paid through Razorpay between two short transactions: the hold (ADR 0005) and the
confirmation. Three parties report on a payment, and none can be trusted on its own:

- **The browser** gets Checkout's success callback. It can be closed before reporting, replayed
  or faked, so it can never confirm anything.
- **The webhook** is signed by Razorpay, but it can arrive twice, out of order (`payment.failed`
  after `payment.captured`, or both `payment.captured` and `order.paid` for one payment), late
  (after the hold expired), or never.
- **Razorpay's API** is authoritative, but the app only asks it when it has a reason to (the
  reconciler, M3 PR 4).

Meanwhile the hold can end at any moment: its expiry job, the buyer releasing it, or another
buyer taking seats whose hold has run out.

## Decision

- **Only a payment verified with Razorpay confirms a booking:** the signed webhook, or (PR 4) the
  reconciler asking Razorpay. Checkout's callback is checked (`/payment/verify`) and shown to the
  user, nothing more.
- **Order creation is idempotent at both ends.** One order per booking (database rule); the
  booking id is the Razorpay receipt, so a retry after a crash finds the order Razorpay already
  has. No transaction is open while Razorpay is called.
- **The webhook stores the event and acts on it in one transaction,** after checking the
  signature on the raw body. A redelivered event finds its `event_id` and does nothing; if acting
  on it fails, the event is not stored either and Razorpay's retry runs it again.
- **A payment is recorded once, by its Razorpay id,** so two events about one payment apply it
  once.
- **Confirmation is conditional.** With the booking row locked, a captured payment confirms the
  booking only if it is still `PENDING_PAYMENT`, its hold has not run out, and every one of its
  seats is still `HELD` by it. Seats then become `BOOKED`, the booking `CONFIRMED`, and the
  payment `applied`, in the same commit.
- **Every other captured payment is refunded in full,** never applied: after the hold ended
  (`HOLD_ENDED`), a second payment of the same order (`DUPLICATE_PAYMENT`), or a different amount
  (`AMOUNT_MISMATCH`). A late payment never overrides an expiry: by then the seats may be someone
  else's. The refund is recorded in the same transaction and sent by the refund job (PR 4).
- **Status only moves forward.** Nothing un-confirms a booking, and `payment.failed` changes
  nothing, so the order events arrive in does not matter.

## Consequences

- The buyer whose payment lands a few seconds after the timer gets their money back instead of a
  ticket. That is the honest outcome when the seats may already be sold, and it keeps the rules
  short enough to state and test.
- Hold expiry, releasing a hold and each capture all lock the booking row first, so they happen
  one at a time; the seat check covers the one path that does not lock it (another buyer's hold
  taking seats whose hold has run out).
- A webhook that never arrives leaves a paid booking `PENDING_PAYMENT` until the reconciler (PR 4)
  finds it; until then a missed webhook can cost a sale, never money.
- Tests deliver duplicate, reordered, late, racing and forged events, and check money and seat
  invariants after each one (`test/integration/invariants.ts`).
