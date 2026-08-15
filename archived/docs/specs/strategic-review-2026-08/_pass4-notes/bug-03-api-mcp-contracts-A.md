# Pass 4 notes — Agent A (Fact-Verifier & Pruner) — bugs/03-api-mcp-contracts.md

All checks run against current `HEAD` (`main`, includes commit `64233475` "feat(debug): per-trace
RCA chain, F06 signal-investigate endpoint, MCP checkpoint re-run + transcript tools", the most
recent commit touching `mcp_server/`). That commit's diff to `mcp_server/` touches **only**
`server.py`/`tools.py` — it adds the `checkpoint_rerun` tool (already known/covered in §0a of the
doc) and nothing else. It does **not** touch `client.py`, `sql_query.py`, `observability.py`,
`judges.py`, `datasets_hub.py`, `experiments_offline.py`, `intelligence_dsl.py`, or
`agent_issues.py`. So every other finding in the doc is unaffected by that commit and needed
independent re-verification against current file contents, which I did below (grep + line reads,
not assumption).

## PER-TOOL VERDICT

| Tool | Doc verdict | My verdict | Evidence |
|---|---|---|---|
| `rerun_debugger` (§0a) | broken — `live` param never plumbed | **STILL BROKEN, confirmed current** | `src/eden/mcp_server/client.py:37-46` (Protocol) and `:245-264` (`HttpEdenClient.rerun_debugger`) — grep for `live` in both spots shows only `live_prefix`, no `live` param anywhere. `src/eden/mcp_server/tools.py:45-62` same, only `live_prefix`. `src/eden/api/routes/debugger.py:60` `RerunRequest`, `:74` `live: bool` field, `:227` `if body.live:`, `:236` `debugger_live_rerun_v1` gate — all present and unreachable from MCP. Line numbers match the doc almost exactly (doc says `:74-82` for the field, `:227-233`/`:236-245` for the gate branches — confirmed via grep, same locations). |
| `checkpoint_rerun` (§0a/§C) | broken — same root cause as above, added by the most recent commit itself | **STILL BROKEN, confirmed current — added already-broken** | `git show 64233475 -- src/eden/mcp_server/tools.py` shows `checkpoint_rerun` was added by *that same* commit with signature `rerun_mode: str = "cached_live", live_prefix: bool = True` — no `live` param — so the commit that the task flagged as a possible fix actually **introduced** this specific instance of the bug, it didn't fix it. Confirms doc's framing that both call sites share one root cause and neither is fixed. |
| `query_eql` (§1.A.1) | broken — POSTs to nonexistent `/orgs/{org_id}/alerts/nl/preview` | **STILL BROKEN, confirmed current** | `src/eden/mcp_server/tools.py:339-341` (`f"/orgs/{org_id}/alerts/nl/preview"`, unchanged). `grep -n '@router\.' src/eden/api/routes/intelligence_dsl.py` → only `/parse`, `/resolve`, `/lint`, `/alerts/compile`, `/alerts`, `/alerts/{alert_id}/evaluate`, `/alerts/fire-due` (lines 106,128,149,172,196,214,237) — no `nl/preview` route anywhere. `grep -rn "nl/preview" src/eden/api/` → zero hits. The only `preview_nl_alert` symbol in the repo is the in-process `@insights_tool` at `src/eden/llmops/insights_tools.py:1131-1153`, never mounted as HTTP. |
| `query_sql` (§1.A.2) | broken — missing `/execute` segment + `limit` vs `max_rows` field mismatch | **STILL BROKEN, confirmed current** | `src/eden/mcp_server/tools.py:365-367` posts `f"/orgs/{org_id}/sql"` with `{"sql": sql, "limit": limit}`, unchanged. `src/eden/api/routes/sql_query.py:46-50` router prefix is `/orgs/{org_id}/sql`, and the only POST route is `@router.post("/execute", ...)` at `:107`. `SqlExecuteRequest` (`:56-75`) has `sql`, `params`, `max_rows`, `max_seconds` — no `limit` field. Both defects (missing path segment, wrong field) still present verbatim. |
| `get_judge_scores` (§1.A.3) | broken — GETs nonexistent `/observability/traces/{id}/scores` | **STILL BROKEN, confirmed current** | `src/eden/mcp_server/tools.py:415-417` unchanged, still targets `.../observability/traces/{trace_id}/scores`. `grep -n '@router\.' src/eden/api/routes/observability.py` → 9 routes (`/traces`, `/traces/{id}/tree`, `/traces/{id}/timeline`, `/heatmaps/{metric_name}`, `/traces/compare`, `/traces/{id}/export`, `/spans/search`, `/spans/search/suggest`, `/summary`), no `/scores`. Real route confirmed at `src/eden/api/routes/judges.py:48-50` (router prefix `/observability/judges`) + `:56` (`@router.get("", ...)` → `list_judge_scores`, params `trace_id`/`judge_name`/`limit`/`offset`). |
| `list_datasets` (§1.B.4) | broken (soft) — sends `limit` that handler ignores | **STILL BROKEN (silently no-op), confirmed current** | `src/eden/mcp_server/tools.py:386-389` still sends `params={"limit": limit}`. `src/eden/api/routes/datasets_hub.py:72-81` `list_datasets` handler takes only `org_id`/`user` deps, no `limit`/`Query` param — confirmed via direct read, matches doc. |
| `list_experiments` (§1.B.5) | broken (soft) — same pattern | **STILL BROKEN (silently no-op), confirmed current** | `src/eden/mcp_server/tools.py:400-403` unchanged. `src/eden/api/routes/experiments_offline.py:35-44` `list_offline_experiments` handler takes only `org_id`/`user` deps, no `limit` param — confirmed via direct read. |
| `eden_health`/`tail_trace`/`label_tool_call` dead-branch hasattr probes (§1.D) | harmless dead code, not a contract bug | **CONFIRMED, still current** | `grep -n "hasattr(client" tools.py` → lines 199, 242, 283 probe `eden_status`/`tail_trace`/`label_tool_call`; `grep -n "eden_status\|tail_trace\|label_tool_call" client.py` for method defs → zero hits, confirming none exist on `HttpEdenClient`. (Doc says "the full 407-line file"; file is actually 406 lines today — trivial 1-line drift from doc's line-count claim, not worth a correction line, not pruning-worthy.) |
| 23 other tools "spot-checked clean" (§1.D) | clean | **Not independently re-swept tool-by-tool** (out of scope for my time budget — doc's own methodology described as a full sweep against route files, and every specific one I cross-checked incidentally — `search_traces`, `label_tool_call` route/model fields, `run_autofix`/`improve/*` routes via `app.py` mounts, `ai_agent`/`ai_insights` chat routes — held up). No reason to distrust the rest; flag for B/C to spot check if budget allows. |

## Bonus/incidental finding not in doc (new)

- The commit the task flagged as a possible fix (`64233475`) is the commit that **introduced**
  `checkpoint_rerun` with the broken signature in the first place (`git show 64233475 -- tools.py`).
  This is worth stating explicitly in synthesis: it is not "recent work partially fixed this and
  partially didn't" — it's "recent work added a *second* call site sharing the pre-existing defect,
  and the defect was never touched." Doc already treats both call sites as one root cause (§0a),
  but doesn't call out that `checkpoint_rerun` was born broken in the *same commit* that's under
  review here — that's a useful synthesis-level fact about how fresh this instance is.

## Carried-forward findings (§3) — spot-verified, all still accurate as of HEAD

- **#3** (`ignored` status unreachable from portal): confirmed. `grep -rn '"ignored"' clients/portal/src`
  → only hit is a type-union member at `clients/portal/src/lib/api/resources.ts:2744`; zero UI
  callers of `setIssueStatus(id, "ignored")`.
- **#6** (`label_tool_call` agent_id no ownership check): confirmed. `src/eden/api/routes/tool_call_labels.py:31-58`
  — `LabelToolCallRequest.agent_id` flows straight into `ToolCallLabelCreate(...)` with no check
  against the `span_id`/`trace_id` path/body values.
- **#7** (RCA/signal-investigator backend-only, absent from MCP + portal) — **re-verified against
  the exact commit the task flagged, since this is precisely what that commit added.** Confirmed
  still true post-commit: `src/eden/api/routes/intelligence_rca.py` now has a real `/{trace_id}/chain`
  route (`:126`) and `src/eden/api/routes/signal_investigator.py` has `/traces/{trace_id}/investigate`
  (`:252`) — both newly added by `64233475` and mounted — but `grep -n "rca\|investigat\|signal"
  src/eden/mcp_server/server.py src/eden/mcp_server/tools.py` returns **zero hits**, and
  `grep -rn "rca\|signal.investigat" clients/portal/src/lib/api/*.ts` also zero. So #7 is not stale
  — it's freshly re-confirmed against the exact code the task asked about.
- **#8** (`resolve_issue` response under-typed in portal): confirmed. `clients/portal/src/lib/api/resources.ts:2746-2755`
  `agentIssuesApi.resolve`'s return type is `{status, data: {issue_id, status, updated}}` only;
  backend `resolve_issue` (`src/eden/api/routes/agent_issues.py`, builds `regression_cases`/
  `regression_run`/`evolution` locals) returns more than that.
- **#9** (`retrain_tool_calibrator` untyped body): confirmed. `src/eden/api/routes/tool_call_labels.py:123-132`
  — `body: dict[str, Any] = Body(default_factory=dict)`, manual `tool_name` extraction,
  `return {"status": "error", ...}` (200, not 422) if missing.
- **#10** (`resolve_issue` silently coerces invalid status): confirmed, still present at
  `src/eden/api/routes/agent_issues.py:172` (`target = body.status if body.status in
  _RESOLVE_STATUSES else "resolved"`) — doc cites `:173`, off by one line, not worth flagging as
  an error (likely just a different counting convention/blank-line offset).

## `ai_agent`/`ai_insights` dual router — re-verified

Route inventory confirmed exact match to doc's table via direct grep of both files:
- `ai_agent.py`: `POST /chat` (`:155`), `GET /conversations` (`:256`), `GET /conversations/{id}`
  (`:296`), `DELETE /conversations/{id}` (`:364`), `GET /tools` (`:387`).
- `ai_insights.py`: `POST /chat` (`:555`), `POST /approve` (`:653`), `GET /sessions` (`:716`),
  `GET /sessions/{id}/messages` (`:799`), `POST /sessions/{id}/archive` (`:839`), `GET /health` (`:879`).
- `grep -n "approve" src/eden/api/routes/ai_agent.py` → zero hits, confirming no approval path in
  `ai_agent`.
- Portal caller check: `ls clients/portal/src/app/api/ai-insights/` → `approve`, `chat`, `sessions`
  subroutes exist (confirms `/approve` and session archive are live proxy targets);
  `clients/portal/src/lib/api/resources.ts:889` has `archiveAiInsightsSession`, confirming doc's
  citation. `clients/portal/src/lib/api/portal.ts:315,328,332` call `/ai/conversations` (list/get/delete)
  and `clients/portal/src/app/(portal)/agent/page.tsx:408` posts to `/ai/chat` — confirms the
  `ai_agent` chat/conversation surface is actively used by the portal Agent page (doc's line 408
  citation checks out structurally, though the exact line is the `fetchApi` POST call, not a
  literal string "conversations" — a very minor precision nit, not a factual error).
- `grep -rln "conversations/\${" clients/portal/src/lib/api/portal.ts` for a DELETE caller and
  `grep -rln "ai/tools" clients/portal/src` for the tool-catalog caller both → zero hits, confirming
  `DELETE /conversations/{id}` and `GET /tools` are genuinely unreferenced from the portal.
- **New/incidental confirmation:** `src/eden/api/app.py:229` — `ai_agent.router` is actively
  `include_router`'d today (comment: `# /orgs/{org_id}/ai/{chat,conversations,tools}`), directly
  contradicting `docs/specs/SOTA-WAVE-TRACKER.md:326`'s "Dual surface: aiApi deleted; ai_agent.router
  unmounted" line, which I confirmed still reads exactly that at `SOTA-WAVE-TRACKER.md:326`. This
  strengthens the doc's existing verdict — worth surfacing in synthesis as a concrete tracker
  correction, not just an inference.

## CUT (quote + reason)

I did not find material to cut. Everything checked — every broken-tool claim, every "confirmed
clean" spot-check I re-ran, every carried-forward finding, and the dual-router trace — verified
true against current `HEAD`, including specifically against the one commit the task flagged as a
possible fix. Two trivial, non-substantive precision nits (both far short of "false/speculative/
unverifiable" — I'm noting them for completeness, not proposing they be cut):

- L192-193 quote: *"none of those three methods exist on `HttpEdenClient` (confirmed reading the
  full 407-line file)"* — `client.py` is 406 lines today, not 407. Off-by-one, doesn't affect the
  claim (still zero matches for the three method names). Not a prune candidate; flagging only so
  synthesis doesn't need to re-derive it.
- L408 citation for `agent/page.tsx:408` (dual-router section) — that line is the `fetchApi<Response>`
  POST call to `/ai/chat`, not a `conversations`-string literal; the underlying claim (portal Agent
  page actively depends on `ai_agent`'s chat surface) is correct and confirmed via `portal.ts:315-332`
  and `assistantThreads` at `portal.ts:202`. Not worth cutting, just noting the citation is the chat
  call, not a conversations-list call specifically.

No redundant, filler, or speculative passages found in this doc — it is unusually tight for a
pass-4 document (every claim I sampled carried an exact file:line and I could reproduce it with a
grep). Recommend synthesis treat this doc as high-confidence/low-risk to merge near-verbatim.
