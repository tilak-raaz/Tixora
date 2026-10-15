# Benchmarks

Each file here is the output of a benchmark script, committed with the change it measures.
Numbers come from a laptop with everything in Docker: use them to compare options with each
other, not as capacity figures.

| File                                           | Script                                | Run with     |
| ---------------------------------------------- | ------------------------------------- | ------------ |
| [m2-hold-strategies.md](m2-hold-strategies.md) | `apps/api/src/scripts/bench-holds.ts` | `make bench` |

`make bench` needs `make up` first. It creates a throwaway database, runs every scenario, checks
the booking invariants after each run (a strategy that is fast but wrong fails the benchmark),
writes the report here and drops the database. It takes a minute or two.
