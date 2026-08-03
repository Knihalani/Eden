# N21: Autonomous Runtime Remediation (Self-Heal)

| Field | Value |
|---|---|
| **Feature ID** | N21 |
| **Slug** | `autonomous-self-heal-remediation` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **SHIPPED behind flag** — execute path live (`SelfHealer.heal_from_issue` → `execute_heal`, `src/eden/autonomous/investigation.py`); heals fire only when the org opts in via an `autonomy_policies` row (`auto_runtime_heal=true` — the config default `autonomous_actions_v0=False` denies them) |
| **Role in autonomous maintenance** | Eden **fixes production outages and quality drops at runtime** — rollback bad deploys, bust poisoned caches, reweight routing — without waiting for a human |
| **Dependencies** | N22, F29, F30, N08, F42, `autonomous/investigation.py`, F41, F46 |

---

## 1. Problem

When a production agent has an **outage or service quality cliff**, the fix is often **runtime configuration**, not code:

| Incident | Fix | Human today |
|---|---|---|
| Bad prompt deploy 14:02 | Rollback to last good version | Manual portal |
| Semantic cache poisoned | Cache bust org+agent | Manual ops |
| Model routing to degraded endpoint | Reweight traffic away | Manual gateway config |

Cat 14 `SelfHealer` (`investigation.py:419`) knows these three actions but **only queues** — never executes. F46 cannot complete the autonomous maintenance loop until N21 runs heals and verifies recovery (N03/N08).

---

## 2. Eden current state (exact)

| Component | Path | Status |
|---|---|---|
| `SelfHealer.heal()` | `autonomous/investigation.py:439` | **SHIPPED** — queue only |
| `VALID_HEAL_ACTION_TYPES` | `autonomous/_common.py:63–65` | rollback, reweight, cache_bust |
| API route | `intelligence_autonomous.py` | **SHIPPED** — gated `autonomous_actions_v0` + admin |
| `_capture_before_state` | `_common.py` | **SHIPPED** — audit |
| Execute worker | — | **MISSING** |
| Issue-linked heal | — | **MISSING** |

**Flags:**
- `intelligence_gap_v0` — umbrella Cat 14
- `autonomous_actions_v0` — destructive (`config.py:157`)

---

## 3. Remediation playbooks (maps to AUTONOMOUS-MAINTENANCE §3)

F30 diagnosis → F46 selects heal automatically when N22 allows:

| Root cause (F30) | Heal action | Playbook |
|---|---|---|
| `deploy_regression` — loop spike after prompt deploy | `rollback` | §3.1 |
| `cache_poison` — stale/wrong cached responses | `cache_bust` | §3.5 |
| `routing_drift` — degraded model receiving traffic | `reweight` | §3.7 |
| StatGate P0 + `detected_after_deploy` | `rollback` + F47 alert | §3.1, §3.3 |
| N18 canary failure | `rollback` canary variant | prompt evolution safety |

### Autonomous execution flow (default for runtime heals)

```
N08 P0 OR N03 quality_drop OR F42 deploy_correlation
    → F29 issue + F30 RCA
    → F46: classify → SelfHealer.heal(action_type)
    → N22: allow runtime heal? (default YES for enterprise non-HIPAA)
    → HealExecutor runs (p95 <2s, $0)
    → Verify: N03 pass rate + N08 clear within 30min
    → Success → issue resolved, N06 audit, N17 "Resolved"
    → Fail → escalate human + F47; optional second playbook
```

**Enterprise default:** runtime heals (rollback/cache/reweight) execute **without per-incident approval**. Code patches (N20) still need merge approval unless sandbox.

---

## 4. Architecture

```python
# src/eden/autonomous/heal_executor.py

class HealExecutor:
    async def execute(self, action_id: str) -> HealResult:
        action = await self._repo.get(action_id)
        await statgate.pre_check(action)  # N08
        match action.action_type:
            case "rollback":
                await prompt_versions.activate_previous(action.org_id, action.agent_id)
            case "reweight":
                await gateway_models.adjust_weights(action.payload)
            case "cache_bust":
                await semantic_cache.invalidate_prefix(action.org_id, action.agent_id)
        await self._repo.mark_executed(action_id, after_state=...)
        await audit_ledger.write(N06)
```

**New routes:**
- `POST /orgs/{id}/intelligence/autonomous/heal/{id}/approve`
- `POST /orgs/{id}/intelligence/autonomous/heal/{id}/deny`

---

## 5. Data model

Uses existing `self_heal_actions` audit table (Cat 14). Extend:

```sql
ALTER TABLE self_heal_actions ADD COLUMN source_issue_id UUID;
ALTER TABLE self_heal_actions ADD COLUMN statgate_verdict JSONB;
ALTER TABLE self_heal_actions ADD COLUMN executed_at TIMESTAMPTZ;
ALTER TABLE self_heal_actions ADD COLUMN after_state_json JSONB;
```

---

## 6. Performance & cost optimization

| Action | Latency | Cost |
|---|---|---|
| Queue heal | p95 <100ms | $0 |
| Rollback | p95 <2s | $0 |
| Cache bust | p95 <500ms | $0 |
| Reweight | p95 <1s | $0 |
| Post-heal N01 smoke | async <5min | ~$0.05 eval |

**Safety:** Execute never on hot path. Max 3 auto-heals/day/org without human.

### Monitoring

```
eden_self_heal_queued_total{action_type}
eden_self_heal_executed_total{action_type}
eden_self_heal_denied_total
```

---

## 7. Integration with InvestigationAgent

Upgrade F30/N21: when triage suggests `rollback`, auto-call:

```python
await SelfHealer().heal(org_id, action_type="rollback")
```

Link investigation trigger prefixes to issues: `issue:{issue_id}` in `_resolve_trigger_context`.

---

## 8. Acceptance criteria

- [ ] Heal queues with before_state audit snapshot
- [ ] Approve route executes rollback on test prompt version
- [ ] `autonomous_actions_v0=false` → 403 on execute
- [ ] Issue page shows linked heal actions
- [ ] N22 T0 never auto-executes
- [ ] N06 audit pack includes heal history

---

*Completes Cat 14 SelfHealer execute path. See [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md).*
