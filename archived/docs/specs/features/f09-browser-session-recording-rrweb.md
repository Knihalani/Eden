# F09: Browser Session Recording (RRWeb)

| Field | Value |
|---|---|
| **Feature ID** | F09 |
| **Slug** | `browser-session-recording-rrweb` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.4, 5.5 |
| **Note** | Per-framework integrations (F13–F16 deleted) — use generic OTel + this recorder |

---

## 1. Summary

Record browser DOM via RRWeb, sync events to trace steps, replay in sandboxed portal iframe. Enables debugging computer-use and web agents where screenshots alone are insufficient.

**Pruning note:** Deleted F13 Browser Use, F14 Stagehand, F15 Playwright, F16 OpenHands as separate specs. Market wants **one recorder package** + OTel auto-instrument docs, not N framework one-liners.

---

## 2. Eden current state

| Component | Path | Status |
|---|---|---|
| Replay events model | `src/eden/replay/events.py` | Backend model only |
| Computer-use routes | `observability_computer_use.py` | Screenshots/steps shipped |
| RRWeb client | — | **Missing** |
| Browser session routes | — | **Missing** |
| Portal replay UI | — | **Missing** |

---

## 3. Target behavior

1. Agent page includes `@eden-ai/browser-recorder` snippet
2. RRWeb events batch-upload to Eden keyed by `trace_id` + `step_number`
3. Portal trace view: **Browser** tab with synced replay scrubber
4. Coding agent via F04: `get_browser_replay` returns replay URL or event summary

---

## 4. Architecture

```
Browser (RRWeb) → batch POST /v1/browser-sessions/{session_id}/events
                         ↓
              browser_sessions + browser_session_events tables
                         ↓
              Portal BrowserReplayPanel (sandboxed iframe)
```

---

## 5. Data model

```sql
CREATE TABLE browser_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    trace_id UUID NOT NULL,
    session_id UUID,
    started_at TIMESTAMPTZ DEFAULT now(),
    ended_at TIMESTAMPTZ
);

CREATE TABLE browser_session_events (
    id BIGSERIAL PRIMARY KEY,
    browser_session_id UUID NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
    step_number INT,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    recorded_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/browser-sessions` | Create session, link trace |
| `POST` | `/v1/browser-sessions/{id}/events` | Batch upload RRWeb events |
| `GET` | `/v1/browser-sessions/{id}` | Session metadata |
| `GET` | `/v1/traces/{trace_id}/browser-replay` | Replay bundle for portal |

---

## 7. Implementation plan

1. **`sdk/browser-recorder/`** — npm package, RRWeb wrapper, Eden upload client
2. **`observability_browser.py`** — FastAPI routes
3. **`BrowserReplayPanel.tsx`** — portal component (sandboxed iframe, CSP strict)
4. **Docs** — `docs/integrations/browser-recording.md` with Playwright/Stagehand/Browser Use **examples** (not separate specs)
5. **F04 MCP tool** — `get_browser_replay(trace_id)` Phase 2

---

## 8. Integration guidance (replaces F13–F16)

| Framework | Approach |
|---|---|
| Playwright/Puppeteer | Inject recorder script in `page.addInitScript()` |
| Stagehand | Middleware calls Eden ingest + recorder |
| Browser Use | Wrap session start with Eden trace + recorder |
| OpenHands | OTel span attrs → computer_use routes (existing) |

One doc page per framework as **examples**, not standalone feature specs.

---

## 9. Feature flags

`browser_recording_v1` — default false

---

## 10. Test plan

- RRWeb roundtrip: record 10s session → replay in portal
- Step sync: LLM step N aligns with DOM state at N
- XSS: replay iframe cannot access parent origin

---

## 11. Acceptance criteria

- [ ] npm package publishes; 5-line integration in sample app
- [ ] Replay synced to trace step scrubber
- [ ] Batch upload handles 1MB/min event volume
- [ ] Framework example docs for Playwright + Stagehand

---

## 12. Performance & cost optimization

| Concern | Mitigation |
|---|---|
| Upload bandwidth | Client-side batch 100 events/2s; zstd compress payloads |
| Storage cost | TTL 90d browser events; N09 dedupe identical DOM snapshots |
| Replay load | Lazy-load replay bundle; CDN cache static RRWeb assets |
| Portal paint | Thumbnail first; full replay on click |

**Latency:** Upload ACK p95 <200ms; replay start p95 <1.5s.

**Client SDK overhead:** <2ms per RRWeb event (async queue).

```
eden_browser_upload_bytes_total
eden_browser_replay_load_duration_seconds
```

---

*See [DELETED-FEATURES.md](./DELETED-FEATURES.md) for F13–F16 rationale.*
