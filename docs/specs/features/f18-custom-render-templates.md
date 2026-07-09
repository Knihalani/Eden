# F18: Custom Render Templates for Annotation

| Field | Value |
|---|---|
| **Feature ID** | F18 |
| **Slug** | `custom-render-templates` |
| **Priority** | P2 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.9 |

---

## 1. Summary

Jinja2/HTML templates for labeling queue span display.

## 2. Eden current state

Labeling queue exists (`routes/labeling.py`); no templates.

## 3. Target behavior

render_templates table + sandboxed iframe render.

## 4. Architecture

Template CRUD.

## 5. Data model

render_templates

## 6. API specification

CRUD routes

## 7. Implementation plan

`src/eden/labeling/render_templates.py`

## 8. SDK / CLI / Portal

Labeling UI dropdown

## 9. Feature flags & rollout

None

## 10. Test plan

XSS safety test

## 11. Acceptance criteria

- [ ] Custom template renders safely

## 12. Dependencies

None

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
