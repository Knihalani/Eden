# F15: Playwright/Puppeteer Integration

| Field | Value |
|---|---|
| **Feature ID** | F15 |
| **Slug** | `playwright-puppeteer-integration` |
| **Priority** | P1 |
| **Effort** | S |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.7 |

---

## 1. Summary

CDP hooks → computer_use + browser events.

## 2. Eden current state

computer_use routes exist (`observability_computer_use.py`).

## 3. Target behavior

Playwright wrapper emits steps + screenshots.

## 4. Architecture

Extend computer_use ingest.

## 5. Data model

None

## 6. API specification

Docs

## 7. Implementation plan

`sdk/python/eden/integrations/playwright.py`

## 8. SDK / CLI / Portal

Screenshot panel

## 9. Feature flags & rollout

None

## 10. Test plan

Test

## 11. Acceptance criteria

- [ ] Screenshot on trace

## 12. Dependencies

F09

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
