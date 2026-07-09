# F43: Alert Real/Benign AI Triage

| Field | Value |
|---|---|
| **Feature ID** | F43 |
| **Slug** | `alert-benign-triage` |
| **Priority** | P2 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | BentoLabs |
| **Closes gap** | 4.5 |

---

## 1. Summary

NL alerts filtered by real vs benign judge.

## 2. Eden current state

Alerts fire without triage.

## 3. Target behavior

AlertTriageJudge SLM on alert_events.

## 4. Architecture

alert_events.triage_verdict column.

## 5. Data model

None

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/alerts/triage_judge.py`

## 8. SDK / CLI / Portal

Alert detail badge

## 9. Feature flags & rollout

None

## 10. Test plan

Benign spike test

## 11. Acceptance criteria

- [ ] No page for benign

## 12. Dependencies

F20

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
