# N11: Live Trace Streaming (Real-Time Debug Tail)

| Field | Value |
|---|---|
| **Feature ID** | N11 |
| **Slug** | `live-trace-streaming` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Market hypothesis** | DevTools "tail -f" for agents — instant feedback beats post-hoc traces for local dev |
| **Dependencies** | Ingest pipeline, F04 MCP, portal WebSocket infra, F28, N22 |

---

## 1. Summary

**Live tail** of in-flight agent traces via WebSocket/SSE — portal "Live" badge, MCP `tail_trace` for Cursor, SDK `stream=True` mode. Enables real-time maintenance during long runs without rebuilding deleted F10 local server. Finalized traces persist once (no double storage).

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| Batch span ingest | observability pipeline | Flush-on-complete only |
| Portal trace page | partial | No live updates |
| SDK trace context | `eden/sdk/` | No stream mode |
| Redis infra | deployed | Not used for live pub/sub |
| WebSocket routes | partial elsewhere | No trace stream endpoint |

---

## 3. Target behavior

- SDK `eden.trace(stream=True)` or env `EDEN_LIVE=1` → spans stream via WebSocket
- Portal trace page: **Live** badge, steps append in real time
- MCP tool: `tail_trace(session_id)` — streaming events to Cursor
- Auto-upgrades to full persisted trace on `trace.finalized`
- Optional: F28 stumble badge appears live when ETEC detects pattern mid-run

### Maintenance modes

| Mode | Use case |
|---|---|
| **Operator** | Portal live view during repro |
| **Coding agent (F04)** | MCP tail during local dev / autofix verify |
| **Autonomous (T1)** | N20/N21 post-heal smoke — tail canary session |

---

## 4. Architecture

```
SDK span start/end
    → POST /v1/stream/traces/{session_id}/events  (or WS binary frame)
    → Redis pub/sub channel trace:live:{org_id}:{session_id}
    → Portal WS subscriber + MCP SSE subscriber
    → In-memory buffer (per session, max 500 events)

trace.finalized
    → flush buffer + ingest batch to DB (single write)
    → publish trace_finalized event
    → close live channel (TTL 5min grace)
```

**Module:** `src/eden/observability/live/stream.py`

| Component | Path |
|---|---|
| `LiveTracePublisher` | `observability/live/publisher.py` |
| `LiveTraceSubscriber` | `observability/live/subscriber.py` |
| WS route | `api/routes/observability_live.py` |
| SDK stream client | `sdk/live.py` |

---

## 5. Protocol

```json
{"type": "span_start", "span_id": "...", "name": "llm.call", "ts": "...", "parent_id": "..."}
{"type": "span_update", "span_id": "...", "attributes_partial": {...}}
{"type": "span_end", "span_id": "...", "attributes": {...}, "status": "ok"}
{"type": "stumble_detected", "kind": "loop", "span_id": "..."}
{"type": "trace_finalized", "trace_id": "...", "step_count": 42}
{"type": "error", "code": "rate_limited", "message": "..."}
```

**MCP:** Streamable HTTP SSE resource `eden://live/{session_id}` or `tail_trace` tool returning event iterator.

**Auth:** Same scope as trace read — API key or session token bound to `org_id`.

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `WS` | `/v1/stream/traces/{session_id}` | Bidirectional (optional keepalive) |
| `GET` | `/v1/stream/traces/{session_id}/events` | SSE fallback |
| `POST` | `/v1/stream/traces/{session_id}/publish` | SDK ingest (HTTP fallback) |

Query params: `from_event_id` for reconnect resume.

---

## 7. Implementation plan

1. Redis pub/sub channel naming + TTL policy
2. `LiveTracePublisher` SDK hook in span lifecycle
3. WS/SSE route with org auth middleware
4. Portal live trace component (append-only list)
5. MCP `tail_trace` SSE bridge
6. Finalize flush — merge buffer into standard ingest path
7. Load test 100 concurrent sessions/org

---

## 8. Security

- Live stream requires same auth as trace read
- `session_id` scoped to org API key — reject cross-org subscribe
- PII redaction applied **before** publish (same rules as ingest)
- N22 HIPAA: live stream allowed; live **rerun** (F01) blocked separately (N06)
- Rate limit: 1000 events/min/session

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `live_trace_streaming_v1` | off |
| `live_mcp_tail_v1` | off |
| `live_max_sessions_per_org` | 100 |

---

## 10. Test plan

- SDK stream 20 spans → portal receives all within 500ms p95
- Disconnect/reconnect → resume from `from_event_id`
- Finalize → DB step count matches streamed count
- PII field redacted in live event
- 100 concurrent sessions → no Redis memory blowup (TTL enforced)

---

## 11. Acceptance criteria

- [ ] Live steps appear in portal <500ms p95 during run
- [ ] MCP tail_trace receives events in Cursor
- [ ] Finalized trace matches streamed step count
- [ ] Connection auto-closes 5min after finalize
- [ ] No double storage charge (single persist on finalize)
- [ ] F28 stumble events appear live when ETEC detects mid-run
- [ ] WS unavailable → SDK buffers locally, flush on complete

---

## 12. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| SDK publish → subscriber | 50ms | 300ms | 500ms |
| Portal render append | 16ms | 50ms | 100ms |
| Finalize flush to DB | 200ms | 1s | 3s |

### Cost model

- **LLM tier:** 0 — transport only
- **Redis memory:** ~2KB/event × 500 buffer × 100 sessions ≈ 100MB peak/org
- **Bandwidth:** compress attributes >1KB; omit large payloads until finalize

### Caching / buffering

- In-memory per-session buffer max 500 events; drop oldest with `dropped_events` counter
- Redis pub/sub: no persistence; TTL 1h on channel metadata

### Degradation modes

- WS unavailable → SDK buffers locally (current batch behavior)
- Redis down → HTTP publish fallback with 503 backoff
- Org at session cap → reject new live sessions, SDK stream=False

### Monitoring

```
eden_live_stream_sessions_active{org_id}
eden_live_stream_events_published_total
eden_live_stream_publish_latency_seconds
eden_live_stream_finalize_duration_seconds
eden_live_stream_dropped_events_total
```

---

## 13. Dependencies

| Spec | Relationship |
|---|---|
| F04 | MCP tail_trace |
| F28 | Live stumble events |
| N13 | Live updates in transcript v2 |
| N06 | HIPAA live vs rerun policy |

---

*Replaces deleted F10 value without OSS local server — cloud/streaming first.*
