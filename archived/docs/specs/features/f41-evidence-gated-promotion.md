# F41: Evidence-Gated Promotion Pipeline

| Field | Value |
|---|---|
| **Feature ID** | F41 |
| **Slug** | `evidence-gated-promotion` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **PARTIAL** |
| **Competitive source** | BentoLabs |
| **UI spec** | [U02 Artifacts](../ui/u02-artifacts.md) (promotion evidence panel) |
| **Closes gap** | 4.3, 5.1 |
| **Dependencies** | StatGate, F39 (nudges), F22/Cat23 (PRs), N01 (regression) |

---

## 1. Summary

Generalize Eden StatGate into **EvidenceGate** — unified promotion queue for nudges (F39), GitHub PRs (F22), guardrail changes, and prompt deploys. Nothing reaches 100% production traffic without statistical evidence of improvement and automatic demotion on regression.

Bento's shadow→promote lifecycle; Eden makes it **auditable and deterministic**.

---

## 2. Eden current state (codebase-accurate)

| Component | Path | Status |
|---|---|---|
| StatGate 5-check gate | `supplementaries/phase_6_stat_gate/gate.py` | **SHIPPED** |
| StatGate on closed-loop apply | `trace_quality/wiring.py:50–155` | **SHIPPED**, needs **N14** |
| `ClosedLoopExecutor.apply_approved` | `llmops/closed_loop_executor.py` | **PARTIAL** — v0 advisory |
| `promotion_candidates` table | — | **MISSING** (F41 greenfield) |
| `EvidenceGate` service | `src/eden/promotion/evidence_gate.py` | **MISSING** (F41 greenfield) |
| HookBus + PromotionHook | `promotion_hooks.py`, `hooks_bus.py` | **SHIPPED** |
| Eval→guardrail link | `eval_intel/integration.py` | **SHIPPED** — see **N15** |
| Nudge / PR / prompt promotion | F39, F22, N18 | **MISSING** wiring |

---

## 3. Promotion candidate types

```python
class PromotionKind(str, Enum):
    NUDGE = "nudge"
    PR_MERGE = "pr_merge"
    PROMPT_VERSION = "prompt_version"
    GUARDRAIL = "guardrail"
    MODEL_ROUTING = "model_routing"
```

---

## 4. Target behavior

```
Candidate enters queue (shadow mode or proposed)
    → EvidenceGate.evaluate(candidate, window=7d)
        → Metrics: stumble_rate, eval_pass_rate (N01/N03), cost, latency
        → StatGate: no new loop/contradiction regressions
    → Pass: promote + audit log (N06)
    → Fail: archive + alert
    → Regression post-promote: auto-demote within 1h (N03/N08)
```

---

## 5. Architecture

**`src/eden/promotion/evidence_gate.py`**

```python
@dataclass
class EvidenceReport:
    candidate_id: UUID
    passed: bool
    metrics: dict  # stumble_rate_delta, eval_pass_delta, p_value
    min_sample_size: int
    recommendation: Literal["promote","hold","reject","demote"]

class EvidenceGate:
    async def evaluate(self, candidate_id: UUID) -> EvidenceReport:
        baseline = await self._baseline_metrics(candidate)
        treatment = await self._treatment_metrics(candidate)
        return self._statgate_compare(baseline, treatment)
```

**Worker:** `PromotionWorker` — nightly + on-demand after experiment (F33)

---

## 6. Data model

```sql
CREATE TABLE promotion_candidates (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    kind TEXT NOT NULL,
    ref_id UUID NOT NULL,  -- nudge_id, pr_id, prompt_version_id
    status TEXT DEFAULT 'shadow'
        CHECK (status IN ('shadow','pending_review','promoted','rejected','demoted')),
    evidence JSONB NOT NULL DEFAULT '{}',
    shadow_started_at TIMESTAMPTZ,
    promoted_at TIMESTAMPTZ,
    demoted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_promotions_queue ON promotion_candidates (org_id, status, created_at DESC);
```

---

## 7. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{org_id}/promotions` | Queue inbox |
| `GET` | `/orgs/{org_id}/promotions/{id}` | Evidence report |
| `POST` | `/orgs/{org_id}/promotions/{id}/approve` | Manual override (admin) |
| `POST` | `/orgs/{org_id}/promotions/{id}/reject` | Reject with reason |

**Portal:** Promotions inbox — Kanban: Shadow | Pending | Promoted | Demoted

---

## 8. Evidence rules (defaults)

| Kind | Promote if | Min samples |
|---|---|---|
| Nudge | stumble_rate ↓ ≥5% rel, p<0.05 | 200 shadow traces |
| PR merge | N01 regression pass + stumble ↓ | 3 eval cases |
| Prompt version | N04 impact preview pass | 50 replays |
| Guardrail | false positive rate <2% | 500 traces |

Configurable per org in `promotion_policies` JSON.

---

## 9. Performance & cost optimization

### Latency budgets

| Operation | p95 |
|---|---|
| Evaluate candidate (cached metrics) | <2s |
| Full recompute (nightly) | <30s/candidate |
| Demotion trigger | <1h from regression detect |

### Cost model

- **$0 LLM** — uses aggregated metrics from F28, N03, N01
- **Compute:** SQL aggregations on indexed tables; pre-rolled MVs

### Caching

- Materialized view: `promotion_metrics_daily(agent_id, variant, date)`
- Redis: latest EvidenceReport per candidate (5min TTL)

### Degradation

- Insufficient sample → `hold`, extend shadow period
- Metrics pipeline lag → do not promote until fresh (<2h)

### Monitoring

```
eden_promotion_evaluated_total{kind,result}
eden_promotion_demoted_total{kind}
eden_promotion_manual_override_total
```

---

## 10. Feature flags

| Flag | Default |
|---|---|
| `evidence_gate_v1` | false |
| `auto_promote_nudges_v1` | false (manual approve until trusted) |

---

## 11. Acceptance criteria

- [ ] Shadow nudge with improved metrics auto-queued for promote
- [ ] Regression after promote triggers demote within 1h
- [ ] Manual approve requires admin + audit log (N06)
- [ ] F39 cannot promote without EvidenceGate pass when flag on
- [ ] Evaluate p95 <2s with cached metrics

---

*Mandatory gate for F39. See N01/N03/N04 for metric sources.*
