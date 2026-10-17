# Benchmarks

Each file here is the output of a benchmark script, committed with the change it measures.
Numbers come from a laptop with everything in Docker: use them to compare options with each
other, not as capacity figures.

| File                                           | Script                                | Run with       |
| ---------------------------------------------- | ------------------------------------- | -------------- |
| [m2-hold-strategies.md](m2-hold-strategies.md) | `apps/api/src/scripts/bench-holds.ts` | `make bench`   |
| [m7-load.md](m7-load.md)                       | `infra/load/` (k6, Node.js)           | `make load-*`  |
| [m7-drills.md](m7-drills.md)                   | `infra/drills/`                       | `make drill-*` |

`make bench` needs `make up` first. It creates a throwaway database, runs every scenario, checks
the booking invariants after each run (a strategy that is fast but wrong fails the benchmark),
writes the report here and drops the database. It takes a minute or two.

The `make load-*` targets need the full stack running (`make stack DEMO=1`, then `make stack-seed`
on an empty database). Each one waits for the stack to answer at normal speed, runs its scenario
and fails if the scenario's rule was broken (ADR 0016). Run `make stack-metrics` afterwards to see
where the load landed.
