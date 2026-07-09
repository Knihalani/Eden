# F44: Auto-Curated Production Eval Slices

| Field | Value |
|---|---|
| **Feature ID** | F44 |
| **Slug** | `auto-production-eval-slices` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | BentoLabs |
| **Closes gap** | 4.6 |

---

## 1. Summary

Nightly cluster traces → eval datasets.

## 2. Eden current state

Manual golden datasets.

## 3. Target behavior

AutoCurator job → production_eval_slices.

## 4. Architecture

production_eval_slices table.

## 5. Data model

GET /production-datasets

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/datasets/auto_curator.py`

## 8. SDK / CLI / Portal

Datasets tab

## 9. Feature flags & rollout

None

## 10. Test plan

Cluster quality

## 11. Acceptance criteria

- [ ] CI webhook on prompt change

## 12. Dependencies

Cat3 evals

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
