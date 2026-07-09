# F17: Sessions Multi-Turn Timeline UI

| Field | Value |
|---|---|
| **Feature ID** | F17 |
| **Slug** | `sessions-multiturn-timeline` |
| **Priority** | P2 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar,Sentrial |
| **Closes gap** | 1.8,2.4 |

---

## 1. Summary

Portal `/sessions/{id}` shows 1/N trace cards.

## 2. Eden current state

session_id attribute exists on traces; no UI.

## 3. Target behavior

Materialized view + card scroller.

## 4. Architecture

Postgres MV refresh.

## 5. Data model

session_trace_timeline MV

## 6. API specification

GET /sessions/{id}/timeline

## 7. Implementation plan

Cron refresh + route

## 8. SDK / CLI / Portal

`sessions/[sessionId]/page.tsx`

## 9. Feature flags & rollout

None

## 10. Test plan

UI test

## 11. Acceptance criteria

- [ ] 5 traces render as cards

## 12. Dependencies

F23

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
