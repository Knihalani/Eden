# F32: Eden Workshop OSS Local Debugger

| Field | Value |
|---|---|
| **Feature ID** | F32 |
| **Slug** | `eden-workshop-oss` |
| **Priority** | P1 |
| **Effort** | XL |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.4,5.2 |

---

## 1. Summary

Free local trace viewer localhost:9477 + eval loop.

## 2. Eden current state

Cloud portal only.

## 3. Target behavior

Separate `workshop/` package; Vite UI.

## 4. Architecture

None

## 5. Data model

Localhost API

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

npm `@eden-ai/workshop`

## 8. SDK / CLI / Portal

Standalone SPA

## 9. Feature flags & rollout

None

## 10. Test plan

Install script test

## 11. Acceptance criteria

- [ ] curl install works offline UI

## 12. Dependencies

F10,F05

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
