# F07: Signal Cluster Hierarchy & Lifecycle

| Field | Value |
|---|---|
| **Feature ID** | F07 |
| **Slug** | `signal-cluster-lifecycle` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.3 |

---

## 1. Summary

AI-named cluster tree; resolve when quiet; reopen on recurrence.

## 2. Eden current state

Jaccard on signal definitions only.

## 3. Target behavior

Embedding clusters on event summaries; status open/resolved/reopened.

## 4. Architecture

Async batch worker post-event.

## 5. Data model

signal_clusters table

## 6. API specification

POST /signal-clusters/{id}/resolve

## 7. Implementation plan

`src/eden/signals/clusterer.py`

## 8. SDK / CLI / Portal

Portal cluster tree UI

## 9. Feature flags & rollout

Part of F06

## 10. Test plan

Cluster naming test

## 11. Acceptance criteria

- [ ] Cluster resolves after 7d quiet

## 12. Dependencies

F06

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
