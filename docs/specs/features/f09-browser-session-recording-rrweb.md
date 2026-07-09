# F09: Browser Session Recording (RRWeb)

| Field | Value |
|---|---|
| **Feature ID** | F09 |
| **Slug** | `browser-session-recording-rrweb` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.4,5.5 |

---

## 1. Summary

Record DOM synced to trace; replay in sandboxed iframe.

## 2. Eden current state

Backend model only (`src/eden/replay/events.py`); no RRWeb, no routes.

## 3. Target behavior

`@eden-ai/browser-recorder` npm pkg; batch upload events.

## 4. Architecture

browser_sessions + browser_session_events tables.

## 5. Data model

POST/GET session routes

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`sdk/browser-recorder/`, routes in `observability_browser.py`

## 8. SDK / CLI / Portal

BrowserReplayPanel.tsx

## 9. Feature flags & rollout

`browser_recording_v1`

## 10. Test plan

RRWeb roundtrip test

## 11. Acceptance criteria

- [ ] Replay synced to trace step

## 12. Dependencies

F13

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
