# Deterministic Trace Evaluation System

The `supplementaries/` package is Eden's self-contained, deterministic
trace quality pipeline. It implements an 11-phase evaluation stack that
runs without any external LLM call and finishes its full synthetic
test suite in ~20 seconds.

## Quickstart

```bash
# Run the full pipeline (~20 s):
.venv/bin/pytest supplementaries/ -q

# Just one phase:
.venv/bin/pytest supplementaries/phase_3_loops/ -q

# Cross-phase integration:
.venv/bin/pytest supplementaries/cross_phase/ -q

# Adversarial + stress:
.venv/bin/pytest supplementaries/stress_tests/ -q
```

Current state: **600 tests, 0 skipped, 0 failed** (verified across
three consecutive runs).

## Phase map

| # | Package | What it does |
|---|---|---|
| 1 | *(see `eden.observability.telemetry_collector`)* | `TelemetryEvent` source of truth |
| 2 | `phase_2_efficiency/` | TAS composite + SRR / LDI / TCA / CCE / RDA / ISR / OBS / LHP / VHP / CCR |
| 3 | `phase_3_loops/` | 4-detector loop ensemble + vectorised numpy path + real-embeddings path |
| 4 | `phase_4_guardrails/` | 8 hot-path checks + 4 async advisory + policy_extension §12.6 |
| 5 | `phase_5_quality/` | HHEM-2.1 / MiniCheck / BGE / numeric-guard pipeline |
| 6 | `phase_6_stat_gate/` | Welch's t-test + mSPRT + ECE + split-conformal |
| 7 | `phase_7_detection/` | Detector fan-out + closed-loop action collector |
| 8 | `phase_8_cost/` | Multi-tier cache + LLMLingua compression + Automix |
| 9 | `phase_9_reasoning/` | Composite reasoning-quality scorer |
| 10 | `phase_10_memory/` | A2A parser + swarm topology + memory-pressure detectors |
| 11 | `phase_11_benchmark/` | 8-category benchmark suite + aggregate |

## Cross-cutting

- `cross_phase/test_cross_phase_integration.py` — runs every phase on
  the synthetic 30-trace dataset and asserts end-to-end behaviour.
- `stress_tests/test_stress.py` — adversarial-clean / adversarial-noisy
  generators + latency budgets at 50 / 100 / 500 events.
- `cat_22_apm/` — APM tail-sampling policy (real and used by `eden.observability`).
- `research/` — 12 deep-research documents backing every spec decision.

## Determinism guarantee

The local HuggingFace cache is treated as authoritative for the
models we ship; network is only consulted when the cache has no
information. The cache-first patch lives in
[`supplementaries/conftest.py`](conftest.py) and only short-circuits
probes for files we already have on disk.

This means:

- ✅ Models load from disk on every run (no 30-second cold start).
- ✅ A flaky network never produces flaky tests.
- ✅ Online behaviour is preserved everywhere else in Eden.

## Test fixtures

The synthetic 30-trace dataset lives at
[`tests/fixtures/traces/synthetic/`](../tests/fixtures/traces/synthetic/).
Three traces per archetype across 10 archetypes:

```
efficient-good, redundant-repeated-context, loop-stuck,
hallucinating, slow-cost-overrun, failing-tool,
optimal-path-exists, efficient-multi-agent-handoff,
output-truncation, adversarial-paraphrase-loop
```

Each trace has a paired ground-truth JSON containing the expected
`expected_TAS`, `expected_intervention`, `expected_loop_detected`,
and `expected_hallucination_detected` values.

## Adding tests

When you add a new phase module:

1. Add a `phase_<n>_<name>/__init__.py` with a docstring that
   summarises the phase (see existing phases for the format).
2. Add unit tests as `phase_<n>_<name>/test_<module>.py` — one file
   per module so failures point at the right place.
3. If the module exports public functions, exercise each one
   directly (not just via the cross-phase integration test).
4. The pytest collector picks them up automatically — no `pyproject.toml`
   edits needed.
