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

**Portal `/improve`** — single maintenance cockpit per agent:

| Column | Item types |
|---|---|
| **Urgent** | P0 issues (F29), StatGate escalations (N08), budget breaches |
| **Proposed** | Prompt canary (evolver), guardrail promotion (N15), nudge shadow (F39) |
| **Verify** | Open PRs (F22), experiments (F33), regression runs (N01) |
| **Learned** | KB skills added, Book updates (F40), resolved this week |

Each card: **one-click actions** — Approve, Reject, Open in Cursor (F04 MCP), Snooze.

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

## 8. Stand-out narrative

> "The only observability platform with a **maintenance queue** — not just a trace search box."

Raindrop has issues; Bento has nudges; **Eden unifies improvement work** across evals, guardrails, prompts, PRs, and KB.

---

*UX layer over F46. Leverages existing `intelligence_closed_loop.py`.*
