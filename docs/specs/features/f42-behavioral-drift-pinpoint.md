# F42: Behavioral Drift Pinpoint Reports

| Field | Value |
|---|---|
| **Feature ID** | F42 |
| **Slug** | `behavioral-drift-pinpoint` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | BentoLabs |
| **Closes gap** | 4.4 |

---

## 1. Summary

What shifted: tools, routing, prompt version.

## 2. Eden current state

Cat 13 PSI on judges only.

## 3. Target behavior

Weekly baseline vs 24h rolling; PSI per dimension.

## 4. Architecture

drift_baselines table.

## 5. Data model

GET /agents/{id}/drift

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/drift/behavioral.py`

## 8. SDK / CLI / Portal

Drift dashboard

## 9. Feature flags & rollout

None

## 10. Test plan

Model swap detection

## 11. Acceptance criteria

- [ ] Top 3 dimensions shown

## 12. Dependencies

F33

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
