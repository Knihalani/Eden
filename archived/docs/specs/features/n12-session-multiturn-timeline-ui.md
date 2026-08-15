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
| **Dependencies** | F23 session SDK, F28/F29 issues, N11, N17, F04 |

---

## 1. Summary

**Session-first portal view** — `/sessions/{session_id}` shows multi-turn conversation arc: ordered trace cards, cumulative cost, stumble badges, linked issues, and maintenance actions. Essential for operator debugging and autonomous incident context (F30 triage pulls full session timeline).

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| `session_id` on traces | ingest metadata | No session aggregation |
| F23 session SDK | spec | Partial adoption |
| Trace detail page | portal | No "view full session" link target |
| Issue linking | F29 spec | No session-level banner |

---

## 3. Target behavior

**Portal `/sessions/{session_id}`:**

| Section | Content |
|---|---|
| Header | user_id, agent_id, duration, total cost, outcome (success/fail/stumble) |
| Timeline | Horizontal trace cards 1/N, 2/N, … ordered by start time |
| Per card | summary (LLM-generated or first user msg), cost, latency, stumble badges |
| Issue banner | If session linked to F29 issue — status, severity, N17 quick actions |
| Maintenance | "Create issue", "Add turn to regression" (N01), MCP deep link |

**Interactions:**
- Click card → trace detail (N13 transcript)
- Keyboard ←/→ navigate turns
- Live session (N11): pulsing card on active turn

### Autonomous context

F30 triage receives `session_timeline` JSON:
```json
{
  "session_id": "...",
  "turn_count": 5,
  "turns": [
    {"trace_id": "...", "had_stumble": false, "cost_usd": 0.02},
    {"trace_id": "...", "had_stumble": true, "stumble_kinds": ["loop"]}
  ]
}
```

N22 T1+ triage uses full session, not single trace.

---

## 4. Architecture

```
trace.finalized (has session_id)
    → SessionRollupIndexer (async)
    → session_trace_timeline MV row update (incremental)
    → Redis session:{id}:summary cache invalidate

Portal /sessions/{id}
    → GET timeline API (card summaries only)
    → lazy load trace detail on card expand
```

| Component | Path |
|---|---|
| `SessionRollupIndexer` | `src/eden/sessions/rollup.py` |
| Timeline API | `api/routes/sessions.py` |
| Portal page | `clients/portal/src/app/(portal)/sessions/[sessionId]/page.tsx` |
| `SessionTimeline.tsx` | horizontal scroller, keyboard nav |

---

## 5. Data model

```sql
CREATE TABLE session_summaries (
    org_id UUID NOT NULL,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    user_id TEXT,
    trace_ids UUID[] NOT NULL,
    turn_count INT NOT NULL,
    total_cost_usd FLOAT DEFAULT 0,
    total_latency_ms INT,
    session_start TIMESTAMPTZ,
    session_end TIMESTAMPTZ,
    had_stumble BOOLEAN DEFAULT false,
    stumble_turn_indices INT[],
    linked_issue_id UUID,
    outcome TEXT CHECK (outcome IN ('success','fail','partial','live')),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (org_id, session_id)
);

CREATE INDEX session_summaries_org_agent_start_idx
    ON session_summaries (org_id, agent_id, session_start DESC);
```

**Incremental update:** On each trace finalize, upsert session row — avoid full MV scan (watermark per session).

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{org_id}/sessions/{session_id}` | Session header + summary |
| `GET` | `/orgs/{org_id}/sessions/{session_id}/timeline` | Ordered turn cards |
| `GET` | `/orgs/{org_id}/sessions` | List with filters |
| `POST` | `/orgs/{org_id}/sessions/{session_id}/link-issue` | Attach F29 issue |

Query params for list: `agent_id`, `since`, `had_stumble`, `min_cost`

**MCP (F04):** `get_session_timeline(session_id)` — same structure as API

---

## 7. Portal components

```
clients/portal/src/app/(portal)/sessions/[sessionId]/page.tsx
clients/portal/src/components/sessions/SessionTimeline.tsx
clients/portal/src/components/sessions/SessionHeader.tsx
clients/portal/src/components/sessions/TurnCard.tsx
```

Link from trace detail: **"View full session"** → `/sessions/{session_id}`

---

## 8. Implementation plan

1. Migration `session_summaries`
2. `SessionRollupIndexer` on trace.finalized
3. Timeline + list API routes
4. Portal page with horizontal timeline
5. Issue banner integration (F29)
6. N11 live indicator on active session
7. F30 triage session context injection
8. MCP tool

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `session_timeline_ui_v1` | off |
| `session_list_v1` | off |

---

## 10. Test plan

- 5-turn fixture → 5 cards in chronological order
- Cumulative cost = sum of trace costs
- Stumble on turn 3 → badge on card 3 only
- Live session → outcome=live, last card pulsing
- 20-turn session → page p95 <800ms

---

## 11. Acceptance criteria

- [ ] 5-turn session renders as 5 cards in order
- [ ] Cumulative cost matches sum of traces
- [ ] Stumble on turn 3 shows badge on card 3
- [ ] MCP get_session_timeline returns same structure
- [ ] Page p95 <800ms for 20-turn session
- [ ] F30 triage payload includes session timeline
- [ ] Trace detail links to session view

---

## 12. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Session page load | 200ms | 600ms | 800ms |
| Timeline API | 30ms | 120ms | 300ms |
| Rollup indexer per trace | 5ms | 20ms | 50ms |
| Session list (50 rows) | 50ms | 200ms | 500ms |

### Cost model

- **LLM tier:** 0 for timeline; optional card summary LLM async (~$0.001/card) — off by default
- **Storage:** ~300 bytes/turn in summary row

### Caching strategy

- Redis `session:{org_id}:{session_id}:summary` TTL 60s during active session
- List API: cache 30s per filter hash
- Invalidate on trace finalize for session

### Degradation modes

- Missing session_id traces → hidden from timeline (trace-only view still works)
- Rollup lag → show partial timeline + "syncing" badge
- >50 turns → virtualize horizontal scroller

### Monitoring

```
eden_session_rollup_duration_seconds
eden_session_timeline_api_duration_seconds
eden_sessions_active_live_total
```

---

## 13. Dependencies

| Spec | Relationship |
|---|---|
| F23 | Session SDK adoption |
| F28/F29 | Stumble badges + issue banner |
| N11 | Live session indicator |
| N13 | Trace detail from card click |
| F30 | Triage session context |
| F04 | MCP timeline tool |

---

*Restored from deleted F17. Pairs with F23 session-first SDK.*
