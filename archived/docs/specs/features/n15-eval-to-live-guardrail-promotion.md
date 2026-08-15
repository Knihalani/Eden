# N15: Eval-to-Live-Guardrail Promotion

| Field | Value |
|---|---|
| **Feature ID** | N15 |
| **Slug** | `eval-to-live-guardrail-promotion` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **PARTIAL** — `EvalToGuardrailLink` shipped; not connected to gateway |
| **Market hypothesis** | Galileo-style "evals become guardrails" — buyers want production improvement, not dashboards |
| **Dependencies** | N14, Cat 3 evals, `GatewayFilter`, F41 |

---

## 1. Problem

Eden ships `EvalToGuardrailLink` in `src/eden/evaluation/eval_intel/integration.py`:

- Promotes judge to `guardrail_policies` when ≥100 samples, FPR ≤5%
- Fires `GuardrailHook.on_judge_threshold_breach`

But guardrails today run on **`POST /v1/guardrails/trajectory/check`** — **not inside live agent gateway calls**. Production agents do not benefit until judges become **`GatewayFilter`** instances.

**This is Eden's unique improve-in-production loop:** eval failure → judge → guardrail policy → live request filter.

---

## 2. Eden current state (exact)

| Component | Path | Status |
|---|---|---|
| `EvalToGuardrailLink` | `eval_intel/integration.py` L5–14 | **SHIPPED** |
| `GuardrailHook` | `promotion_hooks.py` | **SHIPPED** |
| Trajectory check API | `trace_quality.py:333–378` | **SHIPPED** — parallel path |
| Gateway filter registry | `llmops/filters/base.py:18–41` | **SHIPPED** — extension point |
| `AIGateway.register_filter` | `ai_gateway.py:459–499` | **SHIPPED** |
| Live judge-as-filter | — | **MISSING** |

---

## 3. Target behavior

```
Production trace fails judge "hallucination"
    → AutoDatasetBridge adds to eval set (existing)
    → Operator: "Promote to live guardrail"
    → EvalToGuardrailLink.promote_to_guardrail(judge_id)
    → Creates guardrail_policies row type=judge_link
    → GuardrailFilterFactory loads policy
    → AIGateway.register_filter(JudgeGuardrailFilter)
    → Next live completion: filter runs judge logic pre/post
    → Block or warn on breach; stumble + F47 alert
    → F41 EvidenceGate required to increase enforcement level
```

---

## 4. Architecture

```python
# src/eden/llmops/filters/judge_guardrail.py

class JudgeGuardrailFilter:
    name = "judge_guardrail"

    def enabled(self, request: ModelRequest) -> bool:
        return request.org_id in self._loaded_policies

    def apply(self, request: ModelRequest) -> tuple[ModelRequest, list[str]]:
        verdict = self._run_judge_sync(request)  # SLM or rules cache
        if verdict.block:
            raise GuardrailBlocked(verdict)
        return request, [verdict.summary]
```

**Loader:** On `promote_to_guardrail`, hot-reload filter registry for org (or poll Redis pub/sub).

**Module paths:**
- `src/eden/llmops/filters/judge_guardrail.py` (new)
- Wire `EvalToGuardrailLink` callback → `FilterRegistry.register`
- Portal: judge detail → "Promote to live guardrail" button

---

## 5. Enforcement levels

| Level | Behavior | Promotion gate |
|---|---|---|
| `log` | Record breach, allow request | Auto after FPR check |
| `warn` | Append system warning to response | F41 shadow 7d |
| `block` | Reject before provider call | F41 + admin approve |

---

## 6. Performance & cost optimization

| Mode | Latency | Cost |
|---|---|---|
| Rule cache hit (deterministic judge) | <2ms | $0 |
| SLM judge on gateway | <200ms p95 | ~$0.001/request |
| Full judge | **Not on hot path** — async only |

**Controls:**
- Max 3 live guardrail filters/org on hot path
- Cache judge verdict 30s per `(org, prompt_hash)`
- Sample enforcement: 100% for `block`, 10% for `log` mode

**Client experience:** Block returns OpenAI-compatible error with `eden.guardrail` extension — agent can retry.

### Monitoring

```
eden_guardrail_filter_duration_seconds
eden_guardrail_block_total{judge_id}
eden_guardrail_promotion_total
```

---

## 7. MCP / Portal

- **Portal:** Evals → Judge → Promote to guardrail
- **MCP (F04):** `promote_judge_to_guardrail(judge_id)`, `list_live_guardrails(agent_id)`

---

## 8. Acceptance criteria

- [ ] Promoted judge blocks fixture hallucination on gateway `complete()`
- [ ] EvalToGuardrailLink FPR gate enforced (reject if >5%)
- [ ] Filter hot-reloads without pod restart
- [ ] Deterministic judge: p95 <5ms gateway overhead
- [ ] Demotion removes filter within 60s

---

## 9. Stand-out narrative

> "Your evals don't just score traces — they **protect** the next million requests."

No competitor combines Cat 3 eval depth + gateway chokepoint + StatGate promotion (F41).

---

*See `eval_intel/integration.py`, `filters/base.py`. Depends on N14.*
