# Autonomy M-pass acceptance audit — 2026-08-04

First recorded acceptance run of the M1–M15 implementation pass
(AUTONOMY-OVERHAUL-PLAN §3–§9), per the plan's own P0.1 requirement.

## Environment
- Local dev, macOS; Postgres + Redis on host (Docker Desktop unstable this day — containers segfaulting; suites ran against host services via `.env`).
- `uv run pytest`, Python 3.12.

## Results

| Suite | Result |
|---|---|
| `tests/integration/golden_path/` (3 scenarios: code bug, deploy regression, merge regression) | **19 passed**, exit 0 |
| `tests/unit/closed_loop` + `tests/unit/improvement` + `tests/unit/sandbox` + `tests/unit/patches` | **442 passed**, exit 0 |

## Verdict
The M-pass wiring (outbox event bus, truthful transitions, redaction chokepoints,
sandbox hardening, replay-verify, test gate, PR evidence) holds under its own
test vehicles. Defect list: none at unit/golden-path level.

Known remaining soft spot being fixed in this program (not a test failure):
N01 regression runner pass-open semantics (`regression_runner.py`) — tri-state
fail-closed change in flight.

## Next snapshots
Weekly runs should append files to this directory (see the recurring
assertions wired via `scripts/autonomy_baseline.py` once landed).
