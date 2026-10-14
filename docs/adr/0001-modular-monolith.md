# 0001. Modular monolith with separate worker processes

- Status: Accepted
- Date: 2026-10-14

## Context

The project exists to explore distributed-systems problems: contention on seats, holds that expire,
duplicate webhooks, retries. Splitting into microservices on day one would add network calls,
deployment overhead and distributed transactions without making those core problems more visible.
One person builds and runs the system.

## Decision

Build one API codebase organised into modules (auth, catalog, booking, payment, ticket, admin) and
run it as several identical, stateless replicas behind nginx. Run slow or retryable work in separate
worker processes that share the same database. Split a module into its own service only when there
is a measured reason, such as a different scaling need.

## Consequences

- Real distribution still happens: multiple replicas contend for the same rows, and workers run
  independently of the API.
- Modules talk through function calls and the database, which keeps transactions local and simple.
- Module boundaries must be kept by discipline (no module reading another module's tables directly
  outside its repo), since nothing enforces them.
