# N12: Session Multi-Turn Timeline UI

| Field | Value |
|---|---|
| **Feature ID** | N12 |
| **Slug** | `session-multiturn-timeline` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Restores** | Deleted F17 (sessions multi-turn timeline) |
| **Market hypothesis** | Sentrial session-first UX — users think in conversations, not isolated traces |
| **Dependencies** | F23 session SDK, F28/F29 issues |

---

## 1. Problem

`session_id` exists on traces but portal has no `/sessions/{id}` view. Operators cannot see **conversation arc** — which turn failed, cumulative cost, issue timeline across turns.

---

## 2. Target behavior

**Portal `/sessions/{session_id}`:**
- Header: user_id, agent_id, duration, total cost, outcome (success/fail)
- Horizontal timeline: trace cards 1/N, 2/N, …
- Per card: summary, cost, stumble badges, click → trace detail
- Issue banner if session linked to F29 issue

---

## 3. Data model

```sql
CREATE MATERIALIZED VIEW session_trace_timeline AS
SELECT
    org_id,
    session_id,
    array_agg(trace_id ORDER BY min_start_time) AS trace_ids,
    count(*) AS turn_count,
    sum(cost_usd) AS total_cost_usd,
    min(min_start_time) AS session_start,
    max(max_end_time) AS session_end,
    bool_or(has_stumble) AS had_stumble
FROM trace_session_rollup
GROUP BY org_id, session_id;

-- Refresh: every 5min via pg_cron or tick worker
```

---

## 4. API

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/sessions/{session_id}` |
| `GET` | `/orgs/{org_id}/sessions/{session_id}/timeline` |
| `GET` | `/orgs/{org_id}/sessions?agent_id=&since=` |

**MCP (F04):** `get_session_timeline(session_id)`

---

## 5. Portal components

- `clients/portal/src/app/(portal)/sessions/[sessionId]/page.tsx`
- `SessionTimeline.tsx` — horizontal scroller, keyboard nav
- Link from trace detail: "View full session"

---

## 6. Performance & cost optimization

| Operation | Target |
|---|---|
| Session page load | p95 <800ms |
| MV refresh | Incremental; only sessions with new traces in window |
| Timeline API | Return card summaries only (~200 bytes/card), not full transcripts |

**Caching:** Redis `session:{id}:summary` 60s TTL during active session.

**Cost:** MV refresh O(new traces) not full table scan — use watermark.

---

## 7. Acceptance criteria

- [ ] 5-turn session renders as 5 cards in order
- [ ] Cumulative cost matches sum of traces
- [ ] Stumble on turn 3 shows badge on card 3
- [ ] MCP get_session_timeline returns same structure
- [ ] Page p95 <800ms for 20-turn session

---

*Restored from deleted F17. Pairs with F23 session-first SDK.*
