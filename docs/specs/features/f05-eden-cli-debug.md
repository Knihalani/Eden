# F05: Eden CLI Debug Subcommands

| Field | Value |
|---|---|
| **Feature ID** | F05 |
| **Slug** | `eden-cli-debug` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar,Sentrial |
| **Closes gap** | 1.2,2.6 |

---

## 1. Summary

`eden debug session|trace|rerun|sql` terminal workflow.

## 2. Eden current state

CLI instrument only; no debug commands.

## 3. Target behavior

Click group in `sdk/cli/debug.py`.

## 4. Architecture

Subprocess wrapper sets EDEN_DEBUG=1.

## 5. Data model

None

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

CLI commands

## 8. SDK / CLI / Portal

`.eden/debug-session.json`

## 9. Feature flags & rollout

None

## 10. Test plan

CLI tests

## 11. Acceptance criteria

- [ ] `eden debug rerun` prints JSON diff

## 12. Dependencies

F02,F04

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
