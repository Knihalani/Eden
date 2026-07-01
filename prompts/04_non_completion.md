# Hard Non-Completion Conditions — 14 anti-patterns

If any one of these is true, the goal is incomplete regardless of test
counts. These override any "but it works" reasoning:

1. Any v2.6-spec'd detector, metric, action enum, or optimisation
   no longer reachable through its published contract.
2. Any new code path with no test in `tests/`.
3. Any spec behaviour from v2.6 that no longer passes the 171-trace
   synthetic dataset (silent regression).
4. Any `print(...)` or `TODO` in shipped code.
5. Any migration that breaks `alembic downgrade base` (no clean back).
6. Any tenant whose data leaks into a sibling tenant's report table.
7. Any guardrail auto-apply behaviour that does NOT gate through the
   full 5-check StatGate.
8. Any LLM call reachable from the hot-path at runtime.
9. Any per-action kill switch that defaults to ON for a mutating
   action.
10. Any enhancement that didn't pre-register its metrics.
11. Any enhancement promoted without a No-Drop Invariant test pass.
12. Any enhancement that broke a baseline test, even if "fixed later
    in the same PR".
13. Any component where the v2.6 implementation was replaced without
    git tag `v2.6-baseline-<component>` for 90 days.
14. Adding "**shadow**" or "**calibration period**" as a system-wide
    runtime gate. Use per-action kill switches instead.

## What to do when you find yourself rationalising

You will, at some point, feel like one of these rules should bend
because: "this is just a small thing", "we'll fix it in the next PR",
"this is an optimization not a behaviour change", "the spec was
ambiguous".

Stop. That rationalisation IS the anti-pattern. The rule is what it is.

Write the issue into §29 as deferred or rolled-back. Do not ship it.
