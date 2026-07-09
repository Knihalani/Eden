# N20: Autonomous Code Modification Pipeline (Cat 23 → Issues)

| Field | Value |
|---|---|
| **Feature ID** | N20 |
| **Slug** | `autonomous-code-modification` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **PARTIAL** — scheduler + PatchGenerator shipped; not issue-scoped |
| **Mode** | **Assisted autonomous** (propose → approve → merge) |
| **Dependencies** | F29, F22, N22, `code_change/scheduler.py`, F41 |

---

## 1. Problem

Eden Cat 23 ships a **quality-gated autonomous patch scheduler** (`src/eden/code_change/scheduler.py`) that:
- Runs 15-min cron on **incident clusters** (not F29 issues)
- Pre-filters: `code_change_enabled`, cluster size, daily cost cap, rejection memory
- Generates `proposed_patches` via `PatchGenerator`

But it is **disconnected** from the F29 issue loop, F22 fix chat, and F04 `run_autofix`. Operators cannot get autonomous PR proposals triggered by **agent issues** they see in the cockpit.

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
| Issue trigger | — | **MISSING** |
| F22 fix chat integration | — | **MISSING** |

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

## 3. Target behavior

### Operator mode (normal)
```
Issue → human opens F22 fix chat → proposes diff → human applies → PR
```

### Assisted autonomous mode
```
F29 Issue (P0/P1, stumble_count ≥ 5, N22 tier ≥ T2)
    → AutonomousPatchOrchestrator.evaluate(issue)
    → Passes Cat23 pre-filters (cost, dedup, severity)
    → PatchGenerator with triage_result + example traces (F30)
    → proposed_patches row status=proposed
    → N17 cockpit + Slack (F47): "Patch ready for review"
    → Human approve → existing review.py flow → PR
    → N01 regression on PR branch → F41 before merge
```

### Fully autonomous mode (T4, sandbox only)
```
Same as above + auto-approve if:
    - N01 regression pass
    - N04 impact preview pass
    - StatGate pass on hermetic verify
    - F41 EvidenceGate pass
→ Auto-merge PR (GitHub App)
```

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
