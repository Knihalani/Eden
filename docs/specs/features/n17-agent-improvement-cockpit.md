# N17: Agent Improvement Cockpit (Maintenance Queue)

| Field | Value |
|---|---|
| **Feature ID** | N17 |
| **Slug** | `agent-improvement-cockpit` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **PARTIAL** — hooks, portal API, evolver exist; no unified UX |
| **Market hypothesis** | Platform teams need **one queue** for "what to fix/improve next" — not 12 disconnected Cat pages |
| **Dependencies** | N14, F29, F46, `intelligence_closed_loop.py`, `agents/evolution/components.py` |

---

## 1. Problem

Eden ships maintenance primitives in silos:

| Source | Path | Emits |
|---|---|---|
| Closed-loop actions | `intelligence_closed_loop.py` | Pending approve/deny |
| Judge prompt evolver | `agents/evolution/components.py` | New prompt variants + canary |
| Insights detector | `insights/detector_loop.py` | KB insights |
| Promotion hooks | `promotion_hooks.py` | 20+ event kinds |
| Code change hook | `CodeChangeHook` | Patch proposals |
| Drift alerts | `DriftAlertHook` | PSI breaches |

**No unified "Agent Improvement Queue"** — users cannot answer: *"What should I do today to improve agent X?"*

---

## 2. Target behavior

**Portal `/improve`** — single maintenance cockpit per agent (and fleet-wide view):

| Column | Item types (operator mode) | + Autonomous mode (N22 T2+) |
|---|---|---|
| **Urgent** | P0 issues (F29), StatGate escalations (N08), budget breaches | + policy auto-escalations, failed autonomous actions |
| **Proposed** | Empty until human requests fix | Patches (N20), heals (N21), canaries (N18), shadow nudges (F39), KB drafts (N19), signals (N10) |
| **Awaiting approval** | — | Self-heal queue, proposed_patches inbox, dual-approval promotions (N06) |
| **Verify** | Open PRs (F22), experiments (F33), regression runs (N01), impact previews (N04) | + autonomous PR smoke, canary experiments (F33) |
| **Running autonomously** | — | Active canaries, shadow nudges logging, live heal in progress |
| **Learned** | KB skills added, Book updates (F40), resolved this week | + auto-promoted items with F41 evidence links |

Each card: **one-click actions** — Approve, Reject, Open in Cursor (F04 MCP), Snooze, View policy (N22).

See [`AUTONOMOUS-MAINTENANCE.md`](../AUTONOMOUS-MAINTENANCE.md) for mode definitions.

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

