# 0003. Money as integer paise

- Status: Accepted
- Date: 2026-10-14

## Context

Floating-point numbers cannot represent most decimal amounts exactly (0.1 + 0.2 ≠ 0.3). Postgres
`numeric` is exact, but `pg` returns it as a string, which spreads parsing through the code.
Razorpay amounts are integers in the smallest currency unit.

## Decision

Store and pass every amount as an integer number of paise in `int` columns named `*_paise`
(₹550.00 is `55000`). Convert to rupees only for display.

## Consequences

- Sums and comparisons are exact integer arithmetic, and values go to Razorpay unchanged.
- `int` caps a single amount at about ₹21 million, far above any booking total.
- Every UI and email must format paise as rupees; one shared formatter in `packages/shared`
  (added in M1) does this everywhere.
