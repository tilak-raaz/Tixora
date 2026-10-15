# Lessons

Bugs found, surprises, and what each one taught. Newest first. These become the stories for
interviews, so record the symptom, the cause, the fix, and how a test now guards it.

## 2026-10-15 · The benchmark overturned the default

- **Symptom:** with 300 buyers on one seat, the "simple" Postgres-only strategy made every buyer
  wait about 200 ms (330 ms in another run), even though 299 of them were going to lose.
- **Cause:** each losing request still borrowed one of 30 Postgres connections and queued on the
  winner's row lock. The losers were not just slow themselves; they starved the pool for
  everyone else.
- **Fix:** put a millisecond-scale Redis lock in front of the transaction to turn losers away
  before they reach Postgres, while Postgres still decides ownership. Median wait fell from
  193 ms to 7 ms. The first version of ADR 0005 had picked the Postgres-only strategy on
  simplicity; the measurement changed the decision.
- **Guarded by:** `make bench` (checks invariants after every run) and
  `hold-strategies.test.ts` (Redis down still gives exactly one winner).

## 2026-10-15 · Single-threaded Node still double-books

- **Symptom:** ten buyers asked for the same seat at once and all ten were told it was theirs. The
  seat ended up owned by whichever request wrote last; nine people would have paid for nothing.
- **Cause:** read the seat's status, `await`, then write. Every `await` hands the event loop to
  other requests, and the gap between the read and the write is real time on other database
  connections (and other replicas). Single-threaded JavaScript does not make check-then-act atomic.
- **Fix:** one conditional `UPDATE` that locks the requested seats in id order and changes only
  those still free; the service compares the rows updated with the rows requested and rolls back
  on any shortfall. The database decides who wins, not the application.
- **Guarded by:** `booking-concurrency.test.ts`. The naive version is kept as a test that
  reproduces the bug; 200 buyers spread over 3 replicas get exactly one winner; overlapping
  multi-seat requests never end up with part of a booking.

## Template

### YYYY-MM-DD · Short title

- **Symptom:**
- **Cause:**
- **Fix:**
- **Guarded by:** test name or invariant
