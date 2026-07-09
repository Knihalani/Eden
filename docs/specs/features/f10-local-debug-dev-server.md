# F10: Local Debug Dev Server

| Field | Value |
|---|---|
| **Feature ID** | F10 |
| **Slug** | `local-debug-dev-server` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar,Raindrop |
| **Closes gap** | 1.5,5.2 |

---

## 1. Summary

`eden debug serve` proxies agent, streams spans locally.

## 2. Eden current state

None.

## 3. Target behavior

FastAPI on :9477; optional cloud sync.

## 4. Architecture

Local collector + WS.

## 5. Data model

None

## 6. API specification

CLI command

## 7. Implementation plan

`src/eden/debugger/local_server.py`

## 8. SDK / CLI / Portal

Deep link to portal

## 9. Feature flags & rollout

None

## 10. Test plan

Local e2e

## 11. Acceptance criteria

- [ ] Trace visible <5s

## 12. Dependencies

F05,F32

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
