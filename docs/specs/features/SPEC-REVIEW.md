# Feature Spec Cross-Review

> Review of pruned feature specs + N-features — July 9, 2026 (revised)

## Verdict

After pruning **48 → 24 F-features** and adding **8 N-features**, the spec set is **focused on deal-closing parity (F)** and **category differentiation (N)**. Coding-agent interface consolidated to **F04 Eden MCP Server**.

## Critical path

**F48 → F28 → F29 → F20 → F30 → F04 (read) → F03 → F01 → F04 (debug) → F22 → F46**

**Differentiation path (after Wave 2):** **N02 + N08 → N01 + N04 → N07**

## Blockers found in codebase

1. **F48 must ship first** — debugger/signals portal unusable
2. **F03 before F01** — no checkpoints without ingest hook
3. **F28 before F29** — issues require stumbles
4. **Slack module missing** — F47 needs new `integrations/slack/` tree
5. **No Eden MCP server** — F04 is greenfield (`packages/eden-mcp-server/`)

## Pruning decisions (validated)

| Deleted | Rationale | Absorbed by |
|---|---|---|
| F05, F10, F26, F32 | MCP-first beats CLI/Workshop sprawl | F04 |
| F13–F16, F24, F25 | OTel + docs beat N integrations | F09 + docs |
| F02, F37, F45 | Duplicate surface area | F01, F04, F39 |
| F07, F08, F31, F38, F43 | Low ROI vs N-features | F06 / deferred |

Full list: [DELETED-FEATURES.md](./DELETED-FEATURES.md)

## Schema consolidation

Migration `080_feature_gap_wave1.sql` minimum tables:

**Wave 1:** F01 cache/sessions, F28 stumbles, F29 issues, F20 detectors  
**Wave 2:** F39 nudges, N02 mcp_server_registry  
**Wave 6:** N07 generated_environments

## Hand-deepened specs

| Spec | Depth |
|---|---|
| F01 | Cached prefix debugger + sessions (F02) |
| F04 | Full Eden MCP Server — **P0 coding-agent interface** |
| F06 | Per-trace signals + cluster/backfill (F07/F08) |
| F09 | RRWeb + framework examples (F13–F16) |
| F20, F29, F39, F48 | Original deep specs |
| N01–N08 | New market-hypothesis specs |

## Risk summary

| Risk | Features | Mitigation |
|---|---|---|
| Live rerun side effects | F01 | mock tools default |
| LLM COGS | F06, F30, N03 | SLM + rate limits + budgets |
| MCP security | F04 | scoped API keys, audit log |
| Wrong nudge promoted | F39 | F41 shadow gate mandatory |
| Env gen PII leak | N07 | redacted exports + approval queue |
| Over-scoped N07 | N07 | ship after F29+F01 stable |

## N-feature market fit (summary)

| ID | Buyer pain | Eden unique? |
|---|---|---|
| N01 | Prod failure → CI regression | Convergence trend |
| N02 | MCP blind spots | Partial (ingest exists) |
| N07 | Can't reproduce prod | **Yes — Part VIII** |
| N08 | Don't trust LLM severity | **Yes — StatGate** |
| N06 | Audit pack for regulator | **Yes — Cat 10** |

## Sign-off

Pending product/engineering approval before Wave 1 code starts.

---

*See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) for full research.*
