# 0013. Live seat maps: Server-Sent Events fed by Redis pub/sub, with a version heartbeat

- Status: Accepted
- Date: 2026-10-16

## Context

A buyer looking at a seat map should see seats go as other people take them, rather than finding
out with a 409 when they try to hold one. The hold transaction already decides who gets a seat
(ADR 0005), so this is about freshness, not correctness.

The options:

- **Polling** the seat map every few seconds: simple, but every open map costs requests while
  nothing changes, and a change still takes up to the poll interval to show.
- **WebSockets:** two-way, which we do not need, and harder to put behind proxies.
- **Server-Sent Events:** one long HTTP response the server writes events to. Browsers reconnect
  by themselves.

With several API replicas, a browser is connected to one replica while the change can happen on
another, or in the worker (expiry, the reconciler). Every replica has to hear about every change.

## Decision

- **SSE** at `GET /api/v1/shows/:id/seats/events`, public like the seat map. Events: `ready` (the
  subscription is live, load the map now), `seats` (changed seats with their public status and
  version), `heartbeat` (every 15 s) and `resync` (load the map again).
- **Publish after commit, from wherever the change happened.** A hold, a release, a hold expired
  by the job, the sweeper or a new hold, and a confirmed payment (webhook or reconciler) each
  publish the seats' state, read back from Postgres, on the show's Redis channel
  (`bmt:seats:<show id>`). Publishing never fails the request: the change has committed.
- **One subscription per show per replica.** Each replica subscribes to a show's channel while it
  has at least one viewer of that show, and forwards every message to all of them.
- **The browser merges by version.** It loads the map after `ready` and keeps the higher
  `show_seats.version` of each seat, so events and the snapshot can arrive in any order.
- **Lost events are caught, not prevented.** Pub/sub keeps nothing: an event published while a
  subscriber is disconnected, or never published because a process died after its commit, is
  gone. Two checks cover that:
  - the heartbeat carries the show's seat version (the sum of its seats' versions). Versions only
    grow, so if the browser's own seats still add up to less than a heartbeat's version one
    heartbeat later, it missed something and reloads the map;
  - when a replica's subscription reconnects, it sends `resync` to all of its viewers.
- **Limits:** opening a stream counts against the browse rate limit (per IP, across replicas),
  and each replica allows 6 open streams per IP, counted in memory because the connections live
  in that process.
- Responses set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, so proxies
  pass events through as they come.

Seat changes do not go through the outbox (ADR 0008). The outbox is for side effects that must
happen exactly once; a seat event is a hint that is cheap to lose and must be fast, and an outbox
row per hold would add a write, and the relay's delay, to the busiest path.

## Consequences

- A change reaches every viewer in milliseconds, on any replica, and an idle map costs one open
  connection and a heartbeat instead of a request every few seconds.
- A lost event leaves a seat stale for up to two heartbeats (30 s). Holding it still fails with a
  409, and the map reloads then too.
- A seat whose hold runs out is free in the seat map at once but is announced only when the
  expiry job or the sweeper frees it, about a second later (or up to the sweep interval if the
  job was lost).
- Each replica keeps one connection per viewer and one Redis subscriber connection. Shutting down
  ends the streams first; browsers reconnect, to another replica behind nginx (M7).
