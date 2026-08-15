# N14: Production Platform Activation (Wiring Wave)

| Field | Value |
|---|---|
| **Feature ID** | N14 |
| **Slug** | `production-platform-activation` |
| **Priority** | **P0 — BLOCKER** |
| **Effort** | M |
| **Eden status** | **SHIPPED (GA-ready)** — quality sidecar (Postgres watermark), F20 consumer (`trace.finalized` Redis), closed_loop lifespan, `install_all` in API lifespan (all pods), leader-gated workers |
| **Market hypothesis** | Eden loses credibility if StatGate/ETEC/closed-loop code exists but never runs in prod |
| **Dependencies** | None — unlocks F20, N08, F39, F41, F46 |

---

## 1. Problem

Codebase audit (July 2026) found **625+ trace-quality tests** and shipped supplementaries. **Phase 0 (July 16 2026) closed the wiring gaps:**

- `install_all()` runs idempotently in **every API pod** lifespan (`app.py`)
- Quality sidecar worker + F20 `trace.finalized` consumer remain **leader-gated** (`workers/background.py`)
- `register_all_hooks()` bridges F46 orchestrator; demote hook calls `EvalToGuardrailLink.demote`
- `trace_quality_*` settings live in `config.py`
- `/health` exposes `statgate_installed`, `quality_worker_running`, `evolution_loop_running`
- N14 §5 Prometheus gauges on `/metrics`

**Architecture (locked):** Quality reports use a **Postgres watermark sidecar** (durable within 60s of `span.end`). F20 auto-issue detection uses a **separate `trace.finalized` Redis consumer**. Do **not** merge into a single bus.

---

## 2. Target behavior

On API pod startup (`app.py` lifespan):

```python
# After KB init, on every pod (idempotent):
from eden.observability.trace_quality.wiring import install_all
install_all()  # Cat 15/17/22 + StatGate on closed-loop apply

# Leader-gated singleton workers (background.py):
from eden.workers.background import start_background_workers
await start_background_workers(settings)
# → quality sidecar, F20 trace.finalized consumer, evolution loop, hooks
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
| 1 | Call `install_all()` | `src/eden/api/app.py` lifespan | Every pod; log: "wiring: Cat 15/17/22 installed" |
| 2 | Start quality worker | `quality_pipeline/worker.py` via `background.py` | Leader only; Postgres watermark → 5-step sidecar |
| 3 | Merge settings | `src/eden/config.py` | All `trace_quality_*` from `prompts/06_settings.md` |
| 4 | Health endpoint | `app.py` `/health` | `quality_worker_running`, `statgate_installed`, `evolution_loop_running` |
| 5 | Hook registration | `promotion_hooks.py` | Promote + demote (`EvalToGuardrailLink`); integration tests green |
| 6 | Teardown | `background.py` stop timeout ≥ 30s | Worker drains gracefully |

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

- [x] `install_all()` called once per process on every API pod; idempotent on restart
- [x] Quality worker processes traces via Postgres watermark (leader pod); reports durable within 60s of `span.end`
- [x] F20 `trace.finalized` consumer separate (Redis); ETEC bridge via `etec_loop_score` span attrs → `AutoIssueScanner._detect_loops`
- [x] `GET /traces/{id}/quality` returns ETEC data for processed trace
- [x] StatGate wraps `ClosedLoopExecutor.apply_approved` (integration test)
- [x] Health check degrades if worker dead when `trace_quality_worker_enabled=true` on leader
- [x] Demote hook disables guardrail via `EvalToGuardrailLink.demote` (not record-only)
- [x] No p99 ingest regression >5ms (benchmark 1k spans — `tests/api/test_hot_path_p99_regression.py`)

---

## 7. Stand-out narrative

> "Eden ships deterministic trace quality that actually runs — not shelfware."

Competitors add LLM judges; Eden activates **ETEC + StatGate + closed-loop gating** already built.

---

*Ship before Wave 1 issue loop. See N08, F20, F41.*
