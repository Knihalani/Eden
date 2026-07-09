# F02: Debug Session Timeline

| Field | Value |
|---|---|
| **Feature ID** | F02 |
| **Slug** | `debug-session-timeline` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.1,1.2 |

---

## 1. Summary

Group debugger runs, evals, and notes in one investigation session timeline (CLI + portal).

## 2. Eden current state

No `debug_sessions` table. Laminar writes `.lmnr/debug-session.json`.

## 3. Target behavior

First `EDEN_DEBUG=1` run creates session; subsequent runs attach. Portal shows ordered cards: run traces, eval scores, agent notes.

## 4. Architecture

`DebugSessionService` CRUD; WebSocket fanout on new run.

## 5. Data model

See F01 `debug_sessions`, `debug_session_runs` tables.

## 6. API specification

`GET /debugger/sessions/{id}` returns `{runs[], evals[], notes[]}` sorted by time.

## 7. Implementation plan

`src/eden/debugger/session.py`; wire CLI `eden debug session start`.

## 8. SDK / CLI / Portal

Portal route `/debugger/sessions/[id]` with vertical timeline component.

## 9. Feature flags & rollout

`debugger_sessions_v1`

## 10. Test plan

Unit: session attach idempotency

## 11. Acceptance criteria

- [ ] CLI + portal show same session id

## 12. Dependencies

F01, F05

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
