# F35: Default Signal Library

| Field | Value |
|---|---|
| **Feature ID** | F35 |
| **Slug** | `default-signal-library` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.6,5.4 |

---

## 1. Summary

Prebuilt: Forgetting, Laziness, Wins, Jailbreak, etc.

## 2. Eden current state

None shipped as defaults.

## 3. Target behavior

8 templates enabled on org create.

## 4. Architecture

Seed data migration.

## 5. Data model

Enable endpoint

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/signals/defaults.py`

## 8. SDK / CLI / Portal

Settings toggles

## 9. Feature flags & rollout

Auto-enable new orgs

## 10. Test plan

Library coverage test

## 11. Acceptance criteria

- [ ] Frustration fires on fixture

## 12. Dependencies

F34,F36

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
