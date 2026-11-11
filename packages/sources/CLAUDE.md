# @eden/sources

How Eden reads a user's sources: the `Source` interface, `McpSource` (any MCP server's read tools, read-only
enforced), `StaticSource`, the query planner (what each lookup sends to each connector, learned per user), and
`SourceFanout` (deadlines, coalescing, caching, rate limits, breakers, adaptive concurrency, redaction before
anything is held).

## Files

| File | Owns |
|---|---|
| `src/source.ts` | `Source` (search; optional `fetch` by id D35, `list` for sync D57, `listsByTime`, `notifies` for push sync D125, `fetchReportsGone` for freshness checks D126, `fetchesById`: a get tool is wired, D356), `SearchQuery` (with a day `window`, D44), `ListPage` |
| `src/mcp-source.ts` | `McpSource`: the read-only check (`readTool`: `readOnlyHint: true` or operator `trustedReadTools`, else `ReadOnlyViolation`), reconnects (re-checking read-only), paged `tools/list`, `toItems`; `fetch` takes a reply that is the record itself when its own id is the ref (`{id, messages: […]}`, a thread fetch's shape, D294) before looking in its rows |
| `src/schema-args.ts` | Arguments built from a tool's JSON schema (search, fetch, list), deterministic; operator `fixed` values win |
| `src/shapes.ts` | Query shapes (terms, entities, one call per entity…); `inert` strips search-syntax operators from untrusted text |
| `src/planner.ts` | `QueryPlanner`, `PlannedSource`: Thompson sampling over shapes per (tenant, user, connector), learned cascade (D28–D33, D38, D39) |
| `src/guarded.ts` | `SourceFanout`: per-(user, source) breaker, AIMD, GCRA, histogram; singleflight; stale-on-failure result cache; `SharedCalls` (D48); `list`'s `reuse` (`ListReuse`: a held, unchanged item is not redacted again); `list`'s `turn` (awaited after the source answers, before redaction, only when given: the sync's `syncIngestTurns` trial, D328); `fetchChecked` (ok / gone / failed with `why`, D126, D211; an MCP error result is `FetchErrorResult`, settled as answered and reported as "error-result", D298); `dropResults` (a changed or deleted source's held pages, D126); `park` (D754: a pair idle ten minutes keeps only its learned concurrency limit) |
| `src/fanout.ts` | `searchSources`: the plain parallel search with per-source outcome (an aborted `signal` is a "timeout", no call) |
| `src/static-source.ts` | `StaticSource`: in-memory documents (tests, examples, `EDEN_SOURCES_FILE`, per-user static specs); an inverted index built on the first search and a ref map for `fetch` (D175) |
| `bench/static-source.bench.ts` | Old search vs lazy term sets vs the shipped index at 400 / 4,000 / 40,000 docs: construct, first-search and per-search ms, heap per doc; checks identical refs |
| `src/fixtures/` | Real MCP `tools/list` schemas and search results captured from the connector lab (`packages/sim/src/lab/capture.ts`) |

## Rules that apply here

- **Read-only (D7, D35).** Never call a tool that is not read-only, and never weaken `McpSource`'s check (CLAUDE.md).
  A new tool role (like fetch or list) goes through `readTool` and gets a test that a non-read-only tool throws.
- **Redact before holding (D10).** `SourceFanout` requires a sanitizer and runs it before caching or returning; a
  failure of our own gate yields no page and holds nothing, and is not counted against the source.
- **Isolation (D9).** Breakers, limits, caches, planner arms and singleflight keys are per tenant/user. A new piece
  of state is keyed the same way and gets a cross-user test (`regressions.test.ts` has examples).
- **Untrusted text (D11).** Queries are built from user, agent and item text: shapes pass no search syntax through.
- **Deadlines hold whatever the source does (A5).** `search` (through `Singleflight`) and `fetchChecked` (through
  `untilAborted`, `src/abort.ts`) return at their deadline even when the source ignores its signal, and `McpSource`
  gives up its connect at the call's signal; the abandoned call's permit is settled then, so a source that ignores
  signals can briefly hold more calls than its concurrency cap. `list` is not raced: one more await there moved the
  funnel's card batching (504 calls to 546); the engine bounds its wait for an on-demand poll instead.
- **Never throws.** `SourceFanout` reports each source's status ("ok", "cached", "stale", "open", "busy",
  "limited", "throttled", "timeout", "error"); a guard skip spends no rate token and no half-open probe. "limited" is
  our own rate limit skipping the call; "throttled" is the connector's own 429 (or "rate limit", "too many
  requests"): the call reached it, counts against its breaker and pushes our limit back (D212).

## Test

```bash
bun run test:pkg sources        # ~3 s; planner and shapes are the largest files
bun packages/sources/bench/static-source.bench.ts   # ~10 s; no assertions beyond identical refs
```

## Pitfalls

- **Idle guards are parked (D754, `SourceFanout.park`).** A (user, source) pair no call has taken for twenty
  minutes (`PARK_IDLE_MS`) whose guards hold nothing a new set would not (no call in flight, `CircuitBreaker.idle`,
  both latency histories empty, no push-back standing) loses its breaker, limiter and histograms and keeps only the
  limit it learned (`parked`, bounded by `maxStates`), given back at its next call. The check reads what the guards
  hold, never the time alone: a first version on time alone changed results in four cases the review found. A new
  guard must be added to that check (or carried in `parked`), and a path that reports on a pair without `state()`
  (`rateLimited` does: it brings a parked pair's guards back) must not assume the guards are there. Rolling-window
  phase is not kept. `park.test.ts`, `packages/sim/lab/o5/mutate-park.py`; the funnel parks every pair between
  two requests, so it shows a difference in what a lookup does. `forget` drops parked limits too.
- Planner tests are statistical over seeded generators: keep seeds fixed; a change to arm selection usually needs
  the planner research runs (`docs/research/query-planner-results.md`), not a test tweak.
- The planner's defaults are decided by D31–D33 on held-out simulation sets; changing them needs a new decision.
- **A call joins a flight only while it is joinable (D133).** `one()` and `planCalls` lead flights through `lead`,
  which keys each flight by its result key plus a sequence number and keeps the leader's drop mark and `forgets`
  beside it (`leads`, set and cleared inside the flight's own function, so it lives exactly as long as the call and
  stays counted by `dropResults` after the caller that started it gives up). A caller after a `dropResults` of the
  pair, or any `forget`, leads a fresh call: joining would hand it the copy from before the change, which the engine
  stores under the joiner's later read mark, undoubted. Never join with a bare `flights.has(resultKey)`
  (`joined-flight.test.ts` here and in the engine).
- **StaticSource search must stay identical to the old scan (D175).** Same `words` (not the primitives tokenizer:
  that folds accents and would change matches), distinct query terms counted once per document, dated documents in
  the window first, then more hits, then document order. `static-source.test.ts` keeps the old search as the oracle
  over random queries; run it after any change. The index is built on the first search, never in the constructor
  (the server builds one StaticSource per user scope), and `search` has no `await`, so its per-instance `hits` and
  `dated` scratch is zeroed before it returns.
- **Why an inverted index, not per-document term sets (D175).** The finding's stage 1 (one `Set` per document,
  still a scan of every document) was measured beside it, on the bench's generated corpus (65 Zipf words of a
  5,000-word vocabulary per doc, limit 10; median of 3 runs on a shared 4-core box, 2026-11-06):

  | Docs | Old ms/search | Term sets ms/search | Index ms/search | Term sets heap B/doc | Index heap B/doc |
  |---|---|---|---|---|---|
  | 400 | 4.13 | 0.200 | 0.081 | 4,665 | 1,669 |
  | 4,000 | 38.3 | 2.34 | 0.351 | 4,581 | 457 |
  | 40,000 | 395 | 34.3 | 2.64 | 4,575 | 246 |

  The index is 13x the term sets at 40,000 docs with about a nineteenth of their memory, past D175's bar (1.5x, no
  more memory), so it ships. Its first search (the build) costs a little more than the term sets' (597 against 495
  ms at 40,000 docs; one old search is 395 ms), once per instance; construction stays the items copy (0.5 ms at 400
  docs, 3.2 ms at 40,000). The interner is a plain `Map<string, number>`, not `Vocab`, for the folding reason above.

## Where next

`docs/plans/query-planner.md`, `docs/research/query-planner-results.md`, `docs/research/connector-lab.md`,
`docs/research/connectors.md`; the connector lab in `packages/sim/src/lab/lab.ts`.
