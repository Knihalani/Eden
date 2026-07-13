---
id: agent-sessions
title: Agent sessions
sidebar_label: Agent sessions
sidebar_position: 11
---

# How-to — Agent sessions (F23)

**Agent sessions** are Eden's first-class unit for multi-turn agent runs —
one user interaction from `begin()` through `complete_session()`. They
improve F20 detection quality and power the portal session timeline (N12).

> **Note:** This is distinct from **user intelligence sessions** (Cat 9,
> analytics identity in `user_sessions`). Agent sessions track agent *runs*.

## Why sessions matter

| Without sessions | With sessions |
|------------------|---------------|
| Traces are isolated | Traces group under one `agent_session_id` |
| Failure detection per trace | `complete_session(success=False)` signals session-level failure |
| No turn timeline | Portal N12 shows turn-by-turn timeline |

## Python SDK

```python
import eden

eden.configure(api_key=..., org_id=...)

session = eden.session.begin(
    agent_id="support-bot",
    user_id="u-123",
    metadata={"channel": "web"},
)

with session.trace("turn-1") as trace:
    # auto-instrumented LLM calls attach to this trace
    answer_turn_1()

with session.trace("turn-2") as trace:
    answer_turn_2()

eden.session.complete_session(
    session,
    success=False,
    failure_reason="user abandoned checkout",
    cost_usd=0.042,
)
```

`complete_session(success=False, failure_reason=...)` feeds F20 detectors
and improves issue grouping.

## TypeScript SDK

```ts
import { configure, session } from "@eden-ai/sdk";

configure({ apiKey: ..., orgId: ... });

const s = session.begin({
  agentId: "support-bot",
  userId: "u-123",
});

await s.trace("turn-1", async () => {
  await answerTurn1();
});

await session.completeSession(s, {
  success: false,
  failureReason: "user abandoned checkout",
  costUsd: 0.042,
});
```

## REST API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/orgs/{org_id}/agent-sessions` | Create session |
| `POST` | `/v1/orgs/{org_id}/agent-sessions/{id}/end` | Finalize with success/failure |
| `POST` | `/v1/orgs/{org_id}/agent-sessions/{id}/identify` | Attach user mid-session |
| `GET` | `/v1/orgs/{org_id}/agent-sessions/{id}` | Metadata + trace list |

### Create session

```bash
curl -X POST "$EDEN_BASE_URL/v1/orgs/$EDEN_ORG_ID/agent-sessions" \
  -H "Authorization: Bearer $EDEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "support-bot",
    "user_id": "u-123",
    "metadata": {"channel": "web"}
  }'
```

### End session

```bash
curl -X POST "$EDEN_BASE_URL/v1/orgs/$EDEN_ORG_ID/agent-sessions/$SESSION_ID/end" \
  -H "Authorization: Bearer $EDEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "success": false,
    "failure_reason": "tool loop exceeded 10 iterations",
    "cost_usd": 0.15
  }'
```

Pass `agent_session_id` on ingested spans (or let the SDK set it
automatically inside `session.trace()`).

## Portal

- **Traces** — filter or group by `agent_session_id` (N12 timeline UI).
- **Agent Issues** — issues can reference the session that produced the
  failure stumble.

## Performance

| Operation | p95 budget |
|-----------|------------|
| `session.begin()` (local) | < 1 ms |
| `complete_session()` flush | < 200 ms |
| SDK overhead per nested trace | < 0.5 ms |

Flush is async on `complete_session()` — do not block the user response.
Set `EDEN_SESSION_SYNC=1` only in tests.

## What's next

- [Connect any agent](/how-to/connect-any-agent) — pick an instrumentation tier
- [Failure fixtures](/how-to/failure-fixtures) — export a session's failing trace for local replay
