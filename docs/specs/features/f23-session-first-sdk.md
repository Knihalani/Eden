# F23: Session-First SDK (eden.session)

| Field | Value |
|---|---|
| **Feature ID** | F23 |
| **Slug** | `session-first-sdk` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Sentrial |
| **Closes gap** | 2.4 |

---

## 1. Summary

Primary SDK unit is session not trace.

## 2. Eden current state

Trace-first OTel model.

## 3. Target behavior

Context manager + batch flush.

## 4. Architecture

agent_sessions table.

## 5. Data model

Sessions API

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`sdk/python/eden/session.py`

## 8. SDK / CLI / Portal

`/sessions` portal

## 9. Feature flags & rollout

None

## 10. Test plan

SDK test

## 11. Acceptance criteria

- [ ] complete_session improves detection

## 12. Dependencies

F17,F20

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
