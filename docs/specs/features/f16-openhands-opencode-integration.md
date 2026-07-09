# F16: OpenHands & OpenCode Integration

| Field | Value |
|---|---|
| **Feature ID** | F16 |
| **Slug** | `openhands-opencode-integration` |
| **Priority** | P2 |
| **Effort** | S |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.7 |

---

## 1. Summary

Span attributes for sandbox/file/shell tools.

## 2. Eden current state

OpenHands agent stub in code_change (`code_change/agent/openhands.py`) not ingest.

## 3. Target behavior

Decoder for OpenHands OTel attributes.

## 4. Architecture

Ingestion decoder.

## 5. Data model

None

## 6. API specification

Docs

## 7. Implementation plan

`observability/ingestion/decoders/openhands.py`

## 8. SDK / CLI / Portal

None

## 9. Feature flags & rollout

None

## 10. Test plan

Fixture

## 11. Acceptance criteria

- [ ] OpenHands trace decodes

## 12. Dependencies

None

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
