# N20: Autonomous Code Fix (Platform Repairs Agent Code)

| Field | Value |
|---|---|
| **Feature ID** | N20 |
| **Slug** | `autonomous-code-modification` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **DOGFOOD (SOTA W26)** — fingerprint ≥5× → `improvement_plans`; N22 gate; GitHub App PR; N01 merge advice; F22 deleted. Inbox model shared with N23. |
| **Role in autonomous maintenance** | When root cause is in the **customer's agent application code**, Eden generates and opens a fix PR — so the platform repairs the agent, not just runtime config |
| **Dependencies** | F29, F30, F22, N22, `code_change/scheduler.py`, F41, N01, N04 |

---

## 1. Problem

Autonomous maintenance must fix **code bugs**, not only prompt/model/runtime issues. When F30 triage identifies a recurring failure caused by application code (stack trace, file:line, same fingerprint ≥5×), Eden should **fix the user's agent code** — not just alert.

Cat 23 ships a quality-gated patch scheduler (`code_change/scheduler.py`) but it:
- Runs on **incident clusters**, not F29 agent issues
- Is **disconnected** from F30 diagnosis and F46 maintenance loop
- Never triggers from production outage/quality-drop playbooks (see [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md) §3.6)

---

## 2. Eden current state (exact)

| Component | Path | Status |
|---|---|---|
| Scheduler cron | `code_change/scheduler.py:1–53` | **SHIPPED** |
| Pre-filters | `scheduler.py:72–84`, cost/count checks | **SHIPPED** |
| `PatchGenerator` | `code_change/agent/` | **SHIPPED** |
| `proposed_patches` table | migration 023 | **SHIPPED** |
| Review inbox | `code_change/inbox/review.py` | **SHIPPED** |
| GitHub PR provider | `code_change/` + hooks | **PARTIAL** — needs GitHub App |
| Issue trigger | `code_change/issue_patch_trigger.py` | **SHIPPED (v0)** |
| Weekly schedule + cron | `schedule_due.py` + `cron_tick._run_scheduled_optimization` | **SHIPPED (v0)** |
| F22 fix chat integration | — | **PARTIAL** — deferred |

**Org policy:** `organizations.features.code_change_policy` JSONB:
```json
{
  "code_change_enabled": false,
  "auto_pr_enabled": false,
  "max_patches_per_day": 5,
  "require_statgate_pass": true
}
```

**Global settings:** `config.py` — `patch_max_per_day`, `patch_cluster_min_size`, `max_cost_per_user_per_day`

---

## 3. Target behavior (autonomous maintenance playbook 3.6)

When F30 classifies root cause as **application code bug**:

```
F29 Issue (code_bug, stumble_count ≥ 5, fingerprint stable)
    → F46 triggers IssuePatchTrigger
    → PatchGenerator uses triage_result + example traces (F30)
    → proposed_patches row → GitHub PR
    → N04 impact preview + N01 regression on PR branch
    → Default: N17 "Awaiting you" — merge PR
    → Sandbox/opt-in: auto-merge if verify pass (N22 bound)
    → F33 experiment confirms stumble_rate drop post-merge
    → Issue resolved; N01 regression case permanent
```

**Platform maintains the agent** — human only merges PR in default enterprise posture.

---

## 4. Architecture

```python
# src/eden/code_change/issue_trigger.py

class IssuePatchTrigger:
    async def on_issue_promoted(self, issue: AgentIssue) -> None:
        policy = await autonomy_policy.get(issue.org_id)
        if policy.code_change_tier < AutonomyTier.T2:
            return
        if not await cat23_prefilters.pass(issue):
            return
        patch = await PatchGenerator().from_issue(
            issue_id=issue.id,
            triage=issue.triage_result,
            trace_ids=issue.example_stumble_ids[:3],
        )
        await proposed_patches_repo.insert(patch)
        await cockpit.notify("autonomous_patch_proposed", patch.id)
```

**Wire to:** F46 `on_issue_created` / F29 IssuePromoter hook.

**Reuse:** Do not duplicate `evaluate_pending_clusters` — extend with `evaluate_pending_issues` calling same PatchGenerator.

---

## 5. API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/orgs/{id}/agent-issues/{id}/autonomous-patch` | Manual trigger |
| `GET` | `/orgs/{id}/code-change/proposed` | Inbox (existing) |
| `POST` | `/orgs/{id}/code-change/proposed/{id}/approve` | Human approve |
| `POST` | `/orgs/{id}/code-change/proposed/{id}/reject` | Reject + rejection memory |

**MCP (F04):** `propose_autonomous_patch(issue_id)`, `list_proposed_patches()`

---

## 6. Performance & cost optimization

| Guard | Source | Value |
|---|---|---|
| Max patches/day/org | `patch_max_per_day` | default 5 |
| Max LLM cost/day | `_recent_cost_for_org` | circuit breaker |
| Cluster min size | `patch_cluster_min_size` | avoid one-off flukes |
| Severity filter | `_permitted_severities()` | high/critical only for auto |
| Dedup | PatchGenerator 14d similarity | no duplicate diffs |

**Cost per patch generation:** ~$0.20–1.00 (LLM + critic). **$0** when pre-filter rejects.

**Latency:** Async — issue → proposed patch p95 <10min (not blocking ingest).

### Monitoring

```
eden_cat23_patch_proposed_total{trigger=issue|cluster}
eden_cat23_prefilter_rejected_total{reason}
eden_cat23_patch_cost_usd_total
```

---

## 7. Acceptance criteria

- [ ] P1 issue with 5+ stumbles triggers proposed patch when `code_change_enabled=true`
- [ ] Daily cost cap blocks further generation + alerts
- [ ] Approved patch opens GitHub PR (when App configured)
- [ ] Rejected patch enters rejection memory (14d cooldown)
- [ ] N22 T0 org never auto-generates
- [ ] F04 MCP lists proposed patches

---

## 8. Stand-out narrative

> Autonomous PR generation **with Cat 23 quality gates** — not raw "AI opens PR" — bounded by cost caps, dedup, StatGate, and human inbox by default.

---

*Wire Cat 23 to F29; see [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md).*
