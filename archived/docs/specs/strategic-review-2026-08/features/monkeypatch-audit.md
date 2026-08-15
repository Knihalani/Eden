# Hot-path monkey-patch audit (FEAT-164)

Date: 2026-08-06
Scope: `src/eden/` production code — `setattr(`, class/method rebinding,
`wrapt`, `unittest.mock` in non-test modules, InterventionEngine /
OpenAI client wraps, and related "install_*" wirings.

**Verdict:** No remaining **risky silent override** of the FEAT-3
`install_cat15_trajectory_replaces_intervention` class. Remaining
runtime patches are either intentional safety gates, feature
extensions, logging bookkeeping, or test-injection seams.

## Classification legend

| Class | Meaning |
|---|---|
| **safe / instrumentation** | Observable, additive, or fail-open logging; does not replace a safety check with a weaker one |
| **intentional extension** | Documented feature wiring that expands behaviour; review on change |
| **risky-silent-override** | Rebinds a fail-closed / safety path without obvious caller awareness |
| **test-only / seam** | Exists so tests can monkeypatch; no production side-effect by itself |
| **retired** | Removed; kept in comments / detectors only |

## Findings

### Retired

| Location | Pattern | Notes |
|---|---|---|
| `observability/trace_quality/wiring.py` (historical) | `InterventionEngine.evaluate_and_act = …` | **`install_cat15_trajectory_replaces_intervention` removed (FEAT-3/FEAT-4).** Docstring on `install_all` + FEAT-33 identity check (`is_evaluate_and_act_patched`) remain as defense-in-depth. |
| `guardrails/intervention.py:806–880` | Identity snapshot + `record_guardrail_bypass_if_detected` | Detects reintroduction of the trajectory swap (`feature=trajectory_guardrail`). **safe / instrumentation**. |

### Intentional runtime wirings (`install_all`)

| Location | Pattern | Class | Notes |
|---|---|---|---|
| `observability/trace_quality/wiring.py:38` → `supplementaries/.../policy_extension.apply_extension` | Mutates `eden.guardrails.policy.VALID_ACTIONS` / `ACTION_RANK` (5→14) | **intentional extension** | Global process mutation, idempotent. Expands allowed actions; does **not** skip policy evaluation. Watch for new high-blast actions. |
| `wiring.py:50–154` `install_cat17_stat_gate_gating` | `ClosedLoopExecutor.apply_approved = _wrapped` | **safe / instrumentation** (safety *tightening*) | Wrapper runs StatGate before apply; falls through to original when evidence missing. Opposite of FEAT-3 (adds a gate rather than removing one). Logged on install. |
| `wiring.py:157–225` `install_cat17_closed_loop_collection` | `hook.on_drift_alert = _listener` | **safe / instrumentation** | Calls upstream listener first, then collects ClosedLoopAction rows on high/critical drift. |
| `wiring.py:228+` `install_cat22_sampling_policy` | Mutates `DEFAULT_KEEP_RATES` dict in place | **intentional extension** | Sampling rates from Settings; no method swap. |

### `setattr` in production (non-wiring)

| Location | Pattern | Class | Notes |
|---|---|---|---|
| `observability/logging_shim.py:519,558,576` | `setattr(root, _INSTALLED_ATTR, …)` | **safe / instrumentation** | Idempotency flag on the logging root logger. |
| `decision/_common.py:359–361`, `apm_depth/step_judges.py:73–75`, `llmops/judges/redis_tailer.py:243`, `api/routes/judges.py:180` | `setattr(ev, field, value)` | **safe / instrumentation** | Hydrating event dataclasses/slots from dict rows — not monkey-patching callables. |

### Test seams / comments only (no prod mock)

| Location | Pattern | Class | Notes |
|---|---|---|---|
| `llm/client.py` | Comments about `unittest.mock` + `__getattr__` | **test-only / seam** | Keeps OpenAI lazy import mockable; does not mock in prod. |
| `api/utils/clerk_client.py` | Docstring mentions `unittest.mock.patch` | **test-only / seam** | Guidance for tests. |
| `improvement/replay_verify.py`, `improvement/test_gate.py`, `metric_studio/synthesiser.py`, `columnar/compaction.py`, `exports/*`, `storage/postgres.py`, route `noqa: F401` re-exports | Module-level indirection / imports | **test-only / seam** | Designed for pytest monkeypatch; production uses real impls. |
| `api/routes/gateway.py`, `billing.py`, `analytics.py`, `optimization.py`, `feature_flags.py`, `deps.py`, `clerk_webhooks.py` | Comments / re-exports for monkeypatch | **test-only / seam** | |

### Not found under `src/eden/`

* No `wrapt` usage.
* No `unittest.mock` imports in production modules (only comments).
* No live rebinding of `InterventionEngine.evaluate_and_act`.
* No OpenAI client class swap outside test seams.

## Actions taken (2026-08-06)

1. Repo-wide grep completed (patterns above).
2. This audit filed under strategic-review features.
3. **No additional risky silent override found** that required a code
   fix analogous to FEAT-3. Cat 17 StatGate wrap stays — it is a
   deliberate tighten.
4. Optional follow-up (not blocking): add an `install_all` metric
   listing which of the four wirings rebound callables (already
   partially covered by the structured `installed=[...]` log line).

## Review checklist for future patches

Before merging any `Class.method = wrapper` under `src/eden/`:

1. Does it replace a fail-closed safety path with a weaker check?
2. Is the install logged + idempotent?
3. Is there an identity / marker detector if the swap is safety-critical?
4. Prefer explicit call-site wiring over class rebinding when practical.
