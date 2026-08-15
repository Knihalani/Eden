# Pass 4 adversarial review — Agent C — bugs/03-api-mcp-contracts.md

Verified every citation in the doc against `HEAD` (commit `64233475`) via direct file reads,
`git log`/`git show` on `src/eden/mcp_server/*` and the API route files it references. **Verdict:
the doc holds up almost entirely — no stale-by-recent-commit claims found, and every line
number/field/route I spot-checked matched exactly.** This is unusually well-verified for a pass-4
doc. My contribution is narrow: confirm non-staleness with git evidence, flag one real cross-doc
duplication, and trim a couple of soft/filler passages.

## STALENESS CHECK RESULTS (primary adversarial angle)

**Target commit:** `64233475` "feat(debug): per-trace RCA chain, F06 signal-investigate endpoint,
MCP checkpoint re-run + transcript tools" (2026-08-04, immediately prior to this pass).

- `git show --stat 64233475 -- src/eden/mcp_server/` → touches only `server.py` (+29) and
  `tools.py` (+30). **`client.py` is untouched by this commit** (`git show 64233475 --
  src/eden/mcp_server/client.py` returns empty diff).
- The commit's only `mcp_server` change is **adding** the `checkpoint_rerun` tool (new function,
  new catalog entry, new `_HANDLERS` registration) — it does not touch `rerun_debugger`, the
  `EdenApiClient` Protocol, or `HttpEdenClient.rerun_debugger`.
- Confirmed at HEAD: `client.py:37-46` (Protocol) and `client.py:245-264` (`HttpEdenClient` impl)
  still have **no `live` parameter anywhere** — exact match to the doc's claim, exact match to
  the doc's line numbers.
- **Conclusion: the §0a `rerun_mode`/`live` bug is NOT fixed by the recent commit — if anything
  the commit made the doc's finding more urgent**, since it added a *second* call site
  (`checkpoint_rerun`, `tools.py:470-497`, exactly as the doc states) sharing the exact same
  unfixed choke point. This is the opposite of stale: the doc's framing ("both call sites share
  one root cause, defaulting `checkpoint_rerun`'s `live` to `False` not `True`") is *more*
  correct post-commit than it would have been pre-commit, since `checkpoint_rerun` didn't exist
  before this commit.
- Cross-checked the new test file the commit added,
  `tests/unit/mcp_server/test_checkpoint_rerun_and_transcript.py`: it mocks
  `client.rerun_debugger` directly via `_FakeClient`, never exercises `HttpEdenClient`'s real HTTP
  body construction, and never touches `debugger.py`'s `RerunRequest`/`live` field at all. This
  **confirms** (doesn't just corroborate) the doc's claim at line 96-99 that "the current test
  only pins the MCP-tool→client-Protocol call tuple, one layer above where the bug lives." Good,
  precise, non-stale.
- Also checked: the commit's own docstring for `checkpoint_rerun` even says `rerun_mode` values
  are `"cached_live"`/`"replay"` and never mentions `live` — the new code shipped in this very
  commit reproduces the doc's exact criticism (a `rerun_mode` that reaches nothing server-side)
  rather than fixing it. No staleness anywhere in §0a.
- Minor, non-bug observation: the commit message says "...transcript tools" (plural, implying
  new), but `get_transcript` was **not** added by this commit — `git log -S'"get_transcript"' --
  server.py` shows it first appears in `0ac41eb7` (an old commit), and the new test file's own
  docstring says "``get_transcript`` was already shipped; we assert it stays registered." This is
  a minor overclaim in the *commit message*, not something the doc under review says, so it's not
  a doc bug — noting only because it was the thing I was sent to specifically rule in/out.

### Per-claim verification table (HEAD, this pass)

| Claim | File:line in doc | Verified? |
|---|---|---|
| `rerun_debugger` tool | `tools.py:45-62` | Exact match |
| `checkpoint_rerun` tool | `tools.py:470-497` | Exact match (`def` at 470) |
| Protocol missing `live` | `client.py:37-46` | Exact match, still true at HEAD |
| `HttpEdenClient.rerun_debugger` missing `live` | `client.py:245-264` | Exact match, still true |
| `RerunRequest` fields / no `rerun_mode` | `debugger.py:60-93` | Exact — fields are `trace_id, from_step, prompt_override, live_prefix, live, tool_result_override, session_id`; no `rerun_mode` |
| `live` field | `debugger.py:74-82`(ish) | `live: bool = Field(...)` starts at line 74, class ends 92/93 |
| `live_gateway` branch | `debugger.py:227-233` | `if body.live:` at 227, `rerun_mode = "live_gateway"` at 228 |
| `debugger_live_rerun_v1` gate | `debugger.py:233-245` | `if body.live:` (2nd) at 233, flag check at 236, 403 at 240 |
| `AddDebugRunRequest.rerun_mode` distinct model | `debugger.py:108` | Exact — different class (`AddDebugRunRequest`), confirmed distinct from `RerunRequest` |
| Tool catalog count 28 not 29 | `server.py` | Confirmed: `grep -c '"name":'` = 29, but line 512 is `"name": t["name"]` (list-comprehension), `_HANDLERS` has exactly 28 `tool_fns.` bindings |
| `query_eql` → `/alerts/nl/preview`, no such route | `tools.py:324-353`,`server.py:379-391` | Exact line match; route confirmed absent from `intelligence_dsl.py` |
| `query_sql` → `/sql` missing `/execute`, `limit` not a real field | `tools.py:356-376` | Exact; `sql_query.py` router prefix `/orgs/{org_id}/sql`, route is `POST /execute`; `SqlExecuteRequest` fields are `sql, params, max_rows, max_seconds` — no `limit` |
| `get_judge_scores` → `.../scores`, no such route | `tools.py:407-426` | Exact; real route is `GET /observability/judges` (`judges.py:190-199`), prefix at `judges.py:48` |
| `list_datasets` `limit` param ignored | `tools.py:379-390`,`datasets_hub.py:71-81`(72 exact) | Exact — handler takes only `org_id`/`user` deps |
| `list_experiments` `limit` param ignored | `tools.py:393-404`,`experiments_offline.py:34-38`(35 exact) | Exact — same pattern |
| `label_tool_call` flag gate | `tool_call_labels.py:23` | Exact — `require_feature_flag("tool_call_label_learning_v1")` in router deps |
| `ai_insights` routes: `/approve`, `/sessions`, `/sessions/{id}/messages`, `/sessions/{id}/archive`, `/health` | `ai_insights.py:653,716,799,839,879` | All 5 line numbers exact |
| `ai_agent` routes: `DELETE /conversations/{id}`, `GET /tools` | `ai_agent.py:364,387` | Both exact |
| `resources.ts:889-891` archive caller | `resources.ts` | Exact — `archiveAiInsightsSession` at that location, POSTs to `.../archive` |
| Zero portal callers for `DELETE /conversations` and `GET /tools` | grep | Confirmed zero hits for both |
| `agent/page.tsx` calls `/ai/chat` | `agent/page.tsx:408`(ish) | Confirmed — `fetchApi` POST to `${orgId}/ai/chat` in the fetch block starting ~line 407 |
| `app.py:229` mounts `ai_agent.router`, not unmounted | `app.py:229` | Exact — `("eden.api.routes.ai_agent", "router")` present, contradicts `SOTA-WAVE-TRACKER.md:326` |
| `resolve_issue` status coercion (carried-forward #10) | `agent_issues.py:173` | Confirmed still present: `target = body.status if body.status in _RESOLVE_STATUSES else "resolved"` |

No claim in the doc was found to be false, stale, or fixed by the recent commit. This is the
strongest-surviving of the three bug docs I'd expect on an adversarial pass — the line-number
discipline is real, not decorative.

## CUT

1. Quote: *"This is genuinely minimal: 4 files, ~6 lines of new code, no new tests needed beyond
   extending `test_checkpoint_rerun_and_transcript.py`..."* (lines 96-99).
   Reason: mild filler/self-congratulation rather than a finding — it doesn't add verifiable
   information beyond what §0a's diff already shows, and "genuinely minimal" is an editorial
   aside. Not false, just prunable padding; synthesis can drop the sentence without losing
   content.

2. Section header framing: *"§2. `ai_agent`/`ai_insights` dual router — unique-functionality
   trace"* substantially overlaps `bugs/01-dead-code-stale-docs.md` findings **#11** and **#13** in
   the same pass, which already establish (with the same `app.py:228-229`/`:226`/`:329` evidence
   and the same exact `SOTA-WAVE-TRACKER.md:326` quote) that "unmounted" is false and both routers
   are live simultaneously. **Do not cut the finding** — 03's contribution (full endpoint
   inventory, tracing which routes have zero portal callers, and the retirement-safety verdict)
   is genuinely new content 01 does not cover — but the ~6 lines re-establishing "both routers are
   mounted, contradicting the tracker" (doc lines 243-245, "Verdict: retiring either router today
   ... is not a safe same-day cleanup" intro) are redundant scaffolding that could just cite
   `01-dead-code-stale-docs.md` finding #13 instead of re-deriving the mount evidence from
   scratch. Flag for synthesis to de-duplicate/cross-reference rather than let both docs carry the
   full `app.py` mount citation independently.

3. Quote: *"harmless (falls through correctly to `get`/`post`) but worth cleaning up as a
   readability nit, not a contract bug"* (lines 194-195, re: `hasattr(client, ...)` dead branches).
   Reason: doc itself labels this a non-bug nit; keep the observation (it's accurate — confirmed
   none of `eden_status`/`tail_trace`/`label_tool_call` exist on `HttpEdenClient` via grep) but it
   doesn't need its own bullet weight in a synthesis doc focused on contract bugs — recommend
   folding into the carried-forward #5 Protocol-coverage item rather than standalone real estate.

Nothing else warranted a CUT — the doc is unusually clean of speculation; nearly every sentence
is backed by a specific file:line citation that checked out on independent re-verification.

## NEW FINDINGS (mine, from adversarial pass)

1. **The recent commit `64233475` actively reproduces rather than fixes the §0a bug pattern.**
   It added a brand-new MCP tool (`checkpoint_rerun`) through the exact same broken
   `EdenApiClient.rerun_debugger` choke point, with a `rerun_mode` enum (`"cached_live"`/
   `"replay"`) in both the tool docstring (`tools.py:480-488`) and the new `server.py` schema
   (`server.py` diff, `"enum": ["cached_live", "replay"]`) that — per the doc's own confirmed
   finding — maps to nothing on `RerunRequest` server-side. Worth stating explicitly in synthesis:
   this is evidence the bug is *actively getting worse*, not that pass 4 caught something already
   fixed. Useful ammunition for bumping priority, not lowering it.

2. **The new commit's test file corroborates the doc's testing-gap claim verbatim.**
   `tests/unit/mcp_server/test_checkpoint_rerun_and_transcript.py`'s `_FakeClient.rerun_debugger`
   mock accepts and echoes back `rerun_mode` (never `live`) and the assertions
   (`test_checkpoint_rerun_uses_live_path_and_returns_stats`) only check the mocked call tuple
   `("rerun", "org-1", "t1", 2, "cached_live", True)` — no `live` value asserted anywhere, because
   the parameter doesn't exist on the client method being mocked. This is a second, independent
   confirmation (beyond static reading) that the "6 lines of test debt" gap the doc names is real
   and shipped, not hypothetical.

3. **Commit-message overclaim (adjacent, not in the doc under review):** `64233475`'s message
   claims "...MCP checkpoint re-run + transcript tools," but `get_transcript` predates this
   commit by several releases (first appears in `0ac41eb7`, confirmed via
   `git log -S'"get_transcript"'`). Not a bug in `03-api-mcp-contracts.md` (which doesn't make
   this claim), but worth a heads-up to synthesis/pass-owner since the task specifically asked to
   check whether this commit's stated scope matches reality — it's a minor commit-message
   inaccuracy, unrelated to the doc's own correctness.

## Summary verdict

`bugs/03-api-mcp-contracts.md` survives adversarial review essentially intact. Zero claims were
falsified, zero were found stale-by-recent-commit (the one plausibly-relevant recent commit,
`64233475`, left every cited line untouched except to add a second instance of the same bug).
The only actionable pruning is (a) drop the self-congratulatory "genuinely minimal" aside, (b)
cross-reference rather than re-derive the `ai_agent`/`ai_insights` mount evidence already fully
established in `bugs/01-dead-code-stale-docs.md` #11/#13, and (c) fold the dead
`hasattr(client, ...)` nit into the existing carried-forward Protocol-coverage item instead of
giving it separate weight.
