# Bug hunt: API / MCP contract mismatches

**Directive (pass 4):** don't restate prior passes — go deeper. (1) Produce an exact, diff-level
minimal fix for the `rerun_mode`/`live` bug covering *both* MCP call sites
(`rerun_debugger` and `checkpoint_rerun`). (2) Run an exhaustive, tool-by-tool schema-diff sweep
of all MCP tools in `server.py`/`tools.py` against the real API route models they call, looking
for *any other* silently-dropped or silently-ignored field. (3) For the `ai_agent`/`ai_insights`
dual router, trace exactly what unique functionality lives in each, to determine whether retiring
one is actually safe.

All line numbers verified against `HEAD` this pass.

## Framing note: MCP is soft-retired — read before the priority list

**Eden's MCP server is officially soft-retired for the free beta, with zero internal callers.**
This context is load-bearing for every priority call this doc makes about MCP-specific tool
findings (§0a, §1) — it is **not** relevant to #10 (`resolve_issue`, a REST/portal bug independent
of MCP) or to §2 (`ai_agent`/`ai_insights`, grounded in live portal usage), whose severities are
unaffected. Confirmed directly this pass:

- `docs/docs/how-to/mcp-cursor.md:1-15` — `draft: true`, sidebar label "MCP in Cursor (retired)",
  banner: *"Soft-retired for free beta (2026-07-31). Eden MCP is not a first-class product surface.
  HTTP transport and org MCP key routes are off/unmounted. ... Prefer the portal debugger, improve
  cockpit, and REST APIs."*
- `src/eden/api/app.py:210-212` — the Streamable HTTP MCP router mount is commented `# Soft-retired
  for free beta (F04): ... stays behind mcp_http_transport_v1=False inside the router. Do not
  advertise.`
- `src/eden/config.py:1259` — `mcp_http_transport_v1: bool = False` (off by default).
- Repo-wide grep for internal importers of `eden.mcp_server.tools`/`.client` outside
  `src/eden/mcp_server/` itself returns zero hits — none of Eden's own agent workflows
  (`improvement/`, `autonomous/`, `closed_loop/`, `nudges/`, ...) invoke any MCP tool. The only
  reachable consumer is an external developer's IDE (Cursor/Claude Code) over stdio, against a
  page that is `draft: true` and hidden from the docs sidebar.
- None of the 5 broken tools found in §1 (`query_eql`/`query_sql`/`get_judge_scores`/
  `list_datasets`/`list_experiments`) are referenced by name anywhere under
  `tests/unit/mcp_server/*.py` — zero CI coverage, consistent with near-zero real usage rather than
  "load-bearing but untested."

This doesn't make the underlying defects fake — every one is a real, reproducible contract bug —
but it means "P0, drop everything" overstates the real-world blast radius for the MCP-only
findings. The priority list below has been revised accordingly: MCP-only findings are downgraded
P0→P1 (one exception — see §1.A's `query_eql` note), while #10 and §2, which don't depend on MCP
being live, retain their original severity.

## 0a. `rerun_mode`/`live` bug — exact minimal fix, both call sites

**Both MCP call sites are thin wrappers over the same single choke point**, so the fix is one
change, not two:

- `rerun_debugger` (`tools.py:45-62`) calls `client.rerun_debugger(org_id, trace_id=..., from_step=...,
  prompt_override=..., rerun_mode=..., live_prefix=...)`.
- `checkpoint_rerun` (`tools.py:470-497`) calls the **identical** `client.rerun_debugger(...)` with
  the same five keyword args, just different defaults (`rerun_mode="cached_live"`,
  `live_prefix=True` vs. `None`/`None`).

Neither tools.py function, nor the `EdenApiClient` Protocol (`client.py:37-46`), nor
`HttpEdenClient.rerun_debugger` (`client.py:245-264`) has a `live` parameter anywhere. `RerunRequest`
(`debugger.py:60-93`) *does* have a `live: bool = False` field (`:74-82`) — it's real and it's the
only field that reaches the `live_gateway` branch (`debugger.py:227-233`: `if body.live: rerun_mode =
"live_gateway"`, then the `debugger_live_rerun_v1` gate at `:233-245`). It is simply never populated
from MCP. (The `rerun_mode` field the MCP schema advertises does not exist on `RerunRequest` at
all — confirmed no such field in `debugger.py:60-93`; Pydantic v2 default `extra="ignore"` drops it
silently. `AddDebugRunRequest.rerun_mode` at `debugger.py:108` is an unrelated model for a different
endpoint — a naming coincidence, not the same field.)

**Exact diff, 4 files:**

1. `src/eden/mcp_server/client.py:37-46` (Protocol) — add one parameter:
   ```python
   async def rerun_debugger(
       self, org_id: str, *, trace_id: str, from_step: int = 0,
       prompt_override: str | None = None, rerun_mode: str | None = None,
       live_prefix: bool | None = None,
       live: bool | None = None,          # NEW
   ) -> dict[str, Any]: ...
   ```

2. `src/eden/mcp_server/client.py:245-264` (`HttpEdenClient.rerun_debugger`) — same new parameter,
   plus the one missing body line:
   ```python
   async def rerun_debugger(self, org_id, *, trace_id, from_step=0, prompt_override=None,
                             rerun_mode=None, live_prefix=None, live=None):  # NEW param
       body = {"trace_id": trace_id, "from_step": from_step}
       ...
       if live_prefix is not None:
           body["live_prefix"] = live_prefix
       if live is not None:               # NEW — the one missing mapping
           body["live"] = live            # NEW
       return await self._request("POST", f"/orgs/{org_id}/debugger/rerun", json_body=body)
   ```
   This one hunk fixes the HTTP body for **both** callers, since both go through this method.

3. `src/eden/mcp_server/tools.py:45-62` (`rerun_debugger` tool) — plumb the new kwarg through,
   default `None` (no behavior change for existing callers who don't pass it):
   ```python
   async def rerun_debugger(client, org_id, *, trace_id, from_step=0, prompt_override=None,
                             rerun_mode=None, live_prefix=None, live: bool | None = None):  # NEW
       return await client.rerun_debugger(org_id, trace_id=trace_id, from_step=from_step,
           prompt_override=prompt_override, rerun_mode=rerun_mode, live_prefix=live_prefix,
           live=live)  # NEW
   ```

4. `src/eden/mcp_server/tools.py:470-497` (`checkpoint_rerun` tool) — same plumb-through, but
   default **`live: bool = False`**, not `True`. Even though this tool's docstring/name claim the
   "F01 live path," defaulting `live=True` would silently start billing/invoking a real model on
   every unqualified call — the honest fix is to require the caller to opt in explicitly, matching
   the server's own "honest, not silent" 403-over-silent-downgrade posture at `debugger.py:236-245`:
   ```python
   async def checkpoint_rerun(client, org_id, *, trace_id, from_step=0, prompt_override=None,
                               rerun_mode="cached_live", live_prefix=True,
                               live: bool = False):  # NEW — explicit opt-in required
       return await client.rerun_debugger(org_id, trace_id=trace_id, from_step=from_step,
           prompt_override=prompt_override, rerun_mode=rerun_mode, live_prefix=live_prefix,
           live=live)  # NEW
   ```

5. `server.py:108-135` and `server.py:137-163` (both tools' `inputSchema.properties`) — add
   `"live": {"type": "boolean", "description": "Actually invoke the model on the mutated tail step
   (F01 live gateway); requires debugger_live_rerun_v1. Defaults false — never silently billed."}`
   to both. Also fix the misleading `rerun_mode` enum/description at `server.py:123-127,151-155`:
   it currently claims `cached_line`/`replay` are the only two modes and never mentions that real
   "live" requires the separate `live` boolean — today there is **no value of `rerun_mode` that
   reaches `live_gateway`** even after fix #1-4, because `rerun_mode` isn't a real server field at
   all. Either drop the fictitious `rerun_mode` enum from both schemas (it does nothing server-side)
   or keep it purely as a client-side alias that tools.py translates into `live`/`live_prefix`, but
   don't leave it implying it's forwarded to the API when it silently isn't.

4 files, ~6 lines of new code; extend `test_checkpoint_rerun_and_transcript.py` to assert on the
real HTTP body (or add an `httpx`-mocked/integration test hitting `debugger.py` directly), since
the current test only pins the MCP-tool→client-Protocol call tuple, one layer above where the bug
lives.

**Note on freshness:** `checkpoint_rerun` was added by the most recent `mcp_server`-touching commit
(`64233475`, "MCP checkpoint re-run + transcript tools") — with the broken signature
(`rerun_mode="cached_live"`, no `live` param) already in place. That commit didn't partially fix
this bug; it added a second call site that reproduces the exact same defect through the same
choke point. The test file it shipped (`test_checkpoint_rerun_and_transcript.py`) mocks
`client.rerun_debugger` directly and never asserts a `live` value, confirming the testing gap is
real and shipped, not hypothetical.

## 1. Full schema-diff sweep — all 28 MCP tools, path + field level

**Correction to the prior pass's tool count:** `TOOL_CATALOG` has **28** entries, not 29.
`grep -n '"name":' server.py` returns 29 lines, but the 29th (`server.py:512`) is
`"name": t["name"]` inside `list_tools()`'s dict-comprehension formatter — not a catalog entry. The
prior pass's `grep -c` was unscoped and counted it. `_HANDLERS` (`server.py:475-502`) has 28
entries and is a clean 1:1 match with the (actually-28) catalog names. The 1:1-dispatch conclusion
itself still holds; only the headline number was wrong.

Swept every tool's `tools.py` implementation against the live-path branch (typed `EdenApiClient`
Protocol method in `client.py`, or the hardcoded `client.get`/`client.post` path string in
`tools.py` for the 10 untyped tools) and then against the actual FastAPI route file. Result:

### A. Tool calls a path that does not exist on any router — guaranteed failure in production (3 found, none previously flagged)

1. **`query_eql`** (`tools.py:324-353`) posts to `f"/orgs/{org_id}/alerts/nl/preview"`
   (`tools.py:339-340`, schema `server.py:379-391`). No route matches. `intelligence_dsl.py`'s
   router (the only one owning `.../alerts*` under this prefix) has exactly 7 routes: `/parse`,
   `/resolve`, `/lint`, `/alerts/compile`, `/alerts`, `/alerts/{alert_id}/evaluate`,
   `/alerts/fire-due` (confirmed via outline, `intelligence_dsl.py:106-238`) — no `/alerts/nl` or
   `/alerts/nl/preview` anywhere. `grep -rn "nl/preview" src/eden/api/` → zero hits outside
   `tools.py` itself. The docstring's claimed sibling, `preview_nl_alert`
   (`src/eden/llmops/insights_tools.py:1131-1133`), is an **in-process LLM-agent tool** (decorated
   `@insights_tool`, called directly by the insights chat agent, never mounted as an HTTP route) —
   not a REST endpoint the MCP client could ever reach. `HttpEdenClient.post` (`client.py:193-204`)
   → `_request` (`:145-173`) returns a normal `{"status": "error", "http_status": 404, ...}` dict
   for this (no exception raised), so every real invocation of this tool returns a 404 error body,
   always. **Concrete, doc-driven impact** (the one exception to the soft-retirement blast-radius
   discount in the framing note above): Eden's own MCP onboarding doc instructs users to invoke this
   tool as its smoke test — `docs/docs/how-to/mcp-cursor.md:182`, *"Call `query_eql` with nl_text
   errors"* — so anyone following that doc verbatim hits a guaranteed 404 on the second smoke-test
   step. This is the one broken-path tool with real (if narrow), not just theoretical, user impact.

2. **`query_sql`** (`tools.py:356-376`) posts to `f"/orgs/{org_id}/sql"` (`tools.py:365-366`,
   schema `server.py:393-405`). The real route is `POST /orgs/{org_id}/sql/execute`
   (`sql_query.py:46-50` router prefix `/orgs/{org_id}/sql`, `:107-117` route `"/execute"`) — the
   MCP client is missing the `/execute` segment entirely. Also a field-level bug even if the path
   were fixed: MCP sends `{"sql": sql, "limit": limit}` (`tools.py:367`), but `SqlExecuteRequest`
   (`sql_query.py:56-75`) has fields `sql`, `params: dict`, `max_rows`, `max_seconds` — **there is
   no `limit` field**. The one filter MCP's schema documents and sends (`server.py:401`, `"limit":
   {"type": "integer"}`) would be silently dropped by `extra="ignore"` even after the path fix, and
   the two real caps (`max_rows`, `max_seconds`) and the `params` bind-variables field are
   unreachable from MCP at all.

3. **`get_judge_scores`** (`tools.py:407-426`) gets `f"/orgs/{org_id}/observability/traces/{trace_id}/scores"`
   (`tools.py:415-417`, schema `server.py:433-444`). No such route. `observability.py` (the router
   that owns `/orgs/{org_id}/observability/traces/...`) has no `/scores` sub-route at all
   (confirmed via outline: `/traces`, `/traces/{trace_id}/tree`, `/traces/{trace_id}/timeline`,
   `/heatmaps/{metric}`, `/traces/compare`, `/traces/{trace_id}/export`, `/spans/search`,
   `/spans/search/suggest`, `/summary` — nothing scores-related). The real endpoint is
   `GET /orgs/{org_id}/observability/judges?trace_id=...&judge_name=...&limit=...&offset=...`
   (`judges.py:48-52` prefix `/observability/judges`, `:190-199` `list_judge_scores` signature).
   The `try/except` in `tools.py:414-419` doesn't help — `_request` returns the 404 as a normal
   dict, not an exception, so this always returns the raw `{"status": "error", "http_status": 404}`
   payload rather than either real scores or the intended `{"scores": []}` stub.

### B. Tool declares a filter param the underlying GET route doesn't accept — silently ignored server-side, not an error (2 found, same pattern twice)

4. **`list_datasets`** (`tools.py:379-390`) sends `params={"limit": limit}` (`:388`) to
   `GET /orgs/{org_id}/datasets`. `list_datasets` in `datasets_hub.py:71-81` takes only
   `org_id`/`user` deps — no `limit`/`Query` param exists on the handler at all. FastAPI silently
   ignores unbound query params (no 422), so `limit` has zero effect: the route always returns
   every dataset for the org via `hub.list_datasets(org_id)` with no cap, regardless of what the
   MCP caller requested.

5. **`list_experiments`** (`tools.py:393-404`) sends `params={"limit": limit}` (`:402`) to
   `GET /orgs/{org_id}/experiments/offline`. Identical pattern: `list_offline_experiments`
   (`experiments_offline.py:34-38`) takes only `org_id`/`user` deps, no `limit` param declared —
   silently ignored, always returns the full unbounded list.

### C. `rerun_debugger`/`checkpoint_rerun` `live` field — see §0a (the one previously-known instance, now with the exact fix; both call sites share one root cause)

### D. Spot-checked and confirmed clean (path + field parity holds)

`search_traces`→`/observability/traces` (`observability.py:323-324`), `get_trace`→
`/observability/traces/{id}/tree` (`:601-602`), `get_transcript`→`.../timeline` (`:633-634`),
`list_checkpoints`→`/debugger/checkpoints/{trace_id}`, `search_issues`/`get_issue`/`triage_issue`/
`export_fixture`/`create_regression_case`→`agent-issues.py` routes (`:132,150,237,414,485` — all
present, `create_regression_case`'s `{max_traces, auto}` body matches `RegressionCaseRequest`
exactly at `agent_issues.py:489,494`), `run_autofix`→`/improve/autofix/{issue_id}`
(`improve.py:369`), `get_improvement_queue`/`list_improvement_plans`/`get_improvement_plan`/
`approve_improvement_plan`→`/improve/{queue,plans,plans/{id},plans/{id}/approve}`
(`improve.py:97,106,124,162` — all present), `preview_change_impact`→`/change-impact/preview`
(route file present), `eden_health`→`/admin/eden-status` (`admin_status.py:133-134`,
`org_id`-only, matches), `get_cost_breakdown`→`/finops/explorer` (`finops.py:46-50`, `window_hours`
only, matches exactly), `get_agentic_metrics`→`/agentic-metrics/summary`
(`agentic_metrics.py:33-38`, `agent_id`+`window_hours`, matches exactly), `label_tool_call`→
`POST /tool-calls/{span_id}/label` (`tool_call_labels.py:31-37,40-46` — `LabelToolCallRequest`
fields `trace_id, tool_name, label, reason, agent_id, args_summary` match the MCP schema
field-for-field; separately, this whole router is gated by
`require_feature_flag("tool_call_label_learning_v1")` at `tool_call_labels.py:23` — not a dropped
field, but every `label_tool_call` MCP call 403/404s outright if that flag is off. Note the flag
defaults **on** (`config.py:1228`, `tool_call_label_learning_v1: bool = True`), so this isn't
currently blocking most orgs; worth flagging alongside the existing `agent_id`-ownership gap at
finding #6, not as a separate blocker.

`eden_health`/`tail_trace`/`label_tool_call` (`tools.py:199,242,283`) each probe
`hasattr(client, "eden_status"/"tail_trace"/"label_tool_call")` before falling back to `get`/`post`
— none of those three methods exist on `HttpEdenClient`, so that branch is dead code for every real
deployment; harmless (falls through correctly to `get`/`post`) — folded into the untyped-Protocol
carried-forward item (#5) rather than tracked as its own bug, since it's the same
typed-vs-untyped-client surface.

**Sweep tally: 5 tools (of 28) have a real, previously-unflagged contract defect** — 3 with
completely nonexistent target paths (`query_eql`, `query_sql`, `get_judge_scores` — these are
strictly worse than a dropped field, since every invocation fails), 2 with a silently-ignored
`limit` filter (`list_datasets`, `list_experiments`). Plus the 1 previously-known `live`
field-drop (§0a), now precisely fixed. All 23 remaining tools checked path+field-clean.

## 2. `ai_agent`/`ai_insights` dual router — unique-functionality trace

Full endpoint inventory, both routers, this pass:

| `ai_agent.router` (`/orgs/{org}/ai/*`) | `ai_insights.router` (`/orgs/{org_id}/ai-insights/*`) |
|---|---|
| `POST /chat` (`ai_agent.py:155`) | `POST /chat` (`ai_insights.py:555`) |
| `GET /conversations` (`:256`) | `GET /sessions` (`:716`) |
| `GET /conversations/{id}` (`:296`) | `GET /sessions/{id}/messages` (`:799`) |
| `DELETE /conversations/{id}` (`:364`) | — |
| `GET /tools` (`:387`) | — |
| — | `POST /approve` (`:653`) |
| — | `POST /sessions/{id}/archive` (`:839`) |
| — | `GET /health` (`:879`) |

5 routes vs. 6; only chat + list + get-by-id overlap in *shape*, and even those differ in resource
name (`conversations` vs. `sessions`) and response format (SSE `session`/`tool_call`/`chart`/
`citation` event types for `ai-insights/chat` vs. `ai_agent.py`'s own separate handler, per prior
pass). Traced each non-overlapping route for real callers:

- **`ai_insights`-only, actively used, no `ai_agent` equivalent:**
  - `POST /approve` (`ai_insights.py:653-`) — executes an approval-gated write tool after operator
    confirmation. Reads `_APPROVAL_GATED_TOOLS | _SPEND_CONFIRM_TOOLS` from
    `eden.autonomous.agent`, enforces RBAC inside `dispatch_tool`, and writes an N06 compliance
    audit record on success (docstring: "so the compliance pack can see ChatSidebar mutations").
    `ai_agent.py` has zero references to `approve`/`approval`/`pending_tool_call` anywhere
    (`grep -n "approve" ai_agent.py` → no hits) — no equivalent execution path exists. Actively
    called: `clients/portal/src/app/api/ai-insights/approve/route.ts` proxies to it.
  - `POST /sessions/{id}/archive` (`ai_insights.py:839-`) — actively called via
    `clients/portal/src/lib/api/resources.ts:889-891`
    (`archiveAiInsightsSession(orgId, sessionId) → POST /orgs/{org}/ai-insights/sessions/{id}/archive`).
    `ai_agent.router` has no archive/soft-delete verb on conversations at all.
- **`ai_agent`-only, but *no current caller found*:**
  - `DELETE /conversations/{id}` (`ai_agent.py:364-`) — `grep -rn "conversations/\${" 
    clients/portal/src/lib/api/portal.ts` and a repo-wide grep for a delete-conversation call in
    `clients/portal` → zero hits. Unreachable from the portal today.
  - `GET /tools` (`ai_agent.py:387-`, tool catalog) — docstring self-describes as being for a
    not-yet-built "portal 'what can the agent do' panel" and "future integrations." `grep -rln
    "ai/tools" clients/portal` → zero hits. Unreachable from the portal today.

**Verdict: retiring either router today, as literally described by
`SOTA-WAVE-TRACKER.md:326`'s "ai_agent.router unmounted," would break real, currently-exercised
functionality — it is not a safe same-day cleanup.** (`bugs/01-dead-code-stale-docs.md` #11/#13
independently establishes, via the same `app.py:226/229` mount evidence, that both routers are
live simultaneously and the tracker line is false — see that doc for the mount citation in full;
this section's contribution is the endpoint-level trace of *which* routes are non-redundant and
why neither router can simply be dropped.) Specifically:
- Retiring `ai_insights.router` breaks the actively-used approval-gated-write flow (with its RBAC +
  compliance-audit side effects) and session archiving — both used by ChatSidebar today, neither
  has an `ai_agent` equivalent to fall back to.
- Retiring `ai_agent.router` breaks the Agent page's chat/conversation-list surface
  (`agent/page.tsx:408`, `portal.ts:315-332`), which has no drop-in replacement in `ai_insights`
  (different resource shape/name, different SSE event schema) — the portal's Agent page would need
  a real migration to `ai-insights` sessions semantics, not just a router unmount.
- The two routes with zero found callers (`DELETE /conversations/{id}`, `GET /tools`) are the only
  genuinely low-risk-to-drop pieces, and dropping *only those two* doesn't retire a router, it just
  trims dead surface from `ai_agent`.
- A real consolidation requires: porting `POST /approve` (with its RBAC + N06 audit semantics) and
  `POST /sessions/{id}/archive` into whichever router survives, *and* migrating the Agent page's
  frontend calls to the surviving router's resource shape — real backend + frontend work, not a
  flag flip. The backend/data-layer unification (`get_chat_service()` +
  `ai_conversations`/`ai_messages`, confirmed real in prior passes) does not by itself make either
  REST surface redundant; it only means the *storage* is already shared.

## 3. Carried-forward findings (verified previously, not re-litigated this pass)

- **#3** Portal cannot invoke the `ignored` issue status — no `setIssueStatus(id, "ignored")` caller
  in `issues-client.tsx`. (Cross-reference: `bugs/04-frontend-and-test-failures.md` §5 independently
  re-confirmed this end-to-end this pass — backend allowlist and portal API client both support
  `"ignored"`, but the UI's own `IssueStatus` type structurally excludes it and no
  Dismiss/Ignore button exists — and additionally ruled out a hypothesized kanban-crash risk, since
  the portal read-model endpoint defensively maps `ignored → resolved` server-side. Treat that
  section as the fuller writeup.)
- **#5** `EdenApiClient` Protocol covers 17 of 26 distinct client-calling methods; 9 tools (10
  counting `tail_trace`'s `hasattr(client, "tail_trace")` dead-branch, see §1.D) reach
  `HttpEdenClient` via untyped `get`/`post` duck-typing.
- **#6** `label_tool_call`'s caller-supplied `agent_id` is persisted with no ownership check against
  `span_id`/`trace_id`.
- **#8** `resolve_issue`'s response (`regression_cases`, `regression_run`, `prompt_evolution`) is
  under-typed in the portal's `agentIssuesApi.resolve` return type.
- **#9** `retrain_tool_calibrator` (`tool_call_labels.py:123-132`) takes an untyped
  `body: dict[str, Any]` — no Pydantic model, 200-with-error-string instead of 422.
- **#10** `resolve_issue` silently coerces an invalid `status` to `"resolved"`
  (`agent_issues.py:173`) — real, confirmed, and unaffected by MCP's soft-retirement (it's a plain
  REST/portal bug). **Cross-reference, not restated here:** `bugs/02-data-consistency.md` Bug 8a
  found this same coercion independently and in more depth — it additionally proves
  `"acknowledged"` isn't a legal `agent_issues.status` CHECK-constraint value
  (`db_migrations/versions/136_issue_status_escalated.py:36-64`) and traces the portal's
  optimistic-UI silent-failure consequence (`issues-client.tsx:499`). Treat `bugs/02` Bug 8 as the
  canonical writeup for this defect.
- **#7** `signal_investigator.py`/`intelligence_rca.py` (RCA chain, F06 investigate) remain
  backend-only: zero portal callers, absent from the 28-tool MCP catalog.

## Recommendation priority (updated — revised this pass to account for MCP's soft-retirement)

MCP-only findings (§0a, and `query_sql`/`get_judge_scores`/`list_datasets`/`list_experiments` from
§1) are downgraded from the prior pass's P0 to P1: see the framing note above — MCP has zero
internal callers, the HTTP transport is off by default, and the how-to doc is `draft: true` and
banner-marked "soft-retired." `query_eql` is the one exception, kept above the other broken-path
tools because Eden's own onboarding doc tells users to run it as a smoke-test step, giving it real
(if narrow) user impact. #10 and the dual-router finding are **not** MCP-dependent and keep their
original severity.

1. **P0:** Fix `resolve_issue`'s silent status coercion (`agent_issues.py:173`, #10) — a live
   REST/portal bug, independent of MCP. Canonical writeup: `bugs/02-data-consistency.md` Bug 8a.
2. **P0:** Add a "Dismiss" action to `issues-client.tsx` for `ignored` status (#3) — a live portal
   gap, independent of MCP. Canonical writeup: `bugs/04-frontend-and-test-failures.md` §5.
3. **P1 (revised from prior pass, per §2):** Do not "just retire" `ai_agent.router` — port
   `POST /approve` and `POST /sessions/{id}/archive` semantics forward (or migrate the Agent page
   to `ai-insights` sessions) before dropping either mount; update
   `SOTA-WAVE-TRACKER.md:326` regardless, since "unmounted" is false today either way.
4. **P1 (new, from §1.A):** Fix `query_eql` — it's the one broken MCP tool with concrete, doc-driven
   user impact (Eden's own `mcp-cursor.md:182` smoke test invokes it and gets a guaranteed 404);
   retarget to `/alerts/compile` or add a real NL-preview route.
5. **P1 (downgraded from P0 this pass — soft-retired MCP surface, see framing note):** Ship the §0a
   `live`-param fix — still a precise 4-file, ~6-line diff (Protocol + `HttpEdenClient` + both
   `tools.py` wrappers + both `server.py` schemas), plus drop or repurpose the fictitious
   `rerun_mode` enum that maps to nothing server-side. Worth shipping (it's cheap and the defect
   is spreading — `checkpoint_rerun` was born broken with this exact gap), just not urgent: the
   `live` gateway rerun has never worked for any caller since it shipped, so fixing it now closes a
   long-standing gap rather than stopping an active regression.
6. **P1 (downgraded from P0 this pass — soft-retired MCP surface):** Fix or remove `query_sql`
   (append `/execute`, swap `limit`→`max_rows`) and `get_judge_scores` (retarget to
   `/observability/judges?trace_id=`). Both are 100%-failure bugs, but sit behind the same
   near-zero-usage MCP surface as §0a, with no doc-driven smoke-test exposure like `query_eql`.
7. **P1 (new, from §1.B — same downgrade rationale):** Either add a real `limit`/pagination param
   to `datasets_hub.py`'s and `experiments_offline.py`'s list routes, or drop the misleading `limit`
   property from the `list_datasets`/`list_experiments` MCP schemas — both currently no-op.
8. **P1:** Extend the `EdenApiClient` Protocol to cover the untyped tools (#5).
9. **P1:** Give `retrain_tool_calibrator` a real Pydantic request model (#9).
10. **P2:** Consolidate `rerun_debugger`/`checkpoint_rerun` into one tool with a mode flag, same
    change window as item 5.
11. **P2:** Confirm whether `signal_investigator.py`/`intelligence_rca.py` need portal/MCP wiring
    (#7).

## Verdicts (this pass)

0a. **`rerun_mode`/`live` bug** — exact fix specified: one new `live: bool | None` parameter
    threaded through `EdenApiClient.rerun_debugger` (Protocol + `HttpEdenClient` impl,
    `client.py:37-46,245-264`) and both `tools.py` call sites (`:45-62,470-497`), plus a `"live"`
    boolean property added to both tool schemas in `server.py`. Confirmed the `rerun_mode` enum
    both schemas advertise has no server-side counterpart at all (`RerunRequest` has no
    `rerun_mode` field) — it should be dropped or repurposed, not just left as decoration.
    **Priority note:** downgraded P0→P1 this pass — MCP is soft-retired with zero internal callers
    (see framing note above), so this is a real, cheap-to-fix, long-standing gap rather than an
    active production regression.
1. **Schema-diff sweep: 5 of 28 tools have a real, previously unflagged contract bug.** 3 call
   nonexistent API paths (`query_eql`, `query_sql`, `get_judge_scores` — guaranteed failure on
   every invocation), 2 send a `limit` filter the target route silently ignores (`list_datasets`,
   `list_experiments`). Tool-catalog count corrected: 28, not 29 (prior pass's `grep -c` was
   unscoped and counted an unrelated line). 23 tools confirmed path+field-clean.
2. **Dual router: retiring either today is NOT safe.** `ai_insights.router` owns two actively-used,
   non-redundant capabilities with zero `ai_agent` equivalent — approval-gated write execution
   (`POST /approve`, RBAC + N06 audit) and session archiving (`POST /sessions/{id}/archive`, called
   from `resources.ts:889-891`). `ai_agent.router` owns the actively-used chat/conversation-list
   surface the portal's Agent page depends on, with no drop-in `ai-insights` equivalent (different
   resource shape, different SSE event schema). The only genuinely dead, safely-droppable surface
   is `ai_agent`'s `DELETE /conversations/{id}` and `GET /tools` (zero found callers) — dropping
   those trims `ai_agent`, it doesn't retire it. `SOTA-WAVE-TRACKER.md:326` remains inaccurate
   either way.
