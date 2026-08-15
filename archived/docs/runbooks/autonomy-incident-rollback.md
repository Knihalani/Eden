# Runbook: Autonomy incident + rollback (N21 / N22)

**Audience:** on-call / customer success  
**Scope:** Closed-loop auto-heal (rollback / reweight / cache_bust) misbehaving or denied under N22.  
**Not in scope:** Eden internal COGS / unit-economics; F22 issue-fix chat (deleted W26).

---

## Symptoms

- Unexpected prompt canary rollback or cache flush
- Improve cockpit flooded with **Policy denial** cards
- Heal actions stuck `pending_approval` / `failed`
- FinOps explorer shows unexpected `feature=autonomy` spend
- Verify worker regresses issues after heal (`verify_failed`)

---

## Immediate containment (fail-closed)

1. **Kill switches (per action class)** — Settings → FinOps → kill matrix  
   Disable the offending class(es):
   - `rollback`
   - `reweight`
   - `cache_bust`
   - `self_heal` / `autonomy` (umbrella)

   Unknown / DB errors on kill lookup **fail-closed** (heal will not execute).

2. **N22 maintenance mode** — Settings → Autonomous → Maintenance bounds  
   Set `maintenance_mode=observe` (or `compliance_profile=hipaa`) to block all T2+ auto-execute. Seeded on org create; edits audit to `autonomy_audit_log` (N06).

3. **Daily caps** — lower `daily_maintenance_budget_usd` and/or `max_auto_rollbacks_per_day` on the same panel. Budget exhaustion forces effective mode → observe.

---

## Rollback a bad auto-heal

| Action that ran | Undo |
|---|---|
| `rollback` (canary → `rolled_back`) | Re-activate the prior good canary / prompt version in Prompts or via canary promote |
| `reweight` | Restore `model_router_weights` from before_state in `self_heal_actions.after_state_json` / before snapshot |
| `cache_bust` | No reverse — cache re-warms on demand; confirm semantic cache health |

Find the heal row:

```sql
SELECT id, action_type, status, before_state_json, after_state_json, created_at
FROM self_heal_actions
WHERE org_id = $org
ORDER BY created_at DESC
LIMIT 20;
```

Audit trail (N06):

```sql
SELECT action, decision, reason, created_at
FROM autonomy_audit_log
WHERE org_id = $org
ORDER BY created_at DESC
LIMIT 50;
```

Portal: **Improve** → cards typed `auto_heal` / `policy_denial`; **Settings → Autonomous** for bounds.

---

## Verify loop

After a heal, F46 schedules `issue_verifications`. Worker checks:

1. No new stumbles for fingerprint within `verify_quiet_window_minutes`
2. StatGate P0 clear

- Pass → issue resolved + learn hook (KB flywheel / N19)
- Fail after `verify_max_attempts` → escalate human + Slack (F47)

Pause verify worker only via `closed_loop_orchestrator_v1=false` (global) — prefer kill switches + observe mode for single-org incidents.

---

## Triage order (detect → remediate)

1. Confirm StatGate P0 / triage `source=statgate` ran **before** LLM path (N08).
2. Confirm N22 `decide` verdict in audit (`allow` vs `deny`).
3. Confirm kill switch enabled for that action class.
4. If heal executed: inspect `after_state_json`, undo per table above.
5. If denials only: explain via Improve **Denied:** reason; adjust policy or leave observe.

---

## Customer-visible cost

Autonomy LLM spend (triage / maintenance) is tagged `feature=autonomy` on `CostEvent` and counted toward the daily maintenance budget. Customer FinOps explorer surfaces it; there is **no** Eden internal unit-econ admin UI.

---

## Exit criteria for “contained”

- [ ] Offending action class kill switch OFF (or mode=observe)
- [ ] No new `self_heal_actions` with `status=executed` for that org
- [ ] Improve shows denials clearly; audit log queryable
- [ ] Customer notified of what ran + undo taken
