# 0011. Catalog cache: cache-aside with a version per namespace; the seat map is never cached

- Status: Accepted
- Date: 2026-10-16

## Context

Browsing (cities, what is playing, a movie's shows, a show's details) is most of the traffic and
changes only when an admin edits the catalog. Every replica answering it from Postgres wastes the
database on identical queries; a popular page expiring sends a crowd of them at once. Whatever is
cached must disappear on every replica as soon as an admin changes something.

The seat map is different: it changes with every hold, and a stale one shows taken seats as free,
which turns straight into failed holds.

## Decision

- **Cache-aside in Redis** for the five catalog reads, 60 seconds (`CATALOG_CACHE_TTL_SECONDS`).
  Responses say `X-Cache: HIT`, `MISS` or `BYPASS`.
- **A version per namespace in every key** (`bmt:cache:catalog:v7:...`). Each admin catalog write
  increments it before answering, so the admin's next read, and every replica's, misses and loads
  fresh data. Nothing has to be found and deleted; old entries expire on their own. A load that
  finishes after an invalidation writes under the old version, which no one reads, so it cannot
  bring stale data back.
- **One load per key per replica.** Requests that miss the same key at the same moment wait for
  the first one's query instead of each running it.
- **Redis is optional for reads.** If it is down or takes longer than 100 ms, the request reads
  Postgres directly (`BYPASS`). If an invalidation fails, entries are stale for at most one TTL.
- **Never cached:** the seat map, and anything per user (bookings, tickets).

## Consequences

- The free-seat counts in a movie's show list can be up to 60 seconds old; the seat map, which the
  buyer sees before holding, is always live.
- The seed script writes through the catalog service without the cache, so fresh seed data can
  take one TTL to appear in a running API.
- A cache entry is plain JSON, so the cache sits at the route, just before the JSON response,
  never under business logic that expects dates or other types.
