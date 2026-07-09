# F37: MCP run_autofix Orchestration

| Field | Value |
|---|---|
| **Feature ID** | F37 |
| **Slug** | `mcp-run-autofix` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.10,5.1 |

---

## 1. Summary

trace → patch → verify → PR in one MCP tool.

## 2. Eden current state

Cat 23 stub.

## 3. Target behavior

Orchestrates F30+F22+PatchGenerator.

## 4. Architecture

None

## 5. Data model

MCP tool run_autofix

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`mcp_server/tools/autofix.py`

## 8. SDK / CLI / Portal

None

## 9. Feature flags & rollout

`mcp_autofix_v1` false default

## 10. Test plan

Integration test

## 11. Acceptance criteria

- [ ] Returns pr_url

## 12. Dependencies

F04,F22,F30

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
