# F40: The Book (Agent Memory Artifact)

| Field | Value |
|---|---|
| **Feature ID** | F40 |
| **Slug** | `the-book-agent-memory` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | BentoLabs |
| **Closes gap** | 4.2 |

---

## 1. Summary

Versioned markdown memory of failures/fixes at inference.

## 2. Eden current state

KB semantic layer not exposed as Book.

## 3. Target behavior

Nightly generator → gateway injection ≤2k tokens.

## 4. Architecture

agent_books table.

## 5. Data model

GET /agents/{id}/book

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/book/generator.py`

## 8. SDK / CLI / Portal

Book reader UI

## 9. Feature flags & rollout

None

## 10. Test plan

Version diff test

## 11. Acceptance criteria

- [ ] Updates on issue resolve

## 12. Dependencies

F39,F29

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
