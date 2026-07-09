# F45: Runtime Skill Export to Customer Repo

| Field | Value |
|---|---|
| **Feature ID** | F45 |
| **Slug** | `runtime-skill-export` |
| **Priority** | P2 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | BentoLabs |
| **Closes gap** | 4.1 |

---

## 1. Summary

Export nudges/skills as YAML/MD in customer git.

## 2. Eden current state

None.

## 3. Target behavior

`eden nudges export` CLI.

## 4. Architecture

None

## 5. Data model

CLI

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`sdk/cli/nudges_export.py`

## 8. SDK / CLI / Portal

None

## 9. Feature flags & rollout

None

## 10. Test plan

Export schema test

## 11. Acceptance criteria

- [ ] Valid YAML

## 12. Dependencies

F39

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
