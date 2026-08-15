# Pass 4 review notes — features/11-session-analytics.md

Reviewer: A (sole reviewer, pass 4/final)

## VERIFIED

Every line-number / call-graph claim below was independently re-traced
against source this pass (not just re-read from the doc) and confirmed
accurate:

- `src/eden/analytics/cohorts.py` and `funnels.py` read exactly as
  described: `cohort_retention()` (`cohorts.py:94-160`) queries
  `FROM jobs` in its Postgres fallback (`:75`, `:124`); `funnel()`
  (`funnels.py:78-114`) queries `FROM audit_log` in its Postgres fallback
  (`:93`). Both routed through `GET /orgs/{org_id}/analytics/cohorts` and
  `/analytics/funnel` in `src/eden/api/routes/analytics_v2.py:23-50,53-87`,
  registered at `src/eden/api/app.py:289` exactly as cited.
- `jobs` table confirmed created at `001_initial_schema.py:91-118`
  (`org_id`/`user_id`/`created_at` columns present, matching the doc's
  `:91-106` citation for that table).
- `user_sessions` (Cat-9) confirmed at `024_user_intel_sessions.py:66-93`
  with the exact column list and `idx_user_sessions_user_recent ON
  user_sessions (org_id, user_id, last_event_at DESC)` index the doc
  quotes.
- `session_summaries` (N12) confirmed at `142_session_summaries.py:60-98`:
  exact column list, `user_id VARCHAR(256)` nullable at line 67 (doc's
  `142_session_summaries.py:67` citation is exact), only the two indexes
  the doc names (`idx_session_summaries_org_agent_start`,
  `idx_session_summaries_org_start`, lines 91-97), **no index on
  `user_id`** — confirmed by reading the full `upgrade()` body.
  `src/eden/sessions/rollup.py:55,106,117-118` — every one of those four
  line numbers matches exactly (`max(attributes->>'user_id') AS user_id`
  at `:55`; the upsert column list and `ON CONFLICT` `user_id` coalesce at
  `:106`/`:117-118`).
- `BehaviouralDashboard.cohort` confirmed at
  `src/eden/services/user_intel/behavioural.py:516-540` (class docstring
  literally cites the `dashboard/cohort?cohort=power_users&window=30d`
  shape); route confirmed at
  `src/eden/api/routes/intelligence_user.py:341` (`@router.get
  ("/dashboard/cohort")`). Test coverage confirmed:
  `tests/intelligence/test_user_intelligence.py:954` starts
  `class TestBehaviouralDashboard` with exactly the three cases the doc
  describes (`test_no_data_returns_message`,
  `test_high_regen_rate_fires_alert`,
  `test_invalid_window_returns_bad_request`, lines 956/975/1017).
- `grep -rn "analytics/cohorts\|analytics/funnel\|dashboard/cohort"
  clients/portal/src` → zero hits, confirmed independently — none of the
  three "product-analytics-shaped" backend surfaces are called from the
  portal.
- `src/eden/api/routes/sessions.py` (303 lines, confirmed via `wc -l`):
  the lifecycle router (`/intelligence/user/...`, lines 36-133) and N12
  timeline router (`/orgs/{org_id}/sessions...`, lines 143-303) are
  exactly as described, including the `POST /identify` "not persisted
  server-side" comment (doc cites lines 121/128-132; actual decorator is
  at `:120`, comment block at `:126-130` — off by a few lines but the
  claim's substance is exact-match verbatim, including the "traits
  server-side lives when we add it" phrasing).
- Zero-blast-radius claim confirmed independently: `grep -rn
  "cohort_retention\|from eden.analytics" src tests` shows the **only**
  call site of `cohort_retention` is `analytics_v2.py:30`; no other
  production or test code imports it. `test_get_funnel_infra_is_503`
  (`tests/unit/api/test_w7_4_eval_data_platform_status_mapping.py:245-258`)
  confirmed to mock `funnel` at the module-attribute boundary, never
  touching real SQL. `api_surface_snapshot.json` lines 376-381/3574-3578
  confirmed to list both routes verbatim. `tests/baselines/mypy.json:5-6`
  confirmed `"src/eden/analytics/cohorts.py": 1` /
  `"src/eden/analytics/funnels.py": 1`.
- Portal: `clients/portal/src/lab/traces-session-lens.tsx` — commit
  `953286b7` confirmed via `git log` (`Tue Aug 4 15:26:06 2026 -0400,
  "feat(portal): session timeline UI, automations tab, saved views
  (F58/F61/N12)"`). `HubViewToggle:42`, `SessionListButton:77`,
  `TurnCard:136`, `SessionTurnsSection:226`, `SessionReader:377` — every
  line number in the doc matches exactly on independent re-grep.
  `automations-panel.tsx` and `saved-views-menu.tsx` confirmed to be
  what the doc says (rule CRUD over `automationsApi`; filter/column
  URL-state persistence over `savedSearchesApi`) — genuinely unrelated to
  session analytics, correctly scoped out.
- Chart-stack claims all confirmed: `recharts@^3.9.1` only (no
  d3/visx/nivo/victory) in `clients/portal/package.json:57`;
  `gateway-charts.tsx` and `agent-quality-trend.tsx` both exist and match
  the cited conventions (`~370KB` comment verbatim in `gateway-charts.tsx`
  header; `CHART_MOTION_MS = 180` at `agent-quality-trend.tsx:20`;
  `downloadCsv`/`downloadPng` exported from `lib/export.ts:67,87` and
  actually used in `gateway-charts.tsx`); `STORAGE_COLORS_SSR_FALLBACK`
  confirmed in `lib/chart-colors.ts` with the documented SSR-fallback
  rationale in its header comment.
- The doc's session/turn/span taxonomy comparison against Amplitude and
  PostHog is external research (not independently re-verifiable this pass
  — WebSearch budget for this session was exhausted before I could
  re-check the Amplitude/LangSmith citations). It was already labeled
  "verified" by a prior pass and carries specific quotes + URLs; no
  internal-source contradiction found, so left as-is, but flagging that
  this pass did not re-derive it from primary sources.
- Migration `143_session_summaries_user_index.py` confirmed **not** to
  exist yet (correctly framed as a proposal, not a landed migration) —
  `142_session_summaries.py` is still the newest file in
  `src/eden/db_migrations/versions/`.

## CUT

None. This doc is unusually tight for a pass-4 review — every claim I
checked traced to real, precisely-cited source, there is no padding, no
duplicate market-context restatement, and the recommendation section is
already scoped down to exactly what's actionable. I looked specifically
for redundancy against sibling docs (`01-competitor-matrix.md` for the
market-context section, `08-annotation-labeling.md` /
`14-user-request-mining.md` for anything covering `user_sessions`/Cat-9
from another angle) and found no meaningful overlap — this doc's Cat-9
material is scoped strictly to the retention-join-key question, not
re-litigating what those other docs own.

The one candidate for trimming is stylistic, not substantive: the
"Keep-or-delete, resolved this pass" paragraph under `BehaviouralDashboard
.cohort` and the "3. `BehaviouralDashboard.cohort`" bullet in the
Recommendation section say the same thing twice (keep as-is, don't
repoint, don't delete, it's a different report). Not cutting it myself
since I was told not to edit the original doc, but flagging it as a real,
low-stakes duplication the doc owner could merge into one mention.

## USER EXPERIENCE & VALUE

**What exploring a session looks like in the portal today**

An operator gets to session data through Traces → the `Runs`/`Sessions`
toggle (`HubViewToggle`, `traces-session-lens.tsx:42`). Selecting
`Sessions` swaps the left-hand feed from individual trace rows to session
rows (`SessionListButton`, `:77`) — each row shows an outcome badge, an
agent name, turn count, and start time. Clicking a row opens `SessionReader`
(`:377`): a header with outcome badge / session id / agent / turn count /
start-end / duration / tokens / cost, an "Open issue" shortcut if one is
linked, and below it a scrollable list of `TurnCard`s (`:136`) — one per
trace/turn, each showing index (`3/7`), a severity badge, the trace id
(click-through to the full trace), duration, cost, tokens, outcome,
stumble-kind chips, linked-issue chips, and a one-line summary. There's a
free-text "Link issue id…" box at the top of the turn list that calls
`POST /sessions/{id}/link-issue` directly from the reader.

That's a genuinely good, fast, textual "session replay" primitive for an
agent product — reading it feels like reading a chat transcript with
inline telemetry, which is the right shape (the doc's Recommendation §5,
"do not build AgentOps-style screen replay," is correct: there is no
screen/DOM to replay for a conversational agent, and this turn-card format
already gives an operator everything AgentOps' replay UI would show for
an LLM product).

**The part the doc's source-inventory undersells: what data actually
backs that UI, end to end**

Tracing the real fetch calls (not just the file the doc read) surfaces a
wiring gap the doc's "two disconnected tables" framing doesn't capture:

- The session **list** you scroll through (`SessionListButton` rows) is
  populated by `portalApi.sessions(orgId)` → `GET
  /orgs/{org_id}/portal/sessions` (`clients/portal/src/lib/api/portal.ts:83-84`),
  which the backend (`src/eden/api/routes/portal.py:1512-1580`,
  `list_portal_sessions`) serves from **`AgentSessionService`**
  (`src/eden/services/agent_sessions.py`) — an F23/D12 subsystem backed by
  its own `agent_sessions` table (`092_market_ready_consolidated.py`),
  explicitly docstring'd as *"distinct from user intelligence sessions."*
  This is a **third** session table, alongside `user_sessions` (Cat-9)
  and `session_summaries` (N12) — the doc's "two disconnected tables"
  headline undercounts it by one.
- The session **header** (`SessionReader`'s outcome/duration/tokens/cost
  strip) is populated from that same F23 `SessionRollup`/`SessionFixture`
  object — not from `session_summaries`.
- Only the **turn list inside** a selected session
  (`SessionTurnsSection`, `:226`) calls the N12 timeline endpoint
  (`sessionsApi.timeline`, `GET /sessions/{id}/timeline`, backed by
  `session_summaries`) — and even that has a silent fallback: if the live
  call errors or returns zero turns, it renders `fallbackTurns` (fixture
  data) instead, with only a small "Live timeline unavailable — showing
  cached turns" notice (`:305-309`).
- The N12 timeline router's own **list** endpoint
  (`GET /orgs/{org_id}/sessions`, with real `agent_id`/`since`/
  `had_stumble`/`min_cost` filters — the richer, purpose-built list) is
  wired up client-side (`sessionsApi.list`,
  `clients/portal/src/lib/api/resources.ts:4354-4370`) but **is called
  from nowhere in the portal** — confirmed via `grep -rn
  "sessionsApi.list" clients/portal/src`, zero hits outside its own
  definition. The F23 portal-read-model list
  (`list_portal_sessions`) that's actually wired up has no filters at all
  beyond `limit` — no `agent_id`, `had_stumble`, or `min_cost` — so the
  stumble/cost filtering the timeline router was built for is invisible
  to today's UI.

Net effect for the operator: the list you browse and the summary card you
read for a session are generated from a different subsystem than the turn
detail underneath it, and the more useful, filterable session list
endpoint (stumble filter, cost filter, per-agent filter) that the N12 work
actually built is dead code from the portal's point of view. This doesn't
show up as a visible bug most of the time — both `agent_sessions` and
`session_summaries` are populated from the same underlying traces, so the
numbers mostly agree — but it means: (a) there are now three independent
places a session count/outcome/cost can silently drift out of sync, (b)
whoever builds the next thing on top of "sessions" (a retention chart, a
funnel, a per-user drill-down) has to pick one of three backing stores and
guess right, and (c) the filters the N12 timeline API was clearly designed
to support (`had_stumble`, `min_cost` — exactly the query shape an
operator doing drop-off analysis would want) have no UI surface at all
today.

**What "good" would look like, grounded in what's actually buildable
here**

1. **Collapse to one session list source before adding any new UI.** The
   cheapest fix is not new features — it's pointing `portalApi.sessions`
   (or a thin portal-route change) at the N12 `GET /orgs/{org_id}/sessions`
   read model instead of `AgentSessionService`, so the list, header, and
   turn detail all come from `session_summaries`. This also unlocks the
   `had_stumble`/`min_cost` filters for free in the UI, since the backend
   endpoint already accepts them (`sessions.py:229-238`) — right now
   that's the single highest-value, lowest-effort UX win in this area,
   and it's more urgent than the retention-chart work below because it's
   fixing something already shipped, not adding something new.
2. **Surface a stumble/cost/outcome filter bar on the Sessions list**,
   once (1) is done — the backend query support already exists
   (`agent_id`, `since`, `had_stumble`, `min_cost` on
   `GET /sessions`); this is the fastest way to get something
   resembling "drop-off analysis" without touching `cohorts.py`/
   `funnels.py` at all: an operator filtering to `had_stumble=true` or
   `outcome=fail` sessions, sorted by recency, is a real (if manual)
   drop-off investigation tool, and it's one query-param wiring change
   away from existing, not new backend work.
3. **The retention-curve chart the doc sketches (`RetentionCurveChart`,
   recharts, `cohorts.py` repointed to `session_summaries`) is the right
   next increment after that**, not before — a per-user retention curve
   with no reliable single-session view underneath it would be a
   confusing addition (an operator would see conflicting session counts
   between the retention chart's cohort sizes and the sessions list they
   already know). Sequence it after (1).
4. **Cohort/segment drill-down**: today there is no "click a cohort week
   → see the sessions in it" path even conceptually, since
   `cohort_retention()`'s output is aggregate-only (counts, not session
   ids). If a retention chart ships, it should link each week's bar/line
   point back to a filtered `GET /sessions?since=...` list (once that's
   the single source of truth per (1)) rather than being a dead-end
   number — that's the cheapest version of "cohort views" the doc's
   Recommendation gestures at without inventing new UI surface.
5. **Session replay**: no change needed. The existing `TurnCard` timeline
   already is the correct replay primitive for a conversational-agent
   product (confirmed: no DOM/screen exists to replay; AgentOps-style
   step replay is exactly what `SessionTurnsSection` already provides).
   This is where the doc's Recommendation §5 is correct and should stay
   as-is — worth stating clearly in the UX section so it isn't re-litigated
   in a future pass.

## NEW FINDINGS

1. **`funnel()`'s Postgres fallback queries a table that appears not to
   exist at all** (`funnels.py:93`, `FROM audit_log`) — this is a
   stronger claim than the doc's "orphaned, wrong table" framing.
   Exhaustive search (`grep -rn "CREATE TABLE.*audit_log" migrations/
   src/eden/db_migrations/versions/`, plus a check of every table
   creation statement matching `*audit*`) turns up only `org_audit_log`
   (`migrations/008_org_audit_log.sql`, `001_initial_schema.py:328`),
   `autonomy_audit_log` (`086_autonomy_policies.py:64`), and
   `agent_audit_ledger` (`092_market_ready_consolidated.py:501`) — never
   a bare `audit_log` table. The *same* bug exists independently in
   `src/eden/api/routes/audit.py:210` (`export_audit_log`'s CSV/JSONL
   export query, `FROM audit_log WHERE org_id = $1`), while the sibling
   endpoint in the same file (`get_audit_log`, `:107-124`) correctly
   queries `org_audit_log`. Both call sites are untested against a real
   schema — `test_audit_tamper.py`'s export tests
   (`:113-163`, `:166-...`) mock `get_postgres_client` entirely, so
   nothing would catch a `relation "audit_log" does not exist` error in
   CI or staging with a real Postgres. Practical implication for this
   doc: the Recommendation's "leave `funnel()` pointed at `audit_log` for
   now, no technical obstacle to repointing later" understates the
   current state — the Postgres fallback path is likely a live 500 if it
   were ever hit (ClickHouse path returns `None`/falls through first per
   `_funnel_clickhouse`'s `except Exception: return None`, so this may be
   masked in practice, same "harmless by accident" shape the doc already
   documents for the ClickHouse cohorts path). Worth a one-line follow-up
   note in the doc, not a scope change to the recommendation itself.
   Also worth flagging to whichever doc in this review owns `audit.py`
   (audit/compliance-adjacent, likely `06-cost-governance` or a
   bug-tracking doc) since `export_audit_log` is a customer-facing export
   feature, not analytics-adjacent dead code.

2. **There are (at least) three, not two, disconnected "session" backing
   stores, and the shipped portal UI (commit `953286b7`) actually spans
   two of the three inconsistently** — see USER EXPERIENCE & VALUE above
   for the full trace. Summary: `user_sessions` (Cat-9,
   `024_user_intel_sessions.py`), `session_summaries` (N12,
   `142_session_summaries.py`, what this doc's "What eden actually has"
   section focuses on), and `agent_sessions` (F23/D12,
   `092_market_ready_consolidated.py`, `src/eden/services/agent_sessions.py`,
   explicitly docstring'd *"distinct from user intelligence sessions"*).
   The portal's actual session **list** and **header** UI
   (`portalApi.sessions` → `GET /orgs/{org_id}/portal/sessions` →
   `AgentSessionService.list_sessions`) is wired to the third
   (`agent_sessions`), while only the **turn detail** inside a selected
   session is wired to the second (`session_summaries`, via
   `sessionsApi.timeline`). The N12 timeline router's own richer list
   endpoint (`GET /orgs/{org_id}/sessions`, with `had_stumble`/
   `min_cost`/`agent_id` filters — `sessions.py:229-259`) is fully built,
   tested-enough-to-mock, and **called from nowhere in the portal**
   (`grep -rn "sessionsApi.list" clients/portal/src` → zero hits outside
   its own definition in `resources.ts`). This directly affects the
   doc's migration-repoint recommendation: repointing `cohort_retention()`
   to `session_summaries` (as recommended) is still correct, but it will
   produce cohort/retention numbers computed from a *different* table
   than the one backing the session list and header an operator is
   looking at simultaneously — worth a one-line callout in the doc's
   Recommendation section, and probably worth its own follow-up item
   (portal: repoint `portalApi.sessions` from `AgentSessionService` to
   the N12 `GET /sessions` read model) since it's a real, shippable,
   low-risk fix in the same spirit as the `143` index migration already
   recommended.

3. There is a **fourth** session-shaped API surface not mentioned in the
   doc at all: `src/eden/api/routes/agent_sessions.py`
   (`/orgs/{org_id}/agent-sessions/*` — `start`/`end`/`identify`/
   `traces`/list/get, F23, gated behind an `agent_sessions_v1` feature
   flag at `agent_sessions.py:18`) plus a matching
   `ingest_agent_sessions.py` ingestion route — both registered in
   `app.py` (`:124`, `:263`) and both operating on the same
   `agent_sessions` table `AgentSessionService`/`portal.py` use. This is
   a second, SDK-facing lifecycle API for the same F23 table, parallel to
   the Phase A1 `/intelligence/user/sessions/*` lifecycle router the doc
   already covers — i.e., eden now has **two** separate "start a
   session / end a session / identify a user" SDK-facing API surfaces
   (Phase A1 over `user_sessions`, F23 over `agent_sessions`), which the
   doc's "Session vs. agent run" analysis doesn't address because it only
   read `sessions.py`, not `agent_sessions.py`. Not a session-analytics
   gap per se, but relevant context for anyone deciding which table to
   build retention/funnel/cohort features on top of — `session_summaries`
   (the doc's pick, still the right one, since it's the only one with
   `trace_ids`/turn-level rollup + `outcome`) remains correct, but the
   doc should note it's choosing among three live candidates, not two.
