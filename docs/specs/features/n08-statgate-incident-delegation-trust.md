# N08: StatGate-Powered Incident Response & Delegation Trust

| Field | Value |
|---|---|
| **Feature ID** | N08 |
| **Slug** | `statgate-incident-delegation-trust` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **PARTIAL** (StatGate in trace quality; not incident-integrated) |
| **Market hypothesis** | Multi-agent systems need **non-LLM trust signals** — buyers skeptical of pure LLM-judge for incident severity |
| **Dependencies** | ETEC/StatGate, F28, F29, F30, Cat 22 delegation |

---

## 1. Problem

Incident triage (F30) and issue severity (F29) today lean on LLM analysis. Enterprise SRE teams want **deterministic, auditable signals**:
- ETEC loop detection → P1 automatically
- StatGate contradiction → escalate
- Delegation chain break → "sub-agent untrusted"

Eden **already has** StatGate + ETEC — uniquely among competitors. N08 **operationalizes** them for incident response.

---

## 2. Eden current state (codebase-accurate)

| Component | Path | Status |
|---|---|---|
| StatGate 5-check gate | `supplementaries/phase_6_stat_gate/gate.py` | **SHIPPED** |
| StatGate-gated executor | `supplementaries/phase_7_detection/stat_gated_executor.py` | **SHIPPED** |
| Cat 17 StatGate on apply | `trace_quality/wiring.py:50–155` | **SHIPPED**, requires **N14** `install_all()` |
| Hot-path loop guard | `trace_quality/hooks.py:164–200` | **SHIPPED** |
| ETEC composite | `supplementaries/phase_2_efficiency/composite.py` | **SHIPPED** |
| Quality worker | `quality_pipeline/worker.py` | **NOT started** in lifespan |
| A2A links | `services/observability/a2a_links.py` | **SHIPPED** |
| Cat 6 handoff analyzer | `agents/agent_intel/performance.py` | **SHIPPED** |
| `StatGateIncidentScorer` | `src/eden/issues/statgate_scorer.py` | **MISSING** (new) |
| F28/F29 issue layer | `src/eden/issues/` | **MISSING** (new) |

See [`CODEBASE-GROUND-TRUTH.md`](../CODEBASE-GROUND-TRUTH.md).

---

## 3. Target behavior

### 3.1 StatGate Incident Scorer

On F28 stumble write, run StatGate suite **before** LLM triage:

```python
@dataclass
class StatGateVerdict:
    checks: list[CheckResult]  # loop, contradiction, token_spike, tool_churn
    composite_severity: Literal["p0","p1","p2","p3"]
    auto_escalate: bool
    evidence: dict  # spans, metrics — no LLM
```

| Check | P0 trigger |
|---|---|
| ETEC loop | ≥4 identical tool calls in 10 steps |
| Contradiction | Assistant asserts X, tool proves ¬X |
| Delegation break | Sub-agent error propagates uncaught |
| Cost spike | Trace cost >3σ for agent |

### 3.2 Delegation trust graph

For multi-agent traces (Cat 22):
- Map parent → child agent calls
- Score **delegation trust**: did sub-agent follow constraints?
- Surface in N05 fleet dashboard + F30 triage context

```sql
CREATE TABLE delegation_trust_scores (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    parent_trace_id UUID NOT NULL,
    parent_agent_id TEXT,
    child_agent_id TEXT,
    trust_score FLOAT,  -- 0-1, StatGate-derived
    failure_mode TEXT,
    recorded_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.3 Incident response playbook

StatGate P0 → skip LLM triage queue → immediate:
1. F47 Slack alert with evidence blocks (not LLM summary)
2. Optional PagerDuty webhook
3. Auto-create F29 issue with `detected_by=statgate`
4. F30 triage receives StatGate evidence as **ground truth** context

---

## 4. Why non-LLM matters (market)

- **Latency:** StatGate runs in <100ms; LLM triage 30-90s
- **Cost:** No tokens for severity classification
- **Audit:** Deterministic rules for regulators (N06 synergy)
- **Trust:** SRE teams dismiss "AI said it's fine"

Braintrust/Langfuse focus LLM eval; **deterministic trace quality** is Eden differentiation.

---

## 5. F30 triage integration

```python
async def triage_issue(issue_id: str) -> TriageResult:
    issue = await get_issue(issue_id)
    statgate = await statgate_scorer.score_issue(issue)

    if statgate.composite_severity == "p0":
        return TriageResult(
            root_cause=statgate.evidence["primary_check"].description,
            confidence=1.0,
            source="statgate",
            llm_skipped=True,
        )

    # LLM triage for p1-p3 with statgate evidence injected
    return await llm_triage_agent.run(issue, statgate_context=statgate)
```

---

## 6. Performance & cost optimization

| Path | Latency | Cost |
|---|---|---|
| StatGate score (deterministic) | p95 <80ms | **$0** |
| ETEC read from quality report | p95 <50ms | **$0** |
| Delegation trust (A2A + Cat 6) | p95 <200ms async | **$0** |
| LLM triage skipped on P0 | saves 30–90s | saves $0.03–0.08/issue |

**Implementation:** Wrap `supplementaries/phase_6_stat_gate/gate.py` — do not reimplement checks.

### Monitoring

```
eden_statgate_incident_score_duration_seconds
eden_statgate_p0_escalation_total
eden_triage_llm_skipped_total{reason=statgate}
```

---

## 7. MCP exposure (F04)

`get_statgate_verdict(trace_id)` — coding agent sees deterministic quality report before LLM speculation.

---

## 8. Acceptance criteria

- [ ] ETEC loop trace → P0 stumble + issue without LLM call
- [ ] StatGate evidence attached to all F30 triage results
- [ ] Delegation trust score computed for multi-agent traces
- [ ] P0 StatGate → F47 alert within 60s
- [ ] Audit ledger (N06) records StatGate escalation events

---

*Eden unique: ETEC + StatGate as incident backbone. See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.8.*
