# Polish notes — deterministic trace evaluation system

This document records the polish work done to take the system from
"557 passed, 1 skipped" to "600 passed, 0 skipped, 0 failed".

## What changed

### 1. Test-ordering skip fixed (1 test, 1 conftest)

`test_assert_extension_applied_raises_before_apply` was the lone
skipped test — it could only run if no other test in the session
had already called `apply_extension()` (which mutates
`eden.guardrails.policy` module state).

Fix: new `supplementaries/phase_4_guardrails/conftest.py` provides
an `autouse` fixture that snapshots and restores
`policy.VALID_ACTIONS` / `policy.ACTION_RANK` around every test in
the phase. The previously-skipped test now runs on every session.

### 2. 42 new unit tests for Phase 2 TAS composite

`composite.py` (the headline 0–100 metric) previously had no
dedicated unit test — it was only exercised through cross-phase
integration. Added `test_composite.py` with:

- `WEIGHTS` integrity (10 metrics, sum ≈ 1.0, all positive)
- `ARCHETYPE_TVS` integrity (10 archetypes, all in [0, 1])
- `_grade` boundary tests at 90 / 80 / 70 / 60
- `_pick_intervention` policy per archetype (block, escalate, summarize, warn, allow)
- `compute_tas` end-to-end against every synthetic trace
- `TASResult` immutability, generator input, empty-input handling
- Internal helper boundedness (`_compute_cce`, `_compute_rda`, etc.)

### 3. Two timing tests rewritten with warm-up + median

`test_scan_ensemble_numpy_50_events_under_50ms` and
`test_scan_ensemble_numpy_100_events_under_150ms` were single-shot
timing assertions vulnerable to transient CPU contention. Brought
them into line with the other timing tests in the system: warm-up
pass + 10 samples + median.

### 4. Package documentation

Wrote `__init__.py` docstrings for every package:

- `supplementaries/__init__.py` — 84-line package overview with
  the full phase map.
- 10 phase package `__init__.py` files with phase-by-phase summaries.
- `supplementaries/README.md` — quickstart, phase table, determinism
  guarantee, fixture layout, contribution guide.

### 5. Dead scaffolding directories removed

10 empty directories with no `__init__.py` and no imports anywhere
were removed:

- `phase_1_telemetry/` (Phase 1 lives in `eden.observability.telemetry_collector`)
- 9 alternative-named duplicates (`loop_detection/`, `memory_multi_agent/`,
  `quality_stack/`, `reasoning/`, `stat_gate/`, `trajectory_guard/`,
  `benchmarks/`, `cost_opt/`, `trace_quality/`)

Verified nothing imports from these paths before removal.

## Final state

- **600 tests** across **13 packages** (10 phases + cross_phase + stress + cat_22_apm)
- **0 skipped**, **0 failed** across **10 consecutive runs** in ~23s each
- Online-by-default network behaviour preserved (the cache-first
  patch only short-circuits probes for files we already have on disk)

## Verification command

```bash
cd /Users/kaiavnihalani/Downloads/Eden
.venv/bin/pytest supplementaries/ -q
# Expected: 600 passed in ~23s
```
