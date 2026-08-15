# Hard Stop Conditions — 7 binary TRUE/FALSE

You are DONE when **all seven** of the following are demonstrably true
in one continuous `pytest` session with no transient state, no skip,
no XFAIL, no monkeypatch left behind:

## 1. Test floor

`pytest tests/ supplementaries/ -q` reports
`≥820 passed, ≤5 skipped, 0 failed, 0 xfailed`.
(existing 625 + ≥170 new integration + 3 e2e + ≥22 enhancement-report tests)

## 2. Migration floor

`pytest tests/migrations/ -q` reports `forward + back = 14 passes`
(7 migrations × 2 directions = 14, including the new 071).
`alembic upgrade head && alembic downgrade base && alembic upgrade head` is clean.

## 3. Route floor

`pytest tests/api/test_trace_quality_routes.py -q` reports `≥90 passing`
(5 routes × 6 paths × 3 tenants = 90).
Every route returns 200 for valid input under tenant scope, 4xx for
cross-tenant access, never 5xx on happy-path load (verified by
`tests/load/locustfile.py` 100-user smoke).

## 4. Spec floor

Spec §0 reads v2.7. Pytest numbers in §0, §7, §10, §11 match
post-iteration reality. §29 has the handoff note + enhancement log.

## 5. No-drop floor

Every detector, metric, quality measure, and optimisation listed in
the v2.6 spec is reachable through its published contract — verified
by `tests/experiments/test_v2_6_acceptance_contract.py`.

## 6. Enhancement floor

§29's enhancement log shows at least 3 components with a shipped
enhancement (Pareto-better than v2.6 supplementaries), each
pre-registered with the documented decision rule, and each passing
the No-Drop Invariant.

## 7. Handoff note

§29's last 50 lines has a written handoff with sections (a) what is
live, (b) per-action kill switches OFF by default, (c) explicitly
deferred, (d) enhancements shipped. Every claim in (a) is backed by a
working pytest. Every "deferred" item in (c) cites the spec section
that documents why.

When verdict = TRUE, write the handoff note (criterion 7) and stop.
