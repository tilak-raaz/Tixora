# Lessons

Bugs found, surprises, and what each one taught. Newest first. These become the stories for
interviews, so record the symptom, the cause, the fix, and how a test now guards it.

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
