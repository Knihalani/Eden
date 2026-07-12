# N17: Agent Improvement Cockpit (Maintenance Queue)

| Field | Value |
|---|---|
| **Feature ID** | N17 |
| **Slug** | `agent-improvement-cockpit` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **SHIPPED (v0)** — `improvement/cockpit_aggregator.py` + `GET /orgs/{id}/improve/queue` + portal `/improve`. Richer columns / autonomous visibility stretch deferred. |
| **Market hypothesis** | Platform teams need **one queue** for "what to fix/improve next" — not 12 disconnected Cat pages |
| **Dependencies** | N14, F29, F46, `intelligence_closed_loop.py`, `agents/evolution/components.py` |

---

## 1. Problem

Eden will **autonomously maintain production agents** (detect → fix → verify — see AUTONOMOUS-MAINTENANCE.md), but users need **visibility** into what the platform is doing:

- Is my agent in an incident right now?
- Did Eden rollback a bad deploy?
- Is a canary running? Did quality recover?
- What needs **me** (credential rotation, PR merge, novel failure)?

Today maintenance signals are scattered across 12+ Cat pages. N17 is the **single pane for agent health + Eden's autonomous actions**.

---

## 2. Target behavior

**Portal `/improve`** — what Eden is doing to keep your agents healthy:

| Section | Content |
|---|---|
| **Active incidents** | Open issues, StatGate P0, SLO breaches (N05), quality drops (N03) |
| **Eden fixing now** | Rollback in progress, cache bust, canary at 5%, shadow nudge logging |
| **Needs you** | PR to merge (N20), MCP credential rotation, novel failure, dual-approval (N06) |
| **Verified recovered** | Resolved this week with before/after metrics |
| **Learned** | KB skills, Book updates, new regression cases |

This is **not** a task queue for operators to run maintenance — Eden runs the loop (F46). Humans intervene on exceptions.

See [`AUTONOMOUS-MAINTENANCE.md`](../AUTONOMOUS-MAINTENANCE.md) §9.

---

## 3. Architecture

```python
# src/eden/improvement/cockpit_aggregator.py

class ImprovementCockpitAggregator:
    async def list_queue(self, org_id: str, agent_id: str | None) -> ImprovementQueue:
        items = []
        items += await self._from_closed_loop(org_id)      # existing API
        items += await self._from_evolver_pending(org_id)    # prompt_versions ab_test
        items += await self._from_issues(org_id, agent_id)   # F29
        items += await self._from_promotions(org_id)         # F41
        items += await self._from_insights(org_id)           # insights loop
        return ImprovementQueue(sorted=by_priority(items))
```

**Does not replace F46 orchestrator** — F46 drives state machine; N17 is **read model + UX** for operators.

### 3.1 Normal vs autonomous item types

| `item_type` | Source | Default column | Autonomous action |
|---|---|---|---|
| `issue_p0` | F29 | Urgent | — |
| `statgate_escalation` | N08 | Urgent | N21 heal suggest |
| `proposed_patch` | N20 | Awaiting approval / Proposed | Approve → PR |
| `self_heal` | N21 | Awaiting approval | Approve → execute |
| `prompt_canary` | N18 | Running / Proposed | Approve promote |
| `nudge_shadow` | F39 | Running | Approve → F41 promote |
| `guardrail_promote` | N15 | Proposed | Approve → gateway |
| `regression_run` | N01 | Verify | — |
| `impact_preview` | N04 | Verify | — |
| `issue_experiment` | F33 | Verify | — |
| `kb_skill_draft` | N19 | Proposed | Approve archivist |
| `kb_suggestion` | N19 | Proposed | Read-only |
| `signal_proposed` | N10 | Proposed | Approve enable |
| `policy_blocked` | N22 | Urgent | View policy |
| `budget_exceeded` | N22 | Urgent | Adjust policy |

### 3.2 Policy-aware rendering

Every card includes:
- `autonomy_tier_required` — minimum tier for auto-action
- `effective_policy` snapshot from N22
- `blocked_reason` when N22 `may()` denied (e.g. `hipaa_manual_only`)

Portal grays out Approve when compliance policy (N06) or N22 denies — with tooltip explaining why.

### 3.3 F46 event subscription

N17 refreshes on HookBus events (not just 60s poll):

```
loop.transition.*, patch.proposed, heal.queued, evolver.canary_started,
promotion.pending, insight.created, policy.updated, budget.exceeded
```

WebSocket push to `/improve` page for sub-second card updates during autonomous runs.

---

## 4. Data model

```sql
CREATE TABLE improvement_queue_snapshots (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT,
    items JSONB NOT NULL,
    refreshed_at TIMESTAMPTZ DEFAULT now()
);

-- Optional user actions
CREATE TABLE improvement_snoozes (
    org_id UUID NOT NULL,
    item_ref TEXT NOT NULL,  -- closed_loop:uuid, issue:uuid, etc.
    snoozed_until TIMESTAMPTZ,
    PRIMARY KEY (org_id, item_ref)
);
```

Refresh: every 60s via cron or on WebSocket event from HookBus.

---

## 5. API

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/improve/queue?agent_id=` |
| `POST` | `/orgs/{org_id}/improve/items/{ref}/approve` |
| `POST` | `/orgs/{org_id}/improve/items/{ref}/snooze` |

**MCP (F04):** `get_improvement_queue(agent_id)` — "What should I fix today?"

---

## 6. Performance & cost optimization

| Concern | Mitigation |
|---|---|
| Aggregator latency | Parallel asyncio.gather; p95 <800ms |
| Stale data | Redis cache 60s; invalidate on HookBus event |
| LLM cost | **$0** — aggregates existing rows only |
| Refresh COGS | Snapshot job incremental, not full scan |

**UX:** Skeleton load <200ms from cache; background refresh.

### Monitoring

```
eden_improvement_queue_refresh_duration_seconds
eden_improvement_queue_items_total{type}
eden_improvement_action_total{action}
```

---

## 7. Acceptance criteria

- [ ] Queue shows items from closed-loop + issues + evolver in one view
- [ ] Approve on promotion item calls existing `apply_approved` (StatGate gated)
- [ ] MCP queue matches portal within 60s
- [ ] p95 page load <800ms for org with 50 pending items
- [ ] Snooze hides item until expiry

---

## 8. Autonomous maintenance integration

### Approve action routing

```python
async def approve_item(org_id: str, item_ref: str, actor: ActorContext) -> None:
    item = await queue.get(item_ref)
    decision = await autonomy_policy.may(org_id, item.agent_id, item.action)
    if not decision.allow:
        raise PolicyDenied(decision.reason)
    match item.type:
        case "proposed_patch":
            await code_change_inbox.approve(item.payload.patch_id, actor)
        case "self_heal":
            await heal_executor.execute(item.payload.action_id, actor)
        case "prompt_canary":
            await evolver.promote_canary(item.payload.version_id, actor)
        case "nudge_shadow" | "guardrail_promote":
            await promotion_hooks.apply_approved(item.payload.promotion_id, actor)
        case "kb_skill_draft":
            await procedural_client.approve(item.payload.skill_id, actor)
    await agent_audit_ledger.write("improvement_approve", item, actor)  # N06
    await f46_orchestrator.on_event(LoopEvent.approved(item))
```

### MCP maintenance workflow (F04)

Coding agent daily loop:
1. `get_improvement_queue(agent_id)` — ranked by severity (N05 score)
2. `get_autonomy_policy(agent_id)` — know what can auto-run
3. Triage top item → `run_autofix` / `propose_autonomous_patch` / `approve` as policy allows
4. `run_regression_eval` after fix

### Fleet view

`/improve?scope=fleet` — aggregate across agents using N05 severity ranking. Critical-tier agents pinned top.

---

## 9. Stand-out narrative

> "The only observability platform with a **maintenance queue** — operator-led *and* graded-autonomous — not just a trace search box."

Raindrop has issues; Bento has nudges; **Eden unifies improvement work** across evals, guardrails, prompts, PRs, KB, patches, and self-heal — with N22 policy + N06 audit.

---

*UX layer over F46. Leverages existing `intelligence_closed_loop.py`. See [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md), N20–N22.*

