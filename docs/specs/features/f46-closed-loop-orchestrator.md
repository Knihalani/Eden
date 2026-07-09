# F46: Closed-Loop Orchestrator

| Field | Value |
|---|---|
| **Feature ID** | F46 |
| **Slug** | `closed-loop-orchestrator` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | All |
| **Closes gap** | 5.1 |

---

## 1. Summary

Issue state machine wires detect→fix→verify.

## 2. Eden current state

Hooks exist (`promotion_hooks.py`) but disconnected.

## 3. Target behavior

Orchestrator on issue status transitions.

## 4. Architecture

None

## 5. Data model

Internal

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/closed_loop/orchestrator.py`

## 8. SDK / CLI / Portal

Kanban dashboard

## 9. Feature flags & rollout

None

## 10. Test plan

Demo script

## 11. Acceptance criteria

- [ ] Full loop staging <30min

## 12. Dependencies

F20-F41

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
