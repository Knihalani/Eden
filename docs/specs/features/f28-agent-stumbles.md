# F28: Agent Stumbles (Single Failure Unit)

| Field | Value |
|---|---|
| **Feature ID** | F28 |
| **Slug** | `agent-stumbles` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.1 |

---

## 1. Summary

Atomic failure record including self-diagnostics.

## 2. Eden current state

None.

## 3. Target behavior

Insert on detect; fingerprint hash.

## 4. Architecture

agent_stumbles table.

## 5. Data model

Internal + GET stumbles

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`src/eden/issues/stumble_writer.py`

## 8. SDK / CLI / Portal

None

## 9. Feature flags & rollout

None

## 10. Test plan

Promotion test

## 11. Acceptance criteria

- [ ] Stumble on tool error span

## 12. Dependencies

F20,F29

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
