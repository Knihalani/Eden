# N11: Live Trace Streaming (Real-Time Debug Tail)

| Field | Value |
|---|---|
| **Feature ID** | N11 |
| **Slug** | `live-trace-streaming` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Market hypothesis** | DevTools "tail -f" for agents — instant feedback beats post-hoc traces for local dev |
| **Dependencies** | Ingest pipeline, F04 MCP, portal WebSocket infra |

---

## 1. Problem

Traces appear after run completes (batch flush). During long agent runs, engineers are blind. Laminar/Raindrop local dev servers stream spans live. Eden MCP (F04) needs **live tail** for coding-agent workflows without rebuilding F10 local server.

---

## 2. Target behavior

- SDK `eden.trace(stream=True)` or `EDEN_LIVE=1` → spans stream via WebSocket/SSE
- Portal trace page: **Live** badge, steps append in real time
- MCP tool: `tail_trace(session_id)` — streaming events to Cursor
- Auto-upgrades to full trace on `trace.finalized`

---

## 3. Architecture

```
SDK span start
    → WS /v1/stream/traces/{session_id}
    → Redis pub/sub channel trace:live:{session_id}
    → Portal + MCP subscribers

trace.finalized
    → persist to DB
    → close live channel
```

**Module:** `src/eden/observability/live/stream.py`

---

## 4. Protocol

```json
{"type": "span_start", "span_id": "...", "name": "llm.call", "ts": "..."}
{"type": "span_end", "span_id": "...", "attributes": {...}}
{"type": "trace_finalized", "trace_id": "..."}
```

MCP: Streamable HTTP or SSE resource `eden://live/{session_id}`.

---

## 5. Performance & cost optimization

| Concern | Mitigation |
|---|---|
| WS connection count | Max 100 concurrent live sessions/org |
| Redis memory | TTL 1h on pub/sub; no persistence of live events |
| Duplicate storage | Live events buffered in memory; single DB write on finalize |
| Bandwidth | Compress attributes; omit large payloads until finalize |
| Cost | $0 LLM — transport only |

**Latency:** Span visible to tail subscribers **<500ms p95** from SDK emit.

**Degradation:** WS unavailable → SDK buffers locally, flush on complete (current behavior).

---

## 6. Security

- Live stream requires same auth as trace read
- Session_id scoped to org API key
- PII redaction applied before publish (same as ingest)

---

## 7. Acceptance criteria

- [ ] Live steps appear in portal <500ms p95 during run
- [ ] MCP tail_trace receives events in Cursor
- [ ] Finalized trace matches streamed step count
- [ ] Connection auto-closes 5min after finalize
- [ ] No double-charge on storage (single persist)

---

*Replaces deleted F10 value without OSS local server — cloud/streaming first.*
