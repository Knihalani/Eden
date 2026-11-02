# @eden/sources

How Eden reads a user's sources: the `Source` interface, `McpSource` (any MCP server's read tools, read-only
enforced), `StaticSource`, the query planner (what each lookup sends to each connector, learned per user), and
`SourceFanout` (deadlines, coalescing, caching, rate limits, breakers, adaptive concurrency, redaction before
anything is held).

## Files

| File | Owns |
|---|---|
| `src/source.ts` | `Source` (search; optional `fetch` by id D35, `list` for sync D57, `listsByTime`), `SearchQuery` (with a day `window`, D44), `ListPage` |
| `src/mcp-source.ts` | `McpSource`: the read-only check (`readTool`: `readOnlyHint: true` or operator `trustedReadTools`, else `ReadOnlyViolation`), reconnects (re-checking read-only), paged `tools/list`, `toItems` |
| `src/schema-args.ts` | Arguments built from a tool's JSON schema (search, fetch, list), deterministic; operator `fixed` values win |
| `src/shapes.ts` | Query shapes (terms, entities, one call per entity…); `inert` strips search-syntax operators from untrusted text |
| `src/planner.ts` | `QueryPlanner`, `PlannedSource`: Thompson sampling over shapes per (tenant, user, connector), learned cascade (D28–D33, D38, D39) |
| `src/guarded.ts` | `SourceFanout`: per-(user, source) breaker, AIMD, GCRA, histogram; singleflight; stale-on-failure result cache; `SharedCalls` (D48) |
| `src/fanout.ts` | `searchSources`: the plain parallel search with per-source outcome |
| `src/static-source.ts` | `StaticSource`: in-memory documents (tests, examples, `EDEN_SOURCES_FILE`) |
| `src/fixtures/` | Real MCP `tools/list` schemas and search results captured from the connector lab (`packages/sim/src/lab/capture.ts`) |

## Rules that apply here

- **Read-only (D7, D35).** Never call a tool that is not read-only, and never weaken `McpSource`'s check (CLAUDE.md).
  A new tool role (like fetch or list) goes through `readTool` and gets a test that a non-read-only tool throws.
- **Redact before holding (D10).** `SourceFanout` requires a sanitizer and runs it before caching or returning; a
  failure of our own gate yields no page and holds nothing, and is not counted against the source.
- **Isolation (D9).** Breakers, limits, caches, planner arms and singleflight keys are per tenant/user. A new piece
  of state is keyed the same way and gets a cross-user test (`regressions.test.ts` has examples).
- **Untrusted text (D11).** Queries are built from user, agent and item text: shapes pass no search syntax through.
- **Never throws.** `SourceFanout` reports each source's status ("ok", "cached", "stale", "open", "busy",
  "limited", "timeout", "error"); a guard skip spends no rate token and no half-open probe.

## Test

```bash
bun run test:pkg sources        # ~3 s; planner and shapes are the largest files
```

## Pitfalls

- Planner tests are statistical over seeded generators: keep seeds fixed; a change to arm selection usually needs
  the planner research runs (`docs/research/query-planner-results.md`), not a test tweak.
- The planner's defaults are decided by D31–D33 on held-out simulation sets; changing them needs a new decision.

## Where next

`docs/plans/query-planner.md`, `docs/research/query-planner-results.md`, `docs/research/connector-lab.md`,
`docs/research/connectors.md`; the connector lab in `packages/sim/src/lab/lab.ts`.
