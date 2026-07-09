# F04: MCP Query Server for Coding Agents

| Field | Value |
|---|---|
| **Feature ID** | F04 |
| **Slug** | `mcp-query-server` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar,Raindrop |
| **Closes gap** | 1.2,3.10 |

---

## 1. Summary

Expose traces/SQL/rerun/issues as MCP tools for Claude Code/Cursor.

## 2. Eden current state

MCP ingest only (`observability_mcp.py`). No query server.

## 3. Target behavior

New `src/eden/mcp_server/` with 10 tools wrapping internal APIs.

## 4. Architecture

stdio + HTTP transport; API key auth.

## 5. Data model

None new

## 6. API specification

MCP tools: search_traces, get_transcript, rerun_debugger, list_issues

## 7. Implementation plan

Package `eden-mcp-server`; register in docs

## 8. SDK / CLI / Portal

None

## 9. Feature flags & rollout

`mcp_query_server_v1`

## 10. Test plan

MCP integration test with mock client

## 11. Acceptance criteria

- [ ] Claude Code skill doc works end-to-end

## 12. Dependencies

F01,F29

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
