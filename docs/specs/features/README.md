# Feature Implementation Specs

> **Master document:** [`../FEATURE-GAP-MASTER.md`](../FEATURE-GAP-MASTER.md)  
> **Market hypotheses:** [`../MARKET-HYPOTHESES.md`](../MARKET-HYPOTHESES.md)  
> **Deleted specs:** [`DELETED-FEATURES.md`](./DELETED-FEATURES.md)  
> **Review:** [`SPEC-REVIEW.md`](./SPEC-REVIEW.md)

## Inventory (revised July 2026)

| Category | Count | Description |
|---|---|---|
| **F-features** | 24 | Competitor-parity closed loop (pruned from 48) |
| **N-features** | 8 | Next-level maintenance, improvement, observability |

## Priority tiers

| Priority | Features |
|---|---|
| **P0 — Ship first** | F01, F03, F04, F20, F28, F29, F30, F39, F41, F46, F47, F48, **N01, N02, N07** |
| **P1 — Next** | F06, F09, F12, F22, F23, F33, F35, F40, F42, F44, **N03, N04, N05, N06, N08** |
| **P2 — Later** | F21, F34 |

## Coding-agent-first strategy

**F04 Eden MCP Server** is the primary interface for Cursor, Claude Code, and Windsurf. Deleted F05 CLI, F10 local dev server, F26 session inspection, F37 run_autofix — all absorbed into F04 MCP tools. See [f04-eden-mcp-server.md](./f04-eden-mcp-server.md).

## Quick start for engineers

1. Read [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md) Section 5 for waves
2. **Wave 0:** F48 portal fix (blocker)
3. **Wave 1:** F28→F29→F20→F30 + F04 MCP read tools
4. Check dependencies in each spec before starting
5. For differentiation work, read [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) then N-feature specs

## Hand-deepened specs

These were expanded beyond generator output:

- F01, F04, F06, F09, F20, F29, F39, F48
- N01–N08 (new)

## Generator

`generate_specs.py` — regenerates skeleton F-specs only. **Hand-edited specs take precedence.** N-features are not generated.
