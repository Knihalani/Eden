---
title: "01 — Trace Replay & Workflow (Cat 1)"
status: IMPLEMENTED v1
last_updated: 2026-06-10
version: 1.1
---

# 01 — Trace Replay & Workflow (Cat 1)

> **Status:** IMPLEMENTED v1 (2026-06-10). The six Cat 1 services
> and ten routes return real data:
> * `ReplayService.replay_trace` / `.diff_traces` read from
>   `telemetry_events` and persist a session row to
>   `trace_replay_sessions`.
> * `WorkflowGraphBuilder.build` / `.subgraph` / `.layout` build a
>   Cytoscape-style graph from span relationships and cache it in
>   `trace_workflow_graphs`.
> * `LiveTailService.stream` yields an SSE stream of new events
>   (1s poll, 15s heartbeat) for the org.
> * `CheckpointService.rewind_to_step` / `.list_checkpoints` read
>   from `trace_replay_sessions` (the Cat 1 table, not the legacy
>   `checkpoint_blobs`).
> * `MessageViewService.get_conversation_history` / `.add_message`
>   read and write to the `conversations` /
>   `conversation_messages` tables.
> * `CustomPropertiesService.set` / `.list` merge into the
>   `tags` JSONB column on `telemetry_events` (64-key / 256-char
>   quota).
> See `tests/intelligence/test_trace_replay.py` for the 48
> behavioural tests.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles](#source-articles)
3. [What's already in Eden](#whats-already-in-eden)
4. [Feature inventory](#feature-inventory)
5. [API contracts](#api-contracts)
6. [Data model](#data-model)
7. [Algorithm / pseudo-code](#algorithm--pseudo-code)
8. [Failure modes & guardrails](#failure-modes--guardrails)
9. [Telemetry](#telemetry)
10. [Test plan](#test-plan)
11. [Acceptance criteria](#acceptance-criteria)
12. [Open questions](#open-questions)
13. [Cross-references](#cross-references)

## Goal & motivation

A user opens any stored trace, steps through it event by event,
inspects every span, and visualises it as a graph of agents, tools,
retrieval events, and model calls. From any of these views they can
also see the **live tail** (real-time stream of new traces,
Pydantic Logfire style), **rewind to a prior step** (LangGraph
Studio style), see the **multi-turn conversation history** (Lunary
style), and set **custom properties** (Helicone style).

The user story is:

> "I have a stored trace. I want to step through it event by
> event, see the workflow graph, and rewind to a prior step to
> see what would have happened if the agent had chosen
> differently."

## Source articles

* **Article 1 §1**: "Full Execution Traces, Nested Trace
  Hierarchies, Replay, Workflow Visualization."
* **Article 2 (LangSmith)**: "LangGraph Studio visual debugging
  with checkpoint management and time-travel replay."
* **Article 3 (Pydantic Logfire)**: "Live tail for real-time
  debugging."
* **Article 3 (Lunary)**: "Conversation / feedback tracking."
* **Article 3 (Helicone)**: "Custom properties on traces for
  arbitrary key-value filtering."

## What's already in Eden

* Full telemetry ingestion — 9 source-format decoders
  (`src/eden/observability/ingestion/`).
* `TraceTreeResponse` and `GET /traces/{trace_id}/tree` schema
  (`src/eden/api/routes/observability.py:120`).
* `ObservabilitySummary` — aggregated surface
  (`src/eden/api/routes/observability.py:117`).
* `SessionStore` — Redis-backed session store at
  `src/eden/storage/redis.py:233`.
* `tags` column on `telemetry_events` for ad-hoc key-value
  metadata.

The schema and ingestion already capture everything needed; this
category adds the **interactive layer**.

## Feature inventory

| Feature | Target file | Routes | Tables | Deps | Effort |
|---|---|---|---|---|---|
| `ReplayService.replay_trace` | `src/eden/observability/replay/service.py` | 1 | `trace_replay_sessions` | `telemetry_events` | M |
| `ReplayService.diff_traces` | same | 1 | (replay session) | `telemetry_events` | M |
| `WorkflowGraphBuilder.build` | `src/eden/observability/workflow/graph_builder.py` | 1 | `trace_workflow_graphs` | `telemetry_events` | M |
| `WorkflowGraphBuilder.layout` | same | (shared) | — | elk/dagre | S |
| `WorkflowGraphBuilder.subgraph` | same | 1 | — | `telemetry_events` | S |
| `LiveTailService.stream` | `src/eden/observability/live_tail/service.py` | 1 (SSE) | — | Postgres NOTIFY | M |
| `CheckpointService.rewind_to_step` | `src/eden/observability/checkpoint/rewind.py` | 2 | — | `checkpoint_blobs` | L |
| `MessageViewService` | `src/eden/observability/message_view/service.py` | 2 | `conversations`, `conversation_messages` | chat events | M |
| `CustomPropertiesService` | `src/eden/observability/custom_properties/service.py` | 2 | (uses `tags` on `telemetry_events`) | — | S |

## API contracts

```
POST /orgs/{org_id}/intelligence/replay/{trace_id}/replay
  body: { cursor: int }
  → { status, feature, live, data: { events, next_cursor } }

POST /orgs/{org_id}/intelligence/replay/diff
  body: { trace_id_a, trace_id_b }
  → { status, feature, live, data: { added, removed, changed } }

GET  /orgs/{org_id}/intelligence/replay/{trace_id}/workflow
  → { status, feature, live, data: { nodes, edges } }

POST /orgs/{org_id}/intelligence/replay/{trace_id}/subgraph
  body: { root_span_id }
  → { status, feature, live, data: { nodes, edges } }

GET  /orgs/{org_id}/intelligence/replay/live-tail
  → SSE: stream of new telemetry events (Content-Type: text/event-stream)

POST /orgs/{org_id}/intelligence/replay/{trace_id}/checkpoint/rewind
  body: { step_index }
  → { status, feature, live, data: { state } }

GET  /orgs/{org_id}/intelligence/replay/conversation/{session_id}?limit=100
  → { status, feature, live, data: { messages: [...] } }

POST /orgs/{org_id}/intelligence/replay/conversation/message
  body: { session_id, role, content, conversation_id? }
  → { status, feature, live, data: { message_id } }

POST /orgs/{org_id}/intelligence/replay/{trace_id}/properties
  body: { properties: { key: value } }
  → { status, feature, live, data: { set: [...] } }
```

## Data model

```sql
-- 1. Replay sessions: one row per "open replay" so the user can
-- resume from where they left off
CREATE TABLE trace_replay_sessions (
    id          UUID PRIMARY KEY,
    org_id      VARCHAR(128) NOT NULL,
    trace_id    VARCHAR(128) NOT NULL,
    user_id     VARCHAR(128),
    cursor      INTEGER NOT NULL DEFAULT 0,
    state_json  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_trace_replay_sessions_trace
    ON trace_replay_sessions (org_id, trace_id);

-- 2. Workflow graphs: cached DAG for the trace
CREATE TABLE trace_workflow_graphs (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    graph_json      TEXT NOT NULL,
    layout_version  VARCHAR(16) NOT NULL DEFAULT 'v1',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3-4. Conversations (Lunary parity, shared with Cat 9)
CREATE TABLE conversations (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    user_id         VARCHAR(128),
    session_id      VARCHAR(128) NOT NULL,
    title           VARCHAR(256),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_messages (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    conversation_id UUID NOT NULL,
    role            VARCHAR(16) NOT NULL,
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_conversation_messages_conv
    ON conversation_messages (org_id, conversation_id, created_at);
```

## Algorithm / pseudo-code

### Replay

```python
def replay_trace(org_id, trace_id, cursor):
    rows = SELECT * FROM telemetry_events
            WHERE org_id = ? AND trace_id = ?
            ORDER BY timestamp, span_id
            LIMIT 100 OFFSET cursor
    return {
        "events": [serialize_event(r) for r in rows],
        "next_cursor": cursor + len(rows),
    }
```

### Workflow graph

```python
def build(org_id, trace_id):
    events = SELECT * FROM telemetry_events
              WHERE org_id = ? AND trace_id = ?
              ORDER BY timestamp, span_id
    nodes = [
        {
            "id": e.span_id,
            "label": e.name,
            "type": e.event_type,
            "duration_ms": e.duration_ms,
            "error": e.error,
        }
        for e in events
    ]
    edges = [
        {"from": e.parent_span_id, "to": e.span_id}
        for e in events if e.parent_span_id
    ]
    return {"nodes": nodes, "edges": edges}
```

### Live tail (Postgres LISTEN/NOTIFY)

```python
async def stream(org_id):
    # Subscribe to the org's NOTIFY channel
    conn = await psycopg.connect(DATABASE_URL, autocommit=True)
    await conn.execute(f"LISTEN telemetry_new_{org_id}")
    while True:
        gen = conn.notifies()
        async for notify in gen:
            event = json.loads(notify.payload)
            yield f"data: {json.dumps(event)}\n\n"
```

### Checkpoint rewind

```python
def rewind_to_step(org_id, trace_id, step_index):
    # 1. Read the checkpoint at step_index
    checkpoint = SELECT * FROM checkpoint_blobs
                 WHERE org_id = ? AND trace_id = ? AND step_index = ?
    if not checkpoint:
        return None
    # 2. Reconstruct the state
    state = json.loads(checkpoint.state_json)
    # 3. Re-execute forward from there
    return {"state": state, "step_index": step_index}
```

## Failure modes & guardrails

* **Cursor out of range** — return 200 with empty `events` and
  `next_cursor: -1`.
* **Trace not found** — return 404 with the stub envelope, NOT
  501.
* **SSE connection drop** — auto-reconnect with `Last-Event-ID`.
* **Checkpoint missing for step_index** — return 404 with
  `data.message: "no checkpoint at step N"`.
* **Custom properties exceed per-org quota** — return 400 with
  `data.message: "quota exceeded"`.

## Telemetry

* `intelligence_replay_request` (counter, tagged by
  `category` and `org_id`)
* `intelligence_replay_latency_ms` (histogram)
* `intelligence_live_tail_subscribers` (gauge)
* `intelligence_checkpoint_rewind` (counter)

## Test plan

* Each route returns the stub envelope under the feature flag.
* Workflow graph returns `nodes` and `edges` even when empty.
* Live Tail returns an SSE response with
  `Content-Type: text/event-stream`.
* Custom Properties upserts idempotently.

## Acceptance criteria

- [ ] `GET /replay/{trace_id}/workflow` returns a real graph
  in <100ms for traces with <10k spans.
- [ ] `GET /replay/live-tail` streams new events with <500ms
  latency.
- [ ] `POST /replay/{trace_id}/checkpoint/rewind` actually
  rewinds the stateful execution and re-runs forward from
  there.
- [ ] `GET /replay/conversation/{session_id}` returns all
  messages in chronological order.
- [ ] `POST /replay/{trace_id}/properties` rejects properties
  that exceed the per-org quota.

## Open questions

* **SSE scalability** — does Postgres `LISTEN/NOTIFY` scale to
  10k concurrent subscribers? Probably not; we'll need Redis
  pub/sub at scale. (Owner: Platform team)
* **Workflow graph layout** — dagre or elk.js (client-side)?
  (Owner: Cat 1 lead)
* **Checkpoint storage** — how long do we retain checkpoints?
  Per-org config or global default? (Owner: Cat 1 lead)
* **Replay session TTL** — how long does an open replay
  session live before garbage collection? (Owner: Cat 1 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap)
* Stub envelope: `src/eden/intelligence_envelope.py`
* Existing trace tree: `src/eden/api/routes/observability.py`
* Cat 16 (Decision — co-located routes):
  [`16-decision-intelligence.md`](./16-decision-intelligence.md)
