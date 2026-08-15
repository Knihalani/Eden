# Pass 4 notes — Agent B (Impact Validator) on bugs/03-api-mcp-contracts.md

Scope: assess real-world usage impact of every claimed broken MCP tool/API contract,
grounded in actual call-site evidence (internal callers, how-to docs, feature docs).
Do not re-derive the schema-diffs from scratch — spot-verified the load-bearing ones
(all confirmed accurate) and focused effort on "does this matter" evidence.

## Headline finding (applies to the whole doc, not any one tool)

**Eden's MCP server is officially soft-retired and has zero internal callers.** Doc 03
never mentions this and it materially changes the P0 framing used throughout the
doc's priority list.

- `docs/docs/how-to/mcp-cursor.md:1-15` — `draft: true`, sidebar label "MCP in Cursor
  (retired)", banner: *"Soft-retired for free beta (2026-07-31). Eden MCP is not a
  first-class product surface. HTTP transport and org MCP key routes are off/unmounted.
  This page is kept for internal/dev reference only and is hidden from the docs
  sidebar. Prefer the portal debugger, improve cockpit, and REST APIs."* This is
  pre-existing content (confirmed via `git diff` — the only change in this pass removed
  an `unlisted: true` frontmatter line; the retirement banner itself predates this
  review), not something injected by the review.
- `src/eden/api/app.py:210-212` — the HTTP MCP transport mount is commented:
  `# Soft-retired for free beta (F04): Streamable HTTP MCP stays behind
  mcp_http_transport_v1=False inside the router. Do not advertise.`
- `src/eden/config.py:1259` — `mcp_http_transport_v1: bool = False` (off by default).
- Repo-wide grep for internal importers of `eden.mcp_server.tools`/`.client` outside
  `src/eden/mcp_server/` itself: **zero hits.** Nothing in `improvement/`,
  `autonomous/`, `closed_loop/`, `nudges/`, etc. — none of Eden's own agent workflows
  invoke any MCP tool. The only consumers are (a) an external developer's IDE
  (Cursor/Claude Code) over stdio, both non-default and non-advertised per the banner
  above, or (b) the HTTP transport, which is off by default and explicitly "do not
  advertise."
- No test file references `query_eql`/`query_sql`/`get_judge_scores`/`list_datasets`/
  `list_experiments` by name anywhere under `tests/unit/mcp_server/` — these 5 broken
  tools have zero CI coverage, consistent with near-zero real usage rather than being
  load-bearing and merely untested.

This doesn't make the underlying defects fake — they're all real (verified below) —
but it means "P0, drop everything" is the wrong severity label for the MCP-only
findings. The actual blast radius is: external devs who manually wire up their own
`EDEN_API_KEY`/`EDEN_ORG_ID` into Cursor/Claude Code against an unadvertised,
hidden-from-sidebar page. That's real but narrow, not "production-critical."

## IMPACT AUDIT (per tool/finding)

| Finding | Verified? | Real caller? | Actual impact |
|---|---|---|---|
| §0a `rerun_debugger`/`checkpoint_rerun` `live` param dropped | Yes — `client.py` Protocol has no `live` kw, `RerunRequest.live` (`debugger.py:74-82`) unreachable from MCP | External IDE only (soft-retired surface) | Real defect, but "live gateway" rerun via MCP has never worked for any caller since it shipped — no regression, no active user relying on it breaking today. Downgrade P0→P1. |
| §1.A #1 `query_eql`→`/alerts/nl/preview` (no such route) | Confirmed: `tools.py:339-340`; `grep -rn "nl/preview" src/eden/api/` → 0 hits outside tools.py | External IDE only, BUT **the how-to doc's own smoke test tells users to run it**: `mcp-cursor.md:182` — `*"Call `query_eql` with nl_text errors"*`. Anyone following Eden's own onboarding doc hits a guaranteed 404 on the second smoke-test step. | This is the one MCP contract bug with concrete, doc-driven user impact (not just theoretical). Keep at higher priority than the other two broken-path tools, but still not internal-production-P0. |
| §1.A #2 `query_sql`→`/orgs/{org_id}/sql` missing `/execute`, `limit` field doesn't exist on `SqlExecuteRequest` | Confirmed: real route is `sql_query.py:107` `POST /execute`; `SqlExecuteRequest` (`:56-75`) has `sql,params,max_rows,max_seconds`, no `limit` | External IDE only; listed in `mcp-cursor.md:142` table but not in the example-prompts/smoke-test section | Real, 100%-fail-rate bug, but not doc-referenced as a "try this" step the way `query_eql` is. P1. |
| §1.A #3 `get_judge_scores`→`/observability/traces/{id}/scores` (no such route) | Confirmed: real route `judges.py:190` `GET /observability/judges` | External IDE only, listed `mcp-cursor.md:144` table, not in smoke test | Same category as query_sql. P1. |
| §1.B #4/#5 `list_datasets`/`list_experiments` `limit` silently ignored | Confirmed: `datasets_hub.py:71-77`, `experiments_offline.py:34-38` take no `limit`/`Query` param | External IDE only | Low-severity by nature anyway (returns *more* data than requested, not an error) — correctly the doc's own lowest tier. No change needed, but same "soft-retired surface" caveat applies. |
| §2 `ai_agent`/`ai_insights` dual router | Confirmed both mounted: `app.py:226` (`ai_insights.router`), `app.py:229` (`ai_agent.router`) | **Both actively used** — `POST /approve` proxied by `clients/portal/src/app/api/ai-insights/approve/route.ts`; `archiveAiInsightsSession` at `clients/portal/src/lib/api/resources.ts:889-891`; Agent page at `clients/portal/src/app/(portal)/agent/page.tsx` | Unlike the MCP tools above, **this is a live, actively-exercised portal surface, not the retired MCP surface.** The doc's "retiring either today breaks real functionality" conclusion is correctly high-priority and should stay P1 as-is — it's the one finding in this doc grounded in real production (portal) call sites rather than the soft-retired MCP surface. |
| `SOTA-WAVE-TRACKER.md:326` "ai_agent.router unmounted" | Confirmed false: `app.py:229` mounts it; `git diff`/`git diff --cached` on that file show no change to line 326 this pass | Portal-facing doc rot | Genuine, valuable, non-redundant finding. Keep. |
| #10 `resolve_issue` silent status coercion (`agent_issues.py:173`) | Confirmed line-accurate | REST endpoint hit directly by the portal Issues board (`issues-client.tsx`), independent of MCP | This is the one finding in the doc that is NOT gated by MCP's retirement status — it's a live production REST/portal bug. Correctly P0. But see CUT below re: redundancy with bugs/02 Bug 8, which covers this in far more depth (CHECK-constraint mismatch on `"acknowledged"`, portal optimistic-UI silent-failure UX) that 03 omits entirely. |
| #6 `label_tool_call` `agent_id` ownership gap + `tool_call_label_learning_v1` flag gate | Route flag confirmed at `tool_call_labels.py:23`, but `config.py:1228` shows **default `True`** — doc03 doesn't state the default, reads as more gated than it is | Flag is on by default for most orgs | Minor: doc03's phrasing ("every `label_tool_call` MCP call 403/404s outright if that flag is off") is accurate but should note the flag defaults on, so this is not currently blocking most orgs. Low-value nuance, not worth a doc edit, noting for completeness. |

## CUT (quote + reason)

1. > "2. **P0:** Ship the §0a fix — it's now a precise 4-file, ~6-line diff..."
   **Reason:** §0a's `live` param has never worked for any caller since ship (no
   regression), and the only reachable surface is the soft-retired MCP stdio/HTTP
   transport with zero internal callers (see Headline finding). Downgrade to P1 —
   still worth shipping (it's cheap), but not "drop everything."

2. > "3. **P0 (new, from §1.A):** Fix or remove the 3 tools that call nonexistent API
   > paths (`query_eql`→..., `query_sql`→..., `get_judge_scores`→...). These are
   > strictly worse than #0a: every invocation fails today, not just the live-mode
   > path."
   **Reason:** "strictly worse" is true in a narrow technical sense (100% vs. partial
   failure) but misleading as a priority argument — severity should weight blast
   radius, and blast radius here is smaller than #0a's, not larger: these 3 tools sit
   behind the same soft-retired/zero-internal-caller surface, with the single
   exception that `query_eql` is referenced in the how-to doc's smoke test
   (`mcp-cursor.md:182`). Recommend splitting: `query_eql` stays elevated (doc-driven
   user impact), `query_sql`/`get_judge_scores` drop to P1.

3. > "5. **P1 (new, from §1.B):** Either add a real `limit`/pagination param to
   > `datasets_hub.py`'s and `experiments_offline.py`'s list routes, or drop the
   > misleading `limit` property..."
   **Reason:** not a cut, just confirms this one is already correctly triaged below
   the broken-path tools — no change needed.

4. Carried-forward **#10** (`bugs/03` §3, one paragraph, no CHECK-constraint detail)
   is redundant with and strictly less complete than **bugs/02 Bug 8**
   (`docs/specs/strategic-review-2026-08/bugs/02-data-consistency.md:465-535`), which
   additionally proves `"acknowledged"` isn't a legal `agent_issues.status` CHECK-
   constraint value (`db_migrations/versions/136_issue_status_escalated.py:36-38,64`)
   and traces the portal's optimistic-UI silent-failure consequence
   (`issues-client.tsx:499`). **Recommend synthesis keep bugs/02 Bug 8 as the
   canonical writeup and reduce bugs/03's #10 to a one-line cross-reference** rather
   than restating a thinner version as "the single highest-severity finding in this
   file" (`bugs/03-api-mcp-contracts.md:277`) — that framing implies 03 did the
   deepest analysis, when 02 did.

## NEW FINDINGS (not in the doc)

1. **MCP is soft-retired, not first-class, and has zero internal callers** — see
   Headline finding above. This context is absent from the entire doc and should be
   added as a framing note near the top of §1 and §0a, since it's load-bearing for
   every priority call the doc makes about MCP tools specifically (does not apply to
   §2's dual-router finding, which is grounded in live portal usage, or to #10, which
   is a REST/portal bug independent of MCP).
2. **`query_eql` is the one broken-path tool with concrete, doc-driven user impact** —
   Eden's own MCP onboarding doc instructs users to invoke it as smoke-test step 4
   (`docs/docs/how-to/mcp-cursor.md:182`: *"Call `query_eql` with nl_text errors"*),
   guaranteeing a 404 for anyone following the doc verbatim. Worth calling out
   specifically since it's the only one of the 3 broken-path tools with this evidence.
3. **`SOTA-WAVE-TRACKER.md:326`'s "ai_agent.router unmounted" is still false as of this
   pass** — confirmed via `src/eden/api/app.py:229` (mounted) and `git diff --cached`
   on `SOTA-WAVE-TRACKER.md` (line 326 untouched this pass; the file's other pass-4
   edits are unrelated Go/Rust SDK deletion notes at lines ~115/163). Doc03's
   recommendation to fix this stands and is accurate.
4. **`f04-eden-mcp-server.md:9`** feature-doc status line ("Stretch deferred: eql/sql/
   eval tools... Streamable HTTP") is stale — all of those are actually implemented
   (28-tool catalog includes `query_eql`/`query_sql`; `http_transport.py` exists,
   just gated off). Not a contradiction of doc03's findings (doc03 doesn't claim these
   are unimplemented, just broken), but worth a note if F04's status table gets
   touched in this pass by another agent — "stretch deferred" undersells what's
   actually there (broken, not absent).
5. **Zero test coverage** for the 5 tools with real contract defects
   (`query_eql`/`query_sql`/`get_judge_scores`/`list_datasets`/`list_experiments` —
   none appear by name in `tests/unit/mcp_server/*.py`), consistent with the
   near-zero-usage read above rather than "load-bearing but untested."

## Redundancy check against bugs/02-data-consistency.md

- Only one direct overlap found: `resolve_issue` status coercion (03 §3 #10 ≈ 02 Bug
  8) — see CUT #4 above.
- No overlap on the `ai_agent`/`ai_insights` dual-router material, the MCP schema-diff
  sweep, or the `rerun_mode`/`live` bug — 02 does not mention any of these (grep for
  `ai_agent|ai_insights|dual router` across 02 returns zero hits; grep for
  `mcp|query_eql|query_sql|get_judge_scores|rerun_debugger|checkpoint_rerun` returns
  hits only on the shared `resolve_issue` material).
