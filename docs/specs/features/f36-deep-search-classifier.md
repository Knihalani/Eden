# F36: Deep Search → Classifier Pipeline

| Field | Value |
|---|---|
| **Feature ID** | F36 |
| **Slug** | `deep-search-classifier` |
| **Priority** | P2 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.8 |

---

## 1. Summary

NL search → refine → save as signal/classifier.

## 2. Eden current state

AI sidebar search only.

## 3. Target behavior

Persist query embedding → cluster → generate rule.

## 4. Architecture

saved_searches table.

## 5. Data model

POST /deep-search/save-as-signal

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

Wire ChatSidebar to signals

## 8. SDK / CLI / Portal

Save as Signal button

## 9. Feature flags & rollout

None

## 10. Test plan

E2E test

## 11. Acceptance criteria

- [ ] Chinese user classifier story

## 12. Dependencies

F06,F34

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
