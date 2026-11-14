# @eden/sources

How Eden reads a user's sources: the `Source` interface, `McpSource` (any MCP server's read tools, read-only
enforced), `StaticSource`, the query planner (what each lookup sends to each connector, learned per user), and
`SourceFanout` (deadlines, coalescing, caching, rate limits, breakers, adaptive concurrency, redaction before
anything is held).

## Files

| File | Owns |
|---|---|
| `src/source.ts` | `Source` (search; optional `fetch` by id D35, `list` for sync D57, `listsByTime`, `notifies` for push sync D125, `fetchReportsGone` for freshness checks D126, `fetchesById`: a get tool is wired, D356), `SearchQuery` (with a day `window`, D44), `ListPage` |
| `src/mcp/` | Eden's own MCP client side (D1704; no SDK in production): `types.ts` (JSON-RPC types, `Transport` shaped so the SDK's transports fit it, `asMessage`, `McpError`, versions), `client.ts` (`McpClient`: `initialize` with version negotiation, `listTools`, `callTool`, 60 s timeout, `notifications/cancelled` on abort, `ping` answered 16 at a time, other server requests dropped unless the caller set a handler: `setRequestHandler` and the constructor's `capabilities`, D1875, never set by Eden), `http.ts` (`StreamableHttpTransport`: JSON and SSE replies, session id, version header, per-POST deadline, 16 MiB reply cap (4 MiB for `tools/list` and per SSE event), a reply failed past its budgets (`limits`, D1872: 100 bad messages plus one per KiB of messages, 100 server requests plus 10 a second), same-origin redirects only; opt-in and off on Eden's path: `resume` (a broken SSE reply resumed by a GET with `Last-Event-ID`, bounded tries, within the POST's deadline and cap), `openServerStream` (the GET stream, same caps and budgets), `auth` (an `AuthHook`'s bearer token, asked once on a 401), D1873, D1874, only the POSTed id's response taken, errors without bodies), `sse.ts` (one-pass byte parser, bounded; line ends found with `indexOf` (D1840); an unended line held in `pieces.ts`'s `Pieces` (reads under 16 KB copied into one doubling buffer, so a line dripped a byte at a time holds ~2 arrays, not one a read: D1860's review measured +172 MB for 3 MB dripped before) and joined once; an event's one data line kept as a view; `chunksKept`: views of the caller's chunks, not copies, which the transport sets only for Bun's own `fetch`: a caller's `fetch` option may reuse one buffer), `json.ts` (`parseJsonBytes` / `parseJsonText`: the shape check before `JSON.parse`; D1870: a string value of 32 KiB or more with no escape or control character, when such strings are at least half the reply and it holds at most 4,096 values, is a slice of the reply put back into the parsed value, not parsed and copied; a placeholder that goes astray falls back to the plain parse; `json.test.ts` compares with `JSON.parse`), `shape.ts` (the shape check vendored from `@eden/protocol` so the directory imports nothing outside it, `shape.test.ts` fails when the copies differ; `textShapeWithin`, its form over a decoded string, D1860; D1870: a string's end found by searching for the next quote and counting the backslashes before it, so text with an escape every few dozen bytes costs 0.3 ms a MiB, not 0.8-1.0, with the same change in `@eden/protocol`), `deadlines.ts` (every request's and POST's deadline on one timer, ties in the order added, D1840); D1860: a JSON reply with one declared `Content-Length` under the cap and no `Content-Encoding` or `Transfer-Encoding` is read natively from the runtime's own `fetch` (the global as the module found it, and on Bun the native one: a replaced global gets the stream read) (`framing.test.ts`: gzip, chunked beside a length, short and long bodies), `McpClient.request`/`notify`/`server`/`onnotification`; opt-in entry points never imported by `index.ts` (Eden's path; `oauth.test.ts` walks the imports): `stdio.ts` (`StdioClientTransport`; stderr discarded by default; lines coalesced by `Pieces`), `extras.ts` (resources and prompts) and `oauth.ts` (D1874: `OAuthClientProvider`, the MCP authorization flow: RFC 9728 and 8414 discovery with the resource and issuer checked, PKCE S256 required, RFC 7591 registration, RFC 8707 `resource`, state checked once, single-flight refresh, a `TokenStore`; HTTPS or loopback only, 64 KiB and 10 s a response, no cross-origin redirect, tokens bound to their URL and issuer, errors in fixed words); `README.md` describes the module on its own, and its tests run on their own (the Eden-only ones skip) |
| `bench/mcp-client.bench.ts` | Eden's client against the SDK's and D1704's on the same SDK server (JSON and SSE): per-call p50/p99 of `callTool` and `listTools`, RSS, connections used |
| `bench/mcp-profile.bench.ts` | Where the client's time goes (D1840): a canned server in its own process, replies of 1 KB to 4 MB in JSON and SSE, 1/16/256 in flight; CPU per call, p50/p99, peak RSS, time to the first call; arms this tree, D1704's, the SDK's, a bare `fetch` floor, another tree's (`base`, `MCP_PROFILE_BASE`) (~50 min for 3 rounds; `quick`; `MCP_PROFILE_SIZES`; `MCP_PROFILE_TEXT=lines` for text with an escape every line, as tool output is, D1870) |
| `bench/mcp-compare.bench.ts`, `bench/mcp-compare-client.py` | D1860: Eden's client against the official SDK (1.x and 2.x), `@earendil-works/pi-mcp`, `@ai-sdk/mcp` and the Python `mcp` SDK, installed outside the repo (`MCP_ALT_DIR`): `perf` (CPU, p50/p99, RSS at 1 KB-1 MB, JSON and SSE, 1/16/256 in flight; time to the first call) and `hostile` (each case of `adversarial.test.ts` against a local hostile server, a fresh process per client) |
| `bench/mcp-d1704/` | The client, transport, parser and shape check as D1704 shipped them, frozen: the bench's `d1704` arm and `src/mcp/differential.test.ts`'s oracle (never imported by `src/`) |
| `src/mcp-source.ts` | `McpSource`: the read-only check (`readTool`: `readOnlyHint: true` or operator `trustedReadTools`, else `ReadOnlyViolation`), reconnects (re-checking read-only), paged `tools/list`, `toItems`; `fetch` takes a reply that is the record itself when its own id is the ref (`{id, messages: […]}`, a thread fetch's shape, D294) before looking in its rows |
| `src/schema-args.ts` | Arguments built from a tool's JSON schema (search, fetch, list), deterministic; operator `fixed` values win |
| `src/shapes.ts` | Query shapes (terms, entities, one call per entity…); `inert` strips search-syntax operators from untrusted text |
| `src/planner.ts` | `QueryPlanner`, `PlannedSource`: Thompson sampling over shapes per (tenant, user, connector), learned cascade (D28–D33, D38, D39) |
| `src/guarded.ts` | `SourceFanout`: per-(user, source) breaker, AIMD, GCRA, histogram; singleflight; stale-on-failure result cache; `SharedCalls` (D48); `list`'s `reuse` (`ListReuse`: a held, unchanged item is not redacted again); `list`'s `turn` (awaited after the source answers, before redaction, only when given: the sync's `syncIngestTurns` trial, D328); `fetchChecked` (ok / gone / failed with `why`, D126, D211; an MCP error result is `FetchErrorResult`, settled as answered and reported as "error-result", D298); `dropResults` (a changed or deleted source's held pages, D126); `park` (D754: a pair idle twenty minutes whose guards hold nothing a new set would not keeps only its learned concurrency limit) |
| `src/fanout.ts` | `searchSources`: the plain parallel search with per-source outcome (an aborted `signal` is a "timeout", no call) |
| `src/static-source.ts` | `StaticSource`: in-memory documents (tests, examples, `EDEN_SOURCES_FILE`, per-user static specs); an inverted index built on the first search and a ref map for `fetch` (D175) |
| `bench/static-source.bench.ts` | Old search vs lazy term sets vs the shipped index at 400 / 4,000 / 40,000 docs: construct, first-search and per-search ms, heap per doc; checks identical refs |
| `src/fixtures/` | Real MCP `tools/list` schemas and search results captured from the connector lab (`packages/sim/src/lab/capture.ts`) |

## Rules that apply here

- **Own MCP code, SDK as reference (D1704).** Production code imports nothing from `@modelcontextprotocol/sdk`;
  tests use its servers and transports as the reference implementation (`src/mcp/*.test.ts`, every `McpSource`
  test). A change to `src/mcp/` keeps its bounds (deadline, reply cap, shape check, same-origin redirects, id match)
  and re-runs `adversarial.test.ts`, `differential.test.ts` and the benches, reporting before/after numbers. A
  byte loop in JavaScript costs about 1.7 ns a byte, six to eight times the `JSON.parse` it guards: scan with the
  native `indexOf`, each search's position moved only forward (one that searches again from every step goes
  quadratic, D1840).
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
