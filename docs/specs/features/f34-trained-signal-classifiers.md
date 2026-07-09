# F34: Per-Org Trained Signal Classifiers

| Field | Value |
|---|---|
| **Feature ID** | F34 |
| **Slug** | `trained-signal-classifiers` |
| **Priority** | P2 |
| **Effort** | XL |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.6 |

---

## 1. Summary

Train small model per product on traces.

## 2. Eden current state

Metric rules only.

## 3. Target behavior

Training pipeline + inference worker.

## 4. Architecture

signal_classifiers table.

## 5. Data model

Training job API

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/signals/classifier_pipeline/`

## 8. SDK / CLI / Portal

Signal training UI

## 9. Feature flags & rollout

None

## 10. Test plan

F1 on fixtures

## 11. Acceptance criteria

- [ ] Train <1h async

## 12. Dependencies

F06,F35

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
