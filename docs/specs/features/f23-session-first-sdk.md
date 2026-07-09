# F23: Session-First SDK (`eden.session`)

| Field | Value |
|---|---|
| **Feature ID** | F23 |
| **Slug** | `session-first-sdk` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Sentrial |
| **Closes gap** | 2.4 |
| **Dependencies** | N12 (timeline UI), F20 (task_failure detection) |

---

## 1. Summary

Primary SDK unit is **session** (multi-turn conversation), not isolated trace. Improves F20 detection (`session.complete(success=False)`), N12 timeline, and Sentrial parity.

---

## 2. Eden current state

- Trace-first OTel model
- `session_id` attribute on spans exists
- `routes/sessions.py` — partial API
- No Python `eden.session` context manager

---

## 3. Target SDK API

```python
import eden

with eden.session(user_id="u-123", agent_id="support-bot") as session:
    with session.trace("turn-1") as trace:
        # agent runs; auto-instrumented
        pass
    with session.trace("turn-2") as trace:
        pass
    session.complete(success=False, failure_reason="user abandoned checkout")
# Batch flush all traces; session metadata attached
```

**TS equivalent:** `@eden-ai/session` package.

---

## 4. Architecture

```
SessionContext (contextvars)
    → each trace inherits session_id, user_id, agent_id
    → session.end() → POST /sessions/{id}/end + flush buffer
    → materialized for N12 timeline
```

**Module:** `sdk/python/eden/session.py`

---

## 5. Data model

```sql
CREATE TABLE agent_sessions (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT,
    user_id TEXT,
    metadata JSONB DEFAULT '{}',
    success BOOLEAN,
    failure_reason TEXT,
    trace_ids UUID[] DEFAULT '{}',
    started_at TIMESTAMPTZ DEFAULT now(),
    ended_at TIMESTAMPTZ
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sessions/start` | Create session (or implicit in SDK) |
| `POST` | `/sessions/{id}/end` | Finalize with success/failure |
| `POST` | `/sessions/{id}/identify` | Attach user mid-session |
| `GET` | `/sessions/{id}` | Metadata + trace list |

---

## 7. Performance & cost optimization

### Latency budgets

| Operation | p95 |
|---|---|
| session.start (local) | <1ms |
| session.end flush | <200ms (batch traces) |
| SDK overhead per trace | <0.5ms |

### Cost model

- **$0** — metadata only; traces billed as today
- Batch flush reduces HTTP calls: N traces → 1 end call

### Client experience

- Async flush on `session.end()` — don't block user response
- Retry buffer if network fail (local disk queue, max 10MB)
- `EDEN_SESSION_SYNC=1` for tests only

### Monitoring

```
eden_session_started_total
eden_session_flush_duration_seconds
eden_session_flush_failed_total
```

---

## 8. Feature flags

SDK feature — no server flag required. Server: `agent_sessions_v1`

---

## 9. Acceptance criteria

- [ ] Multi-turn session → single session_id on all traces
- [ ] `complete(success=False)` triggers F20 task_failure
- [ ] N12 timeline shows all turns
- [ ] Flush p95 <200ms for 10-trace session
- [ ] TS + Python SDK parity

---

*See N12 session UI, F20 detector `task_failure`.*
