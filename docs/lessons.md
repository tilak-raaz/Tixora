# Lessons

Bugs found, surprises, and what each one taught. Newest first. These become the stories for
interviews, so record the symptom, the cause, the fix, and how a test now guards it.

## 2026-10-17 · Three replicas are not three times faster

- **Symptom:** the capacity run served 1,206 requests a second on one API replica and 1,586 on
  three: 32% more, not 200% more. At normal browsing load the median hardly changed either.
- **Cause:** the replicas were the bottleneck only while there was one of them. That replica sat
  at one full core, the limit of Node's single JavaScript thread. With three, each was busy about
  70% of the time, and the ceiling moved to what shares the same 8 CPUs: the load generator, nginx
  and Postgres. What three replicas did change was the tail: at the same browsing load, p99 fell
  from 497 ms to 44 ms, because a burst no longer queues behind one busy thread.
- **Fix:** none needed; the measurement corrected the expectation. Scaling out pays only while the
  thing being scaled is the bottleneck, and the per-replica metrics (CPU, event loop lag) show
  when it stops being one.
- **Guarded by:** `make load-browse THINK=0` with `make stack-scale N=1` and `N=3`, and the
  numbers in docs/benchmarks/m7-load.md.

## 2026-10-17 · Healthy is not the same as ready to be timed

- **Symptom:** the first Playwright test through nginx failed right after `make stack-e2e`
  rebuilt the stack: sign-up took 12 s against a 10 s limit. The other three tests passed, and
  the same sign-up took 200 ms a minute later.
- **Cause:** not what it looked like. nginx's access log (which replica answered, and how long it
  took) showed every request going to a live replica, so stale addresses were ruled out.
  Restarting and then recreating the replicas and timing them straight away showed them fast
  from the first request, so slow cold replicas were ruled out too. For about 30 s every replica
  was slow at once, while the laptop was still finishing the image build, compiling a seed run
  and starting Chromium: the containers were healthy but starved of CPU.
- **Fix:** `make stack-warm` waits until the stack answers five rounds in a row under 0.5 s
  before tests or load runs start. The app did not change; the measurement did.
- **Guarded by:** `make stack-e2e` and the CI stack job run it before Playwright.

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
