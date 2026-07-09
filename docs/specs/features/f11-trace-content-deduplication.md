# F11: Trace Content Blob Deduplication

| Field | Value |
|---|---|
| **Feature ID** | F11 |
| **Slug** | `trace-content-deduplication` |
| **Priority** | P2 |
| **Effort** | XL |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.6 |

---

## 1. Summary

Content-addressed storage for repeated span payloads (~5-20x savings).

## 2. Eden current state

Full JSON in telemetry_events/ClickHouse.

## 3. Target behavior

span_content_blobs(hash, content); spans store refs.

## 4. Architecture

Ingest-time hash + intern.

## 5. Data model

span_content_blobs

## 6. API specification

Transparent

## 7. Implementation plan

`src/eden/observability/compression/blob_store.py`

## 8. SDK / CLI / Portal

None

## 9. Feature flags & rollout

`trace_dedupe_v1`

## 10. Test plan

Dedupe ratio test

## 11. Acceptance criteria

- [ ] Duplicate system prompt stored once

## 12. Dependencies

None

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
