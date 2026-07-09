# N21: Autonomous Self-Heal & Remediation (Cat 14)

| Field | Value |
|---|---|
| **Feature ID** | N21 |
| **Slug** | `autonomous-self-heal-remediation` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** — SelfHealer queues only; execute path incomplete |
| **Mode** | **Assisted autonomous** → optional **T3 auto** with gates |
| **Dependencies** | N22, F29, N08, `autonomous/investigation.py`, F41 |

---

## 1. Problem

Cat 14 ships `SelfHealer` (`investigation.py:419`) with three action types:
- `rollback` — revert prompt/model version
- `reweight` — adjust routing weights
- `cache_bust` — clear semantic cache entries

**Today:** Always queues `status=pending_approval`. Execute path and `POST /heal/approve` are **incomplete**. Not connected to F29 issues or N08 StatGate escalations.

For **runtime incidents** (bad deploy, cache poison, routing drift), operators need one-click remediation — autonomous when policy allows.

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

## 3. Target behavior

### Remediation playbooks (deterministic mapping)

| Issue kind / StatGate signal | Suggested heal | Risk |
|---|---|---|
| Prompt regression (N18 canary fail) | `rollback` to last promoted prompt version | Medium |
| Model routing drift (F42) | `reweight` away from degraded model | Medium |
| Cache poisoning / stale responses | `cache_bust` for org+agent | Low |
| StatGate P0 loop spike after deploy | `rollback` + F47 alert | High |

### Operator flow
```
N17 cockpit → "Suggested heal: rollback prompt v12 → v11"
→ Admin reviews before_state audit
→ POST /heal/approve
→ HealExecutor runs action
→ N01 regression smoke on rollback
→ Issue marked resolved or regressed
```

### Autonomous flow (T3, opt-in)
```
StatGate P0 + issue kind=loop + detected_after_deploy
→ SelfHealer.heal(rollback) auto-queued
→ If N22.auto_heal_rollback=true AND F41 quick-check pass:
    → Execute without human (configurable)
→ Else: pending_approval + F47
```

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
