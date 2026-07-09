# F12: Typesense Full-Text Span Search

| Field | Value |
|---|---|
| **Feature ID** | F12 |
| **Slug** | `typesense-span-search` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.6 |

---

## 1. Summary

Sub-200ms search all span inputs/outputs.

## 2. Eden current state

Phase B stub in `observability.py:514`; Typesense config in `config.py:130`.

## 3. Target behavior

Index on ingest; `search_spans` API production-ready.

## 4. Architecture

Typesense collection per org.

## 5. Data model

None

## 6. API specification

GET /observability/search

## 7. Implementation plan

Wire `typesense_client.py`

## 8. SDK / CLI / Portal

Search bar in traces page

## 9. Feature flags & rollout

`typesense_search_v1`

## 10. Test plan

10M span load test

## 11. Acceptance criteria

- [ ] p95 <200ms

## 12. Dependencies

None

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
