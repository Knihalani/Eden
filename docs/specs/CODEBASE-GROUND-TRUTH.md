# Eden Codebase Ground Truth (for Spec Authors)

> **Purpose:** Keep specs accurate — what is **shipped**, **partial**, **stub**, or **retired** in `/workspace/src/eden`.  
> **Last audit:** July 9, 2026

Use this doc when writing implementation steps. Specs MUST NOT assume modules exist without checking here.

---

## 1. Critical wiring gaps (fix before feature UX)

| Gap | Spec says | Reality | Fix spec |
|---|---|---|---|
| Trace quality worker | Running on ingest | `quality_pipeline/worker.py` **not started** in `app.py` lifespan | **N14** |
| StatGate wiring | Active | `trace_quality/wiring.py:install_all()` **not called** from lifespan | **N14** |
| `register_all_hooks()` | Registers hooks | `promotion_hooks.py:1667` — **no-op shim**, lazy singletons | **N14**, F46 |
| `src/eden/issues/` | F28/F29/F20 | **Directory does not exist** | F28–F30 (greenfield) |
| `src/eden/promotion/evidence_gate.py` | F41 | **Does not exist** | F41 (greenfield) |
| `src/eden/closed_loop/orchestrator.py` | F46 | **Does not exist** | F46 (greenfield) |
| Runtime nudges in gateway | F39 | `AIGateway.complete()` has **filters only**, no nudge engine | F39 → `GatewayFilter` |
| LangGraph env-gen pipeline | N07 Part VIII | **RETIRED** (`pyproject.toml`, `enable_eval_pipeline=false`) | N07 v2 |
| `trace_quality_*` settings | Config | In `prompts/06_settings.md` only, **not in `config.py`** | N14 |

---

## 2. Shipped assets to leverage (do NOT rebuild)

### Trace quality / StatGate / ETEC

| Asset | Path |
|---|---|
| 5-step quality sidecar | `src/eden/observability/quality_pipeline/worker.py` |
| Hot-path guardrails (8 checks) | `src/eden/observability/trace_quality/hooks.py` |
| StatGate 5-check gate | `supplementaries/phase_6_stat_gate/gate.py` |
| StatGate-gated executor | `supplementaries/phase_7_detection/stat_gated_executor.py` |
| Cat 15/17/22 wiring shim | `src/eden/observability/trace_quality/wiring.py` |
| Trace quality API | `src/eden/api/routes/trace_quality.py` (mounted `app.py:705`) |
| ETEC composite | `supplementaries/phase_2_efficiency/composite.py` |

### Gateway & cost

| Asset | Path |
|---|---|
| **Only extension point:** `GatewayFilter` | `src/eden/llmops/filters/base.py:18–41` |
| Filter pipeline in gateway | `src/eden/llmops/ai_gateway.py:593–629` |
| Exact + semantic cache, budgets | `ai_gateway.py:598–616` |
| zstd JSONB compression (~15×) | `src/eden/storage/compression.py` |
| Optimization layer | `src/eden/optimization/` |
| Budget service | `src/eden/services/budget_service.py` |
| OTel tail sampling config | `deploy/otel-collector-config.yaml` |
| Loop trace keep-rate hook | `wiring.py:23–27` (`detector_keep_rate_loop`) |

### Closed loop & improvement

| Asset | Path |
|---|---|
| HookBus + 20+ hook kinds | `src/eden/llmops/promotion_hooks.py`, `hooks_bus.py` |
| Closed-loop executor (v0 advisory) | `src/eden/llmops/closed_loop_executor.py` |
| Closed-loop portal API | `src/eden/api/routes/intelligence_closed_loop.py` |
| Insights → KB loop (running) | `src/eden/insights/detector_loop.py` (started `app.py:296–308`) |
| Judge prompt evolver + canary | `src/eden/agents/evolution/components.py` |
| Promotion loop | `src/eden/llmops/promotion.py` |
| Eval→guardrail link | `src/eden/evaluation/eval_intel/integration.py` (`EvalToGuardrailLink`) |
| Auto dataset from failures | `AutoDatasetBridge` same file |
| Investigation agent | `src/eden/autonomous/investigation.py` |
| Code change + Cat 23 hook | `src/eden/code_change/`, `CodeChangeHook` |

### KB & env gen fragments

| Asset | Path |
|---|---|
| Procedural skills (Skill Library) | `src/eden/kb/procedural/client.py` |
| Part VIII agent prompt seeds | `src/eden/kb/prompt_versions/seed.py` |
| Multi-agent frameworks lib | `src/eden/multi_agent/` |
| Pattern → env job insert (no worker) | `src/eden/api/routes/patterns.py:126–175` |
| Marketplace | `src/eden/marketplace/`, gated by `enable_eval_pipeline` |
| A2A delegation links | `src/eden/services/observability/a2a_links.py` |
| Cat 6 fleet / handoff graph | `src/eden/agents/agent_intel/performance.py` |

### MCP & debugger

| Asset | Path |
|---|---|
| MCP ingest | `src/eden/api/routes/observability_mcp.py`, `sdk/mcp.py` |
| Hermetic debugger | `src/eden/debugger/checkpoints.py` |
| Checkpoint rewind | `src/eden/observability/checkpoint/rewind.py` |
| Compliance evidence | `src/eden/compliance/evidence_generator.py` |

---

## 3. App lifespan (`src/eden/api/app.py`) — what actually starts

| Started | Line (approx) |
|---|---|
| KB init | 268–273 |
| Insights detector loop | 296–308 |
| `register_all_hooks()` (no-op log) | 311–318 |
| Trace quality shutdown only | 377–382 (teardown) |

**NOT started:** `install_all()`, quality pipeline worker, judge Redis tailer (verify per deploy).

---

## 4. Spec accuracy rules

1. **Greenfield modules** — mark as MISSING; list exact path to create
2. **Wire before build** — N14 before F20/F28 if ETEC data needed live
3. **Gateway changes** — implement as `GatewayFilter`, not monkey-patch `complete()`
4. **Env gen** — use `multi_agent/` + patterns job + marketplace; do not reference removed LangGraph runner
5. **Cost claims** — cite `storage/compression.py` (15× zstd) + N09 dedupe + N16 sampling

---

*Update this file when wiring gaps close.*
