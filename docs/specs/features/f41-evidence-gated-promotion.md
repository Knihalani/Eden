# F41: Evidence-Gated Promotion Pipeline

| Field | Value |
|---|---|
| **Feature ID** | F41 |
| **Slug** | `evidence-gated-promotion` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **PARTIAL** |
| **Competitive source** | BentoLabs |
| **Closes gap** | 4.3,5.1 |

---

## 1. Summary

StatGate generalized for nudges, PRs, guardrails.

## 2. Eden current state

StatGate in trace quality spec; Cat 23 separate.

## 3. Target behavior

EvidenceGate service + promotion_candidates queue.

## 4. Architecture

promotion_candidates table.

## 5. Data model

GET /promotions queue

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/promotion/evidence_gate.py`

## 8. SDK / CLI / Portal

Promotions inbox

## 9. Feature flags & rollout

None

## 10. Test plan

Demotion test

## 11. Acceptance criteria

- [ ] Auto-archive on regression

## 12. Dependencies

F39,Cat23

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
