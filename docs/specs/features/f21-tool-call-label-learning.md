# F21: Tool Call Label Learning

| Field | Value |
|---|---|
| **Feature ID** | F21 |
| **Slug** | `tool-call-label-learning` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | Sentrial |
| **Closes gap** | 2.2 |

---

## 1. Summary

Mark tool ✓/✗ → learn → flag similar misuse.

## 2. Eden current state

Tool intelligence exists; no label learning.

## 3. Target behavior

Embedding classifier per agent after ≥5 labels.

## 4. Architecture

tool_call_labels, tool_call_calibrators tables.

## 5. Data model

POST .../tool-calls/{span_id}/label

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/issues/tool_call_labels.py`

## 8. SDK / CLI / Portal

Tool row actions in TranscriptView

## 9. Feature flags & rollout

None

## 10. Test plan

10-label precision test

## 11. Acceptance criteria

- [ ] 8/10 similar flagged

## 12. Dependencies

F20

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
