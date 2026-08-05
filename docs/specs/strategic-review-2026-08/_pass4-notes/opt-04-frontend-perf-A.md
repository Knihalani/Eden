# Pass 4 Notes — O4 Portal Frontend Performance (Agent A: Fact-Verifier & Pruner)

Method: re-grepped/re-read every cited file directly against current repo state (not trusting prior
pass verdicts). Portal root: `clients/portal/`. Backend root: `src/eden/`.

Overall verdict: this doc is exceptionally well-grounded. Of ~50 distinct file:line citations checked,
essentially all substantive claims verified true; the doc has already survived two internal correction
passes (Phase 2 caught the false `offset`-support claim, Phase 3 added the DOM-cost/trace-tree findings).
The only issues found this pass are **citation line-number drift** (single-digit to low-double-digit
off-by-N errors, likely from unrelated edits after the citations were last written) and one **wrong-section
citation** in an external spec file. No claim was found to be substantively false. One new finding: a
4th unvirtualized list exists in code that shipped in the very latest commit and predates this doc.

## VERIFIED (high-confidence, re-checked directly against source this pass)

- Framework versions exact: `clients/portal/package.json:45` (`@tanstack/react-query@^5.100.14`), `:46`
  (`@tanstack/react-virtual@^3.13.12`), `:54` (`next: 16.2.10`), `:55-56` (`react`/`react-dom: 19.2.7`),
  `:57` (`recharts@^3.9.1`). `bun run analyze` script at `package.json:25` (`ANALYZE=true next build --webpack`)
  confirmed verbatim.
- `scripts/check-bundle-size.sh:15-17` — comment "Largest observed ~327 KB; total ~6 MB",
  `PER_CHUNK_MAX_BYTES=400*1024`, `TOTAL_MAX_BYTES=6*1024*1024` — all confirmed verbatim.
- `next.config.ts:18-20` comment ("Turbopack duplicates recharts (~412KB) per async island...") and the
  `recharts`/`victory-vendor`/`d3-*` cacheGroup at `:21-46` — confirmed verbatim, including `maxSize: 350*1024`.
- `traces-client.tsx:15-16` imports (`useVirtualizer`/`defaultRangeExtractor`, `measureVirtualRow`/`VIRTUAL_SCROLL_ATTR`)
  and `useVirtualizer({...})` call at `:848-858` — confirmed exact.
- `clients/portal/src/lab/virtual-list.ts` — confirmed exactly 40 lines; `VIRTUAL_SCROLL_ATTR` at `:17`,
  `measureVirtualRow` at `:29-40`, doc's description of its zero-height-refusal behavior matches the code.
- `issues-client.tsx` — `COLUMNS.map` at `:694`, `items.map`/`onSelect` closure at `:704-709`, `runs.map`
  (issue-detail Runs tab) at `:349`. Confirmed **no `memo` import/usage anywhere in the file** (grep for
  `memo` returns nothing) — `IssueRow` is genuinely unmemoized, matching the doc's claim. `onSelect: () => void`
  prop type confirmed at `:86`. `filtered` (`useMemo`) at `:533`, `byColumn` (`useMemo`) at `:553-563`,
  `selectIssue` (`useCallback`) at `:565-571`, search `<input>` at `:653-660` (doc's `533-563`/`565-571`/`653-660`
  ranges are all correct to the line).
- `traces-session-lens.tsx` — `SessionListButton = memo(...)` at `:76-77` with the exact doc comment
  `"Memoised sibling of RunListButton — same stable-callback contract."`; `handleClick = useCallback(() =>
  onSelect(session.id), [onSelect, session.id])` at `:87-90`; `TurnCard = memo(...)` at `:136`;
  `apiTurns.map` at `:312`, `fallbackTurns.map` at `:320`; `useOrgQuery(timelineKey, orgId, () =>
  sessionsApi.timeline(orgId!, session.id))` at `:242-246` — all confirmed exact, including line numbers.
- `sessions.py:264-280` (`sessions_timeline`) confirmed to have **zero** `Query`/`limit` params (only
  `org_id`, `session_id`) — the doc's central "no server-side cap at all" claim is true. Sibling
  `sessions_list` at `:234-244` confirmed to already have `limit: int = Query(50, ge=1, le=200)` and
  `offset: int = Query(0, ge=0)` (at `:242-243`).
- `timeline.py:170-208` (`get_session_timeline`) confirmed: `trace_ids = summary["trace_ids"]` then
  unconditional, unlimited `client.fetch(_TURNS_SQL, org_id, trace_ids)` — no slicing, no limit anywhere
  in the function. `LIVE_WINDOW_S = 300.0` confirmed at `:29`.
- `rollup.py:267-291` (`_session_trace_ids`) confirmed: `dict.fromkeys(list(known) + [r["trace_id"] for r
  in indexed])` where `indexed` comes from `SELECT DISTINCT trace_id FROM telemetry_events WHERE
  tenant_id=$1 AND session_id=$2` with **no `ORDER BY`** — the "trace_ids is not chronologically ordered"
  claim, which drives the "must LIMIT/OFFSET in SQL, not slice the array" fix, is correct.
- `_TURNS_SQL`'s `GROUP BY trace_id` / `ORDER BY min(timestamp)` confirmed present (at the end of the SQL
  string — see CUT/citation-drift note below for the exact line numbers, which differ from the doc's).
- `portal.py:1598-1601` (`list_portal_issues`) confirmed `limit: int = Query(50, ge=1, le=200)`; `:1609`
  confirmed `IssuesRepo().list_issues(org_id, limit=limit, offset=0)` — hardcoded `offset=0`. Grepped the
  whole file for `offset` (only 2 hits total: this line and an unrelated alerts route) — **confirms the
  doc's "Correction to a claim in the original draft" is itself correct**: there is genuinely no
  client-controllable `offset`/cursor param for issues.
- `portal.py:1185-1192` (`list_portal_traces`) confirmed signature exactly: `window: str = Query("24h")`,
  `limit: int = Query(50, ge=1, le=200)`, no `agent_id` param anywhere in the signature — the doc's "no
  agent-scoping parameter at all" claim for the agent-detail finding is correct.
- `portal.py:2016-2024` — signals query confirmed hardcoded `LIMIT 200`, no `Query` param, inside a raw
  SQL string, not a route parameter — matches doc exactly.
- `signals-client.tsx:862` (`filtered.map`) and `:55` (`SignalRow` definition) confirmed exact; grepped file
  for `memo` — zero hits, confirming `SignalRow` is unmemoized as claimed.
- `agents-client.tsx:359-361` (workaround comment, off-by-one from doc's `:360-361`, negligible) and
  `:361-374` (`tracesQuery`/`fromApi` filter block) confirmed; `portalApi.traces(orgId!)` call with no
  filter args confirmed at `:363`.
- `telemetry_collector.py:1848` (`get_trace_tree` def) and `:2044-2080` (node dict construction) confirmed:
  `request_body`/`response_body` get `row.get(...)` fallback (not stripped) on the `hydrate_bodies=False`
  path (`:2024-2031`), and `reasoning`/`tool_calls_full`/`tool_results` (`:2071-2080`) fall through to raw
  `row.get(...)` values **unconditionally**, regardless of `hydrate_bodies` — confirms the "cheap path only
  skips message-store reconstruction, not these 5 fields" claim precisely.
- `observability.py:601-629` (`get_trace_tree_route`) confirmed `hydrate_bodies: bool = Query(False, ...)`
  at `:605` (doc says `:606`, off by one, negligible) with the exact description text quoted in the doc.
- `resources.ts:1264-1273` (`getTraceTree`) and its "used by the Inspector page..." comment confirmed
  (comment starts `:1260`, doc cites `:1263`, off by ~3, negligible).
- `build-transcript-rows.ts` — `node.metrics`/`node.payload`/`node.attributes` confirmed at `:46-48`;
  `payload.request` (request_body derivation) at `:182`; `payload.response ?? payload.output ??
  payload.content` (response_body) at `:201`; `tool_results:` block deriving from `payload.result ??
  payload.output ?? payload` at `:216-222` — all three doc line citations (`:182,201,216`) exact.
  Grepped `clients/portal/src` for `node.request_body`/`node.response_body`/`node.tool_calls_full`/
  `node.tool_results`/`node.reasoning` outside this file — **zero hits**, confirming those 5 raw API
  fields are genuinely read nowhere else client-side.
- "Already fine" section, all spot-checked and confirmed:
  - `dynamic(...)` call sites all confirmed at exact cited lines: `agents-client.tsx:49,67,75`,
    `gateway-client.tsx:30,36`, `traces-client.tsx:89,95,103,109,117`.
  - `rrweb` confirmed to appear in exactly 2 non-`.next` files (`types/rrweb-player.d.ts` and
    `app/api/rrweb-player/[asset]/route.ts`) — no client-side bundle import, matching the claim.
  - `portal-providers.tsx:17-51` (`makeQueryClient`) confirmed line-for-line: `staleTime: 90_000` (`:24`),
    `gcTime: 10*60_000` (`:25`), `refetchOnWindowFocus: false` (`:26`), `retry: false` (`:41`) with the
    F41-3 "~58 call sites" comment quoted verbatim.
  - `portal-query.ts:12` (`OBSERVE_STALE = 90_000`) and `:21-24` (`SHELL_QUERY` matching those same
    defaults) confirmed exact.
  - `saved-views-menu.tsx:69,75` (`{ enabled: open }` on both queries) and `:25-31` (`viewsForPath`)
    confirmed exact. (This file exists and matches the doc despite being part of the very recent
    "session timeline UI, automations tab, saved views" commit — **the doc is not stale here**.)
  - `portal-dehydrate.ts` — `settleWithin` at `:47-60` (doc: `:47-61`, off by one, negligible),
    `Promise.allSettled` fan-out confirmed inside `dehydrateHome`/`dehydrateTraces`/`dehydrateAgents`/
    `dehydrateIssues`; `layout.tsx:20` (`PREFETCH_BUDGET_MS = 700`) and the sequential
    `resolvePortalPrefetchAuth()` → `dehydrateMe(auth)` pattern at `:28-35` confirmed; `traces/page.tsx:12`
    (`TRACES_DEHYDRATE_BUDGET_MS = 1800`) confirmed. The "no fixable waterfall" verdict is correct.
  - `.map()` counts confirmed exactly: `agent/page.tsx` = 11, `evals/page.tsx` = 27,
    `gateway-client.tsx` = 11 (doc: "11, 27, 11 respectively" — exact). `BreakdownTable`'s `rows.map` at
    `:148` fed by `normalizeBreakdown()`'s `.slice(0, 12)` at `:100` confirmed exact.
- `n12-session-multiturn-timeline-ui.md:218` — `">50 turns → virtualize horizontal scroller"` confirmed
  verbatim under "Degradation modes."
- `sessions.py:209` (`SessionTimelineResponse.turn_count`) confirmed to exist (doc cites `:207`, off by 2,
  negligible) — the "frontend already has turn_count independent of len(turns)" claim is correct.
- `sessionsApi.list` at `resources.ts:4354-4368` (doc's exact cited range, confirmed to build a
  `URLSearchParams` from `limit`/`offset`) vs. `sessionsApi.timeline` at `:4371-4374` (doc cites
  `4370-4374`, off by one) taking zero params — confirmed exact, this is the strongest single piece of
  evidence for the "sibling route already does the right thing" argument and it holds up.
- `portalApi.issues` at `lib/api/portal.ts:86-87` confirmed to take only `orgId`, no query params.

## CUT (or: flag as citation-accuracy corrections — nothing found here is substantively false)

1. **Quote**: `"append LIMIT $3 OFFSET $4 to _TURNS_SQL itself... GROUP BY trace_id ORDER BY min(timestamp) (rollup.py:39-79)"`
   **Reason**: `_TURNS_SQL`'s actual line range is `rollup.py:49-85` (verified via `awk`), not `39-79` — a
   ~10-line citation drift. The substance (the SQL has `GROUP BY trace_id` / `ORDER BY min(timestamp)`
   with no `LIMIT`) is correct; only the line-number citation is wrong. Recommend correcting the citation
   to `rollup.py:49-85` rather than cutting the claim.

2. **Quote**: `"enumerate(turn_rows, start=1) (timeline.py:198) needs to become enumerate(turn_rows, start=offset + 1)"`
   **Reason**: The actual `enumerate(turn_rows, start=1)` line is `timeline.py:210`, not `198` — a 12-line
   drift. Substance correct, citation wrong. Recommend correcting to `timeline.py:210`.

3. **Quote**: `"the perf budget table (:196-201) was only ever validated against a 20-turn session (p95 <800ms), not against anything near what the data model actually allows"`
   **Reason**: This is the one citation error worth flagging more strongly — it points to the wrong
   section of the spec. `n12-session-multiturn-timeline-ui.md:196-201` is the "Latency budgets" table
   (generic `Session page load`/`Timeline API`/etc. p50/p95/p99 numbers with **no mention of "20-turn"
   anywhere in that table**). The actual "20-turn session → page p95 <800ms" text lives in a *different*
   section: `## 10. Test plan` at line 176 (`"20-turn session → page p95 <800ms"`) and `## 11. Acceptance
   criteria` at line 186 (`"Page p95 <800ms for 20-turn session"`). The underlying point — the spec's only
   documented perf validation target was a 20-turn session, and nothing in the code caps turns at that
   scale — is still true and well-supported; only the citation should be corrected from `:196-201` to
   `:176,186` (Test plan / Acceptance criteria), not the "Performance & cost optimization" section.

4. **Quote**: `"dehydrateHome:136-159, dehydrateTraces:163-196, dehydrateAgents:207-224, dehydrateIssues:227-244"`
   **Reason**: Verified actual definitions at `dehydrateHome:136` (exact), `dehydrateTraces:167` (doc says
   163, off by 4), `dehydrateAgents:211` (doc says 207, off by 4), `dehydrateIssues:238` (doc says 227, off
   by 11). Cumulative drift suggests the file gained ~10-15 lines somewhere between `dehydrateTraces` and
   `dehydrateIssues` since these citations were last checked. Not a substance issue (the parallelization
   claim is correct — re-verified `Promise.allSettled` usage directly), just needs a line-number refresh.

5. Minor/negligible off-by-one-to-three citations not worth separate line items (all substance-correct,
   listed for completeness rather than requiring action): `sessions.py:234-241` for `sessions_list` (limit/
   offset params actually at `:242-243`), `sessions.py:263-279` for `sessions_timeline` (decorator actually
   starts `:264`, function body ends `:280`), `observability.py:606` for `hydrate_bodies` default (actual
   `:605`), `resources.ts:1263` for `getTraceTree` comment (actual `:1260`), `sessions.py:207` for
   `turn_count` (actual `:209`), `resources.ts:4370` for `sessionsApi.timeline` (actual `:4371`),
   `portal-dehydrate.ts:47-61` for `settleWithin` (actual `:47-60`).

6. **Quote**: `"This is unusually mature infra for a portal app"` (end of the framework-versions paragraph, doc line 3)
   **Reason**: Subjective editorializing rather than a checkable fact. Not false, but it's a value
   judgment layered onto otherwise hard-cited infrastructure facts — could be trimmed without losing any
   verifiable content. Low priority; flagging per the prune brief's "filler" category rather than
   recommending forceful removal.

No claim in this document was found to be false, fabricated, or unverifiable against the codebase. The
"What good looks like elsewhere" / Sources section is externally-sourced 2026 best-practice context,
clearly delineated from the in-repo findings and honestly caveats a negative search result (Honeycomb/
Grafana/Datadog implementation blogs) rather than fabricating one — no prune needed there either.

## NEW FINDINGS

1. **A 4th unvirtualized list exists, shipped in the most recent commit, not covered by this doc**:
   `clients/portal/src/app/(portal)/signals/automations-panel.tsx:489` — `{automations.map((automation) =>
   (<li key={automation.id}><AutomationRow .../></li>))}`, `AutomationRow` defined at `:51`. Grepped the
   file for `memo` — zero hits, so `AutomationRow` is unmemoized like `IssueRow`/`SignalRow`. Backend:
   `GET /automations` (`src/eden/api/routes/wave6_online.py:209-215`) takes `limit: int = Query(100, ge=1,
   le=100)`, and `AutomationsEngine.list_automations` (`src/eden/automations/engine.py:29-46`) hard-caps at
   `min(int(limit), 100)` with a plain `ORDER BY updated_at DESC LIMIT $2` SQL query — no client-side
   pagination control beyond the 100 cap. This is the same "reuse `useVirtualizer` + `memo`" pattern
   already established in this doc, at an even lower severity than signals (100-row cap vs. 200), since
   automations are typically small, admin-configured lists in practice. Not stale — this file didn't exist
   before commit `953286b7` ("feat(portal): session timeline UI, automations tab, saved views (F58/F61/N12)"),
   which landed after this doc's most recent verification pass. Worth a one-line mention in a future pass
   (very low priority given the 100-row hard cap and typical real-world automation counts), but should not
   block this doc as currently written since it doesn't misrepresent what was actually reviewed.

2. **Doc is not stale relative to recent portal work** — directly checked: `traces-session-lens.tsx`,
   `saved-views-menu.tsx`, and `issues-client.tsx` were all touched by commit `953286b7` (the most recent
   portal feature commit) and by `67a00d35`/`b264d7b9` before it; every line-level claim this doc makes
   about those three files was re-verified against the current post-commit file contents and holds up
   exactly. The doc's own "Phase 2/Phase 3 Verdicts" sections already show it was re-fact-checked after
   at least one prior pass. No evidence this doc is describing a stale pre-refactor state.

3. **`IssuesRepo.list_issues` does accept an `offset` kwarg at the repo layer** (`src/eden/issues/repo.py:270`,
   signature confirmed to exist) — the doc's recommendation ("add an offset/cursor param to the route and
   `IssuesRepo.list_issues`") should be double-checked against this: it's possible only the *route* needs
   the new `Query` param and plumbing through to the already-existing repo parameter, not a new repo-layer
   change too. Worth a one-line precision improvement in the recommendation section, not a correctness
   issue (the doc doesn't claim the repo lacks the parameter, just that the route hardcodes it — which is
   correct either way).
