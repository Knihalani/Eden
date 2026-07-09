# F30: Triage Agent

| Field | Value |
|---|---|
| **Feature ID** | F30 |
| **Slug** | `triage-agent` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.2,5.1 |

---

## 1. Summary

Investigate issue → root cause → MCP handoff.

## 2. Eden current state

InvestigationAgent single-shot (`investigation.py:62`); not issue-scoped.

## 3. Target behavior

ReAct with trace tools; store triage_result on issue.

## 4. Architecture

None

## 5. Data model

POST /agent-issues/{id}/triage

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/issues/triage_agent.py`

## 8. SDK / CLI / Portal

Triage button on issue page

## 9. Feature flags & rollout

None

## 10. Test plan

90s SLA test

## 11. Acceptance criteria

- [ ] MCP handoff payload valid

## 12. Dependencies

F29,F04

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
