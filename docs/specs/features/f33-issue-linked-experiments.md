# F33: Issue-Linked Production Experiments

| Field | Value |
|---|---|
| **Feature ID** | F33 |
| **Slug** | `issue-linked-experiments` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.5 |

---

## 1. Summary

A/B verify fix reduced stumble rate.

## 2. Eden current state

Cat 12 experiments disconnected from issues.

## 3. Target behavior

Link experiment_id on issue; stumble rate by variant.

## 4. Architecture

ALTER agent_issues ADD experiment_id

## 5. Data model

POST /agent-issues/{id}/experiments

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

Extend `intelligence_experiments.py`

## 8. SDK / CLI / Portal

Issue experiment wizard

## 9. Feature flags & rollout

None

## 10. Test plan

Bayesian test

## 11. Acceptance criteria

- [ ] Shows stumble delta

## 12. Dependencies

F29,F12 experiments

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
