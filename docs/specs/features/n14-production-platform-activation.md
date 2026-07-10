# N14: Production Platform Activation (Wiring Wave)

| Field | Value |
|---|---|
| **Feature ID** | N14 |
| **Slug** | `production-platform-activation` |
| **Priority** | **P0 — BLOCKER** |
| **Effort** | M |
| **Eden status** | **PARTIAL** — deepest backends exist, not connected at runtime |
| **Market hypothesis** | Eden loses credibility if StatGate/ETEC/closed-loop code exists but never runs in prod |
| **Dependencies** | None — unlocks F20, N08, F39, F41, F46 |

---

## 1. Problem

Codebase audit (July 2026) found **625+ trace-quality tests** and shipped supplementaries, but:

- `trace_quality/wiring.py:install_all()` **not called** from `app.py` lifespan (docstring at L4–6 says it should be)
- Quality pipeline worker **not started**
- `register_all_hooks()` at `promotion_hooks.py:1667` is a **no-op shim**
- `trace_quality_*` settings exist in docs, **not in `config.py`**

Users cannot benefit from Eden's differentiation until this ships. **This is not a feature — it is activating existing IP.**

---

## 2. Target behavior

On API pod startup (`app.py` lifespan):

```python
# After KB init, before yield:

from eden.observability.trace_quality.wiring import install_all
install_all()  # Cat 15/17/22 + StatGate on closed-loop apply

from eden.observability.quality_pipeline.worker import start_quality_worker
await start_quality_worker(settings)

# Optional: judge tailer if not already started
from eden.llmops.judges.redis_tailer import start_judge_tailer
await start_judge_tailer(settings)
```

Add to `src/eden/config.py`:

```python
trace_quality_enabled: bool = True
trace_quality_worker_enabled: bool = True
trace_quality_hot_path_enabled: bool = True
detector_keep_rate_loop: float = 1.0  # Cat 22 — never drop loop traces
insights_loop_enabled: bool = True  # already used
```

---

## 3. Wiring checklist (file-by-file)

| # | Task | File | Acceptance |
|---|---|---|---|
| 1 | Call `install_all()` | `src/eden/api/app.py` lifespan | Log: "wiring: Cat 15/17/22 installed" |
| 2 | Start quality worker | `quality_pipeline/worker.py` | `trace.finalized` → 5-step sidecar runs |
| 3 | Merge settings | `src/eden/config.py` | All `trace_quality_*` from `prompts/06_settings.md` |
| 4 | Health endpoint | `routes/health.py` or trace_quality | `quality_worker_running: true` |
| 5 | Real hook registration | `promotion_hooks.py` OR document lazy model | Hooks fire integration test |
| 6 | Teardown | `app.py` shutdown | Worker drains gracefully (partial today) |

Reference: [`CODEBASE-GROUND-TRUTH.md`](../CODEBASE-GROUND-TRUTH.md) §1

---

## 4. What unlocks (downstream)

| After N14 | Feature enabled |
|---|---|
| ETEC reports live | F20 `loop_detected` detector |
| StatGate on apply | F41 EvidenceGate foundation |
| Loop traces always sampled | N16 cost architecture |
| Hot-path guardrails | F39 safety, gateway trajectory check |
| Drift → closed-loop actions | F46 orchestrator input events |

---

## 5. Performance & cost optimization

| Concern | Mitigation |
|---|---|
| Worker CPU | Async sidecar; 5 steps batched; skip traces <3 spans |
| Hot-path latency | Guardrails in `hooks.py` target <5ms p99 (spec) |
| Memory | Worker pool bounded; backpressure on Redis stream lag |
| Cost | **$0** — deterministic processing; no new LLM |

**Rollout:** Feature flag `platform_activation_v1` per org; canary one pod before fleet.

### Monitoring

```
eden_quality_worker_running (gauge)
eden_wiring_install_success (gauge)
eden_quality_worker_lag_seconds
eden_hot_path_guardrail_duration_seconds
```

---

## 6. Acceptance criteria

- [ ] `install_all()` called once per process; idempotent on restart
- [ ] Quality worker processes synthetic trace within 60s
- [ ] `GET /traces/{id}/quality` returns ETEC data for processed trace
- [ ] StatGate wraps `ClosedLoopExecutor.apply_approved` (integration test)
- [ ] Health check fails if worker dead when `trace_quality_worker_enabled=true`
- [ ] No p99 ingest regression >5ms (benchmark 1k spans)

---

## 7. Stand-out narrative

> "Eden ships deterministic trace quality that actually runs — not shelfware."

Competitors add LLM judges; Eden activates **ETEC + StatGate + closed-loop gating** already built.

---

*Ship before Wave 1 issue loop. See N08, F20, F41.*
