# 11 — Session / End-User Analytics

**Status:** research only, no code changes.
**Scope:** does eden give teams consumer-product-style analytics (funnels,
cohort/retention, session replay) about the *end users* talking to their
agents, or only per-session debugging?

## Verdict, up front

The prior draft's headline claim — "no product-analytics
cohort/funnel/retention/replay code anywhere in the repo… a genuine, complete
absence" — is **wrong**. `src/eden/analytics/cohorts.py` and
`src/eden/analytics/funnels.py` implement exactly that: a week-over-week
retention curve (`cohort_retention()`) and an ordered-step drop-off funnel
(`funnel()`), both mounted as real, minimally-tested API routes
(`GET /orgs/{org_id}/analytics/cohorts`, `GET /orgs/{org_id}/analytics/funnel`
— `src/eden/api/routes/analytics_v2.py:4-5,23-50,53-68`, registered in
`src/eden/api/app.py:289`).

The correction that matters, though, is *why this doesn't close the gap*:
this code queries eden's own internal `jobs`/`audit_log` tables (its
eval-job queue and admin audit trail — `src/eden/db_migrations/versions/
001_initial_schema.py:91-106`), not `session_summaries` or `user_sessions`
(the tables that actually hold agent-conversation end-user data). It landed
in the foundational `feat: land pre-batch Eden Phase 0/1/2/3 implementation`
commits (`f2125356`/`25597fcd`, 2026-06-08) — roughly two months *before*
`session_summaries` existed (added by `5e645046`, N12 wave) — and nothing
has repointed it since. No portal code calls either endpoint (`grep -rn
"analytics/cohorts\|analytics/funnel" clients/portal/src` → zero hits). It's
real, mounted, minimally tested code that is orphaned relative to the data
model the rest of this doc cares about — not evidence of "no such feature,"
but not evidence of "we already have retention analytics" either.

**Net verdict: KEEP the market-context research (still accurate), CUT the
"complete absence" framing, RESCOPE the recommendation** — see below.

## Market context (verified)

The market has split into two layers: an LLM-call-centric observability
layer (traces/spans/tokens/cost) and a product-analytics layer
(funnels/cohorts/retention/replay) applied to the *humans* using an AI
product.

- **Langfuse**: first-class `sessions` (groups traces, textual "replay" of a
  thread). No native funnel/cohort/retention; ships a documented PostHog
  integration specifically to get those on top of Langfuse's trace/session
  events — confirmed current as of this pass (PostHog: "nothing is
  backfilled… per-trace metrics like cost/latency must be recomputed by
  aggregating observation events," i.e. it's a real, still-manual
  integration, not a built-in).
- **LangSmith**: added **Insights Agent** + **Multi-turn Evaluations** (GA,
  announced 2025-10-23) — clusters traces into usage-pattern/failure-mode
  taxonomies and scores whole conversation **threads**, but this is quality
  analysis, not a funnel/cohort/retention report on end users. LangChain's
  own roadmap says thread-level metrics/dashboards are "still to come."
- **AgentOps**: markets **session replay** as a first-class, visual
  time-travel feature (replay/rewind an agent run step-by-step) — more
  interactive than Langfuse's trace reconstruction, but it's trace/tool-call
  replay, not screen/DOM replay, and there's no cohort/funnel/retention
  layer.
- **PostHog**: the actual go-to for funnels/cohorts/retention/session
  replay/feature flags; explicitly positions itself as the tool LLM-ops
  vendors integrate *with* rather than build themselves ("very few LLM
  observability tools give you [funnel/retention/replay] context… PostHog is
  one of them").
- **Userpilot's 2026 "two-stream"/"dual-track" framing**: classic retention
  breaks when a growing share of "sessions" are agents, not humans (Gartner:
  ~40% of enterprise apps will have embedded task-specific agents by
  end-2026). Their prescribed fix is to track human and agent activity as
  separate streams with separate metrics (agent return rate, MCP
  call-success rate) rather than one blended retention curve.

Net: no LLM-ops competitor researched has built native funnel, cohort, or
retention analysis for AI-agent *end users* — they either skip it or
federate to PostHog/Amplitude/Mixpanel.

## What eden actually has

### The session data model is three disconnected tables, not two

- **`user_sessions`** (Cat-9, migration `024_user_intel_sessions.py:66-93`,
  2026-06-12): `org_id, user_id, session_id, first_event_at, last_event_at,
  n_turns, n_traces, abandoned, first_value_at`. Has a real per-user index —
  `idx_user_sessions_user_recent ON user_sessions (org_id, user_id,
  last_event_at DESC)` (line 87-89) — and an `abandoned` boolean, i.e. this
  table already carries most of what a return-rate/abandonment query needs.
  The migration docstring itself says it's "read by
  `SessionAnalytics.aggregate`" and "`BehaviouralDashboard.cohort`."
- **`session_summaries`** (N12, migration `142_session_summaries.py:63-85`):
  `org_id, session_id, agent_id, user_id, trace_ids, turn_count,
  total_cost_usd, total_latency_ms, session_start/end, had_stumble,
  stumble_count, issue_count, outcome`, `PRIMARY KEY (org_id, session_id)`.
  **Only two indexes exist on it** —
  `idx_session_summaries_org_agent_start (org_id, agent_id, session_start
  DESC)` and `idx_session_summaries_org_start (org_id, session_start DESC)`
  (lines 91-97) — **there is no index on `user_id`**. `user_id` is written
  opportunistically from `attributes->>'user_id'` on the underlying traces
  (`src/eden/sessions/rollup.py:55,106,117-118`), not guaranteed populated.
  This is the only one of the three tables with turn-level rollup
  (`trace_ids`) and an `outcome` column, which is why it's the repoint
  target for the retention/funnel work below.
- **`agent_sessions`** (F23/D12, migration `092_market_ready_consolidated.py`,
  service `src/eden/services/agent_sessions.py`) — a **third**, separately
  maintained session store, explicitly docstring'd in its own service as
  "distinct from user intelligence sessions." It has its own SDK-facing
  lifecycle API (`start`/`end`/`identify`/`traces`/list/get at
  `src/eden/api/routes/agent_sessions.py`, `/orgs/{org_id}/agent-sessions/*`,
  gated behind an `agent_sessions_v1` feature flag, plus a matching
  `ingest_agent_sessions.py` ingestion route) — a second "start a
  session / end a session / identify a user" surface, parallel to and
  independent of the Phase A1 lifecycle router over `user_sessions` covered
  below. This table isn't part of the retention/funnel/cohort discussion at
  all, but it matters here for a different reason: **it's the table the
  shipped portal session list and header actually read from** — see
  "Portal" below and "User Experience & Value."

So the draft's claim that the retention join key is "already tracked
end-to-end" overstates it: the column exists in all three tables, but only
`user_sessions` has a usable index for a per-user rollup, a `GROUP BY
user_id` over `session_summaries` today would be an unindexed scan, and
`agent_sessions` doesn't carry a retention-relevant `user_id` rollup at all
— it's a separate lifecycle/read-model store, not a candidate for the
cohort/funnel repoint, that the shipped UI happens to be wired to instead.

### `BehaviouralDashboard.cohort` — the third piece, also disconnected

`src/eden/services/user_intel/behavioural.py:516-540`, exposed at `GET
/orgs/{org_id}/intelligence/user/dashboard/cohort?cohort=X&window=30d`
(`src/eden/api/routes/intelligence_user.py:341-364`). Despite the name, this
is **not** a retention curve — it's a named-cohort-filtered snapshot of
implicit signals (regeneration rate, edit-distance median, abandonment rate,
7-day return rate) plus explicit thumbs-up rate, for one time window. It
reads `user_behavioural_signals` / `user_feedback` (Cat-9 tables), not
`session_summaries`. No portal code calls it either (`grep -rn
"dashboard/cohort" clients/portal/src` → zero hits). Closer to Amplitude's
"cohort = saved segment" concept than to a PostHog/Mixpanel retention table.

**Keep-or-delete, resolved this pass**: verified `.cohort()` is *not*
orphaned the way `cohort_retention()` is — it has real test coverage
(`tests/intelligence/test_user_intelligence.py:954-1030`,
`TestBehaviouralDashboard`, three cases: empty-data envelope, populated
signal+explicit aggregate, bad-window 400) and is wired to a live route.
It also computes genuinely different numbers than a retention curve would —
regeneration rate, edit-distance median, and the Bayesian-corrected
satisfaction posterior (`SelectionBiasCorrector`, migration
`024_user_intel_sessions.py:25-32`, citing arXiv 2605.12177) have no
equivalent in `cohort_retention()`. **Verdict: do not delete, do not
repoint it to `session_summaries`.** It's a legitimately different report
(a segment quality snapshot, Amplitude's "cohort" sense) sitting under a
name that collides with the retention-curve sense of "cohort" the rest of
this doc uses. The only real fix needed is documentation/naming hygiene —
e.g. rename the route's query concept in the portal to "segment snapshot"
once (if) a portal UI is built for either, so the two "/cohort" endpoints
aren't confused. No code change to the function itself is justified by
anything found this pass.

### Backend: `src/eden/api/routes/sessions.py` (303 lines, read in full)

Two routers, genuinely different purposes:

**1. Lifecycle router** (lines 36-133, `/orgs/{org_id}/intelligence/user/…`),
backed by `SessionIdentityService` (`eden.services.app_intel.sessions`) over
`user_sessions`: `POST /sessions/start` (session_id + session_secret,
optional user_id/metadata/ttl_hours ≤30d), `/end`, `/identify` (attach
user_id after the fact — mirrors Segment/Amplitude), `GET /sessions/{id}`,
and `POST /identify` (line 121; top-level traits dict — **not persisted
server-side**, per the code comment at lines 128-132, placeholder for future
server-side trait storage). Identity primitive, not an analytics surface; no
`track()`/event endpoint, no step/funnel-stage concept.

**2. N12 timeline router** (lines 143-303, `/orgs/{org_id}/sessions…`),
backed by `session_summaries`: `GET /sessions` — filtered list of
`SessionSummaryItem` (class at line 153; filters: `agent_id`, `since`,
`had_stumble`, `min_cost`) — single-session-row filtering, not aggregation.
`GET /sessions/{id}/timeline` — ordered `SessionTurn` cards (one per
trace/turn). `POST /sessions/{id}/link-issue` — attach an F29 issue. No
endpoint aggregates *across* sessions per `user_id`. Despite being the
richer, purpose-built session-list endpoint of the two in this router — it's
the only one with `had_stumble`/`min_cost` filtering, exactly the query
shape an operator doing drop-off analysis would want — `GET /sessions` is
called from nowhere in the shipped portal (`grep -rn "sessionsApi.list"
clients/portal/src` → zero hits outside its own definition). See "User
Experience & Value" below.

### Portal: `clients/portal/src/lab/traces-session-lens.tsx` (commit
`953286b7`, 2026-08-04, "session timeline UI, automations tab, saved
views")

A **single-session, turn-by-turn timeline reader**: `SessionTurnsSection`
(line 226) fetches `GET /sessions/{id}/timeline` and renders `TurnCard`
(line 136) rows — turn index, severity badge, trace link, duration, cost,
tokens, outcome, stumble chips, linked-issue chips, one-line summary.
`SessionReader` (line 377) is the detail header. `HubViewToggle` (line 42) /
`SessionListButton` (line 77) give a "Runs vs Sessions" tab and a
list-to-pick-from — still list-of-sessions, not cross-session analytics. No
funnel-step visualization or cohort/retention chart anywhere in the
component, and no portal chart component of any kind currently reuses a
retention-curve shape — building one is net-new UI work, not a reskin.

Critically, the list (`SessionListButton` rows) and `SessionReader`'s
outcome/duration/tokens/cost header strip are **not** populated from
`session_summaries` — they come from `portalApi.sessions(orgId)` → `GET
/orgs/{org_id}/portal/sessions` (`clients/portal/src/lib/api/portal.ts:83-84`)
→ `list_portal_sessions` (`src/eden/api/routes/portal.py:1512-1580`) →
`AgentSessionService`, i.e. the third table, `agent_sessions`. Only the turn
list *inside* a selected session (`SessionTurnsSection`, line 226) calls the
N12 `session_summaries`-backed timeline endpoint. See "User Experience &
Value" below for the full wiring trace and its consequences.

The other two features in that commit are unrelated to analytics:
**Automations** (`signals/automations-panel.tsx`) is a rule-based
alerting/automation builder, and **Saved views**
(`components/portal/saved-views-menu.tsx`) is filter/column URL-state
persistence for the traces/issues toolbars.

## User Experience & Value

**What exploring a session looks like in the portal today**

An operator gets to session data through Traces → the `Runs`/`Sessions`
toggle (`HubViewToggle`, `traces-session-lens.tsx:42`). Selecting `Sessions`
swaps the left-hand feed from individual trace rows to session rows
(`SessionListButton`, `:77`) — each row shows an outcome badge, an agent
name, turn count, and start time. Clicking a row opens `SessionReader`
(`:377`): a header with outcome badge / session id / agent / turn count /
start-end / duration / tokens / cost, an "Open issue" shortcut if one is
linked, and below it a scrollable list of `TurnCard`s (`:136`) — one per
trace/turn, each showing index (`3/7`), a severity badge, the trace id
(click-through to the full trace), duration, cost, tokens, outcome,
stumble-kind chips, linked-issue chips, and a one-line summary. There's a
free-text "Link issue id…" box at the top of the turn list that calls `POST
/sessions/{id}/link-issue` directly from the reader.

That's a genuinely good, fast, textual "session replay" primitive for an
agent product — reading it feels like reading a chat transcript with inline
telemetry, which is the right shape (Recommendation §5 below, "do not build
AgentOps-style screen replay," is correct: there is no screen/DOM to replay
for a conversational agent, and this turn-card format already gives an
operator everything AgentOps' replay UI would show for an LLM product).

**The wiring gap the "two disconnected tables" framing didn't capture**

Tracing the real fetch calls, not just which backend files exist, surfaces a
gap the source inventory above doesn't fully convey on its own:

- The session **list** you scroll through (`SessionListButton` rows) is
  populated by `portalApi.sessions(orgId)` → `GET
  /orgs/{org_id}/portal/sessions`
  (`clients/portal/src/lib/api/portal.ts:83-84`), which the backend
  (`src/eden/api/routes/portal.py:1512-1580`, `list_portal_sessions`) serves
  from `AgentSessionService` (`src/eden/services/agent_sessions.py`) — the
  third table, `agent_sessions`.
- The session **header** (`SessionReader`'s outcome/duration/tokens/cost
  strip) is populated from that same F23 rollup object — not from
  `session_summaries`.
- Only the **turn list inside** a selected session (`SessionTurnsSection`,
  `:226`) calls the N12 timeline endpoint (`sessionsApi.timeline`, `GET
  /sessions/{id}/timeline`, backed by `session_summaries`) — and even that
  has a silent fallback: if the live call errors or returns zero turns, it
  renders `fallbackTurns` (fixture data) instead, with only a small "Live
  timeline unavailable — showing cached turns" notice (`:305-309`).
- The N12 timeline router's own richer list endpoint (`GET
  /orgs/{org_id}/sessions`, with real `agent_id`/`since`/`had_stumble`/
  `min_cost` filters) is wired up client-side (`sessionsApi.list`,
  `clients/portal/src/lib/api/resources.ts:4354-4370`) but is called from
  nowhere in the portal. The `list_portal_sessions` endpoint that's actually
  wired up has no filters at all beyond `limit` — no `agent_id`,
  `had_stumble`, or `min_cost` — so the stumble/cost filtering the timeline
  router was built for is invisible to today's UI.

Net effect for the operator: the list you browse and the summary card you
read for a session are generated from a different subsystem than the turn
detail underneath it, and the more useful, filterable session-list endpoint
(stumble filter, cost filter, per-agent filter) that the N12 work actually
built is dead code from the portal's point of view. This mostly doesn't show
up as a visible bug — both `agent_sessions` and `session_summaries` are
populated from the same underlying traces, so the numbers mostly agree — but
it means: (a) there are now three independent places a session
count/outcome/cost can silently drift out of sync, (b) whoever builds the
next thing on top of "sessions" (a retention chart, a funnel, a per-user
drill-down) has to pick one of three backing stores and guess right, and (c)
the filters the N12 timeline API was clearly designed to support
(`had_stumble`, `min_cost`) have no UI surface at all today.

**What "good" would look like, sequenced by what's actually buildable here**

1. **Collapse to one session-list source before adding any new UI.** The
   cheapest fix is not new features — it's pointing `portalApi.sessions`
   (or a thin portal-route change) at the N12 `GET /orgs/{org_id}/sessions`
   read model instead of `AgentSessionService`, so the list, header, and
   turn detail all come from `session_summaries`. This also unlocks the
   `had_stumble`/`min_cost` filters for free in the UI, since the backend
   endpoint already accepts them (`sessions.py:229-238`). This is the
   single highest-value, lowest-effort UX win in this area, and it's more
   urgent than the retention-chart work below because it's fixing something
   already shipped, not adding something new.
2. **Surface a stumble/cost/outcome filter bar on the Sessions list**, once
   (1) is done — the backend query support already exists (`agent_id`,
   `since`, `had_stumble`, `min_cost` on `GET /sessions`); this is the
   fastest way to get something resembling "drop-off analysis" without
   touching `cohorts.py`/`funnels.py` at all: an operator filtering to
   `had_stumble=true` or `outcome=fail` sessions, sorted by recency, is a
   real (if manual) drop-off investigation tool, and it's one query-param
   wiring change away from existing, not new backend work.
3. **The retention-curve chart sketched below (`RetentionCurveChart`,
   recharts, `cohorts.py` repointed to `session_summaries`) is the right
   next increment after that**, not before — a per-user retention curve
   with no reliable single-session view underneath it would be a confusing
   addition (an operator would see conflicting session counts between the
   retention chart's cohort sizes and the sessions list they already know).
   Sequence it after (1).
4. **Cohort/segment drill-down**: today there is no "click a cohort week →
   see the sessions in it" path even conceptually, since
   `cohort_retention()`'s output is aggregate-only (counts, not session
   ids). If a retention chart ships, it should link each week's bar/line
   point back to a filtered `GET /sessions?since=...` list (once that's the
   single source of truth per (1)) rather than being a dead-end number —
   that's the cheapest version of "cohort views" the Recommendation section
   gestures at without inventing new UI surface.
5. **Session replay**: no change needed. The existing `TurnCard` timeline
   already is the correct replay primitive for a conversational-agent
   product — there is no DOM/screen to replay, and AgentOps-style step
   replay is exactly what `SessionTurnsSection` already provides. This is
   where Recommendation §5 is correct and should stay as-is.

## Precise migration + repoint diff (this pass)

### 1. Index migration — new file, exact SQL

`src/eden/db_migrations/versions/143_session_summaries_user_index.py`,
following the `142_session_summaries.py` idempotency convention (raw
`op.execute` + `IF NOT EXISTS`, no `op.create_index`):

```python
revision: str = "143_session_summaries_user_index"
down_revision: str | Sequence[str] | None = "142_session_summaries"

def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_org_user "
        "ON session_summaries (org_id, user_id, session_start DESC)"
    )

def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_session_summaries_org_user")
```

Column order matters here: `(org_id, user_id, session_start DESC)` mirrors
the existing `idx_session_summaries_org_agent_start` shape (tenant column
first, join key second, time DESC third) so both the per-user
`cohort_retention()` scan and a future "sessions for user X, most recent
first" list query hit the same index. `user_id` is `VARCHAR(256)` and
nullable (not `NOT NULL`, per `142_session_summaries.py:67`) — Postgres
B-tree indexes handle NULLs fine (they just sort together and are skipped by
equality predicates), so no backfill/constraint change is required to add
this index; rows with a null `user_id` simply won't match a `WHERE user_id =
$2` cohort query, which is already the correct behavior (they're
unattributable to a user).

### 2. Repoint `cohort_retention()` — exact SQL swap in `cohorts.py`

Two queries change, both currently against `jobs`:

- `_cohorts_postgres()` (lines 66-83): `FROM jobs WHERE org_id = $1 AND
  created_at >= $2` → `FROM session_summaries WHERE org_id = $1 AND
  session_start >= $2`, and `date_trunc('week', created_at)` →
  `date_trunc('week', session_start)`. `count(DISTINCT user_id)` is
  unchanged — the column name is identical in both tables, which is exactly
  why this is a swap, not a rewrite.
- `cohort_retention()`'s bulk activity query (lines 119-133): same
  `jobs`→`session_summaries`, `created_at`→`session_start` swap, same
  `GROUP BY activity_week, user_id` shape.

`_cohorts_clickhouse()` (lines 46-63) already queries a `user_activity`
ClickHouse table with `first_seen_at`/`user_id` — that's a *different*,
correctly-named table that was presumably never wired up to a real ClickHouse
ingest pipeline (out of scope to verify this pass; it's the CH-preferred
path and silently falls back to Postgres via `except Exception: return []`
at line 51, so it's harmless either way). No change needed there for this
repoint — only the Postgres fallback was pointed at the wrong table.

Net diff size: 2 table names + 2 column names in `cohorts.py`, ~6 lines
touched, matching the doc's earlier "~20-line SQL swap" estimate (the extra
lines are the `WHERE`/`GROUP BY` clauses that reference the renamed
columns, not new logic).

### 3. Repoint `funnel()` — same shape, `funnels.py`

`_funnel_postgres` fallback (`funnels.py:88-102`) queries `audit_log` with
`action`/`created_at`/`user_id`, keyed by a caller-supplied ordered list of
`action` strings (the route's docstring example:
`steps=signup,job_created,job_completed` — literal `audit_log.action`
values, i.e. admin/system actions, not end-user product steps). There is
**no equivalent free-text "step name" column on `session_summaries`** —
its closest analog is the 4-value `outcome` enum (`success|fail|partial|
live`) or the `stumble_kinds`/`had_stumble` boolean, neither of which is an
*ordered, arbitrary* funnel-step vocabulary. Repointing `funnel()` cleanly
therefore is **not** a same-shape SQL swap the way `cohort_retention()` is —
it needs the "funnel step" tag decision from Recommendation §2 (below) made
first, or it stays scoped to `outcome` as a fixed 3-step funnel
(`live`→`partial`→`success`, i.e. "session started" → "session had partial
signal" → "session succeeded"), which is a real but narrow funnel. **This
pass's revised recommendation: land the `cohort_retention()` repoint now
(it's a mechanical swap with an existing correct index target); treat
`funnel()`'s repoint as blocked on the step-vocabulary decision, not on any
technical obstacle.**

**Independent bug, worth flagging regardless of the repoint decision**:
`audit_log` isn't just the wrong table for this use case — it appears not to
exist as a table at all. An exhaustive search of every `CREATE TABLE`
matching `*audit*` across `migrations/` and `src/eden/db_migrations/versions/`
turns up only `org_audit_log` (`migrations/008_org_audit_log.sql`,
`001_initial_schema.py:328`), `autonomy_audit_log`
(`086_autonomy_policies.py:64`), and `agent_audit_ledger`
(`092_market_ready_consolidated.py:501`) — never a bare `audit_log`. The
same bug exists independently in `src/eden/api/routes/audit.py:210`
(`export_audit_log`'s CSV/JSONL export query, `FROM audit_log WHERE org_id =
$1`), while the sibling `get_audit_log` endpoint in the same file
(`:107-124`) correctly queries `org_audit_log`. Neither call site is tested
against a real schema — `test_audit_tamper.py`'s export tests mock
`get_postgres_client` entirely, so a `relation "audit_log" does not exist`
error would not be caught in CI. For `funnel()` this is likely masked in
practice — the ClickHouse path is tried first and falls through silently on
`except Exception: return None`, the same "harmless by accident" shape
already documented for the cohorts ClickHouse path above — but
`export_audit_log` is a customer-facing export feature, not
analytics-adjacent dead code, and is worth flagging to whichever doc in this
review owns audit/compliance surfaces.

### 4. What breaks / needs updating among existing callers

Searched exhaustively (`grep -rn "cohort_retention\|from eden.analytics"
src tests`, `grep -rln "analytics_v2\|cohort_retention\|get_cohorts\|
get_funnel" tests/`): the **only** caller of either function is the route
handler in `analytics_v2.py` itself (`src/eden/analytics/__init__.py`
re-exports both, nothing downstream imports them). Test-coverage inventory:

- `tests/unit/api/test_w7_4_eval_data_platform_status_mapping.py:245-258`,
  `test_get_funnel_infra_is_503` — the *only* test that touches
  `analytics_v2` directly. It `patch.object(mod, "funnel", AsyncMock(...))`
  — i.e. it replaces the imported `funnel` reference wholesale and asserts
  on the route's 503-mapping behavior, never exercising the real SQL. **Not
  affected by the repoint.** No equivalent test exists for `get_cohorts` /
  `cohort_retention` at all.
- `tests/unit/api/api_surface_snapshot.json:376-381,3574-3575` — a route
  *inventory* snapshot (path strings + method), not a behavioral test. Route
  paths/methods are unchanged by this repoint, so this snapshot doesn't
  need updating.
- `tests/baselines/mypy.json:5-6` — records a per-file mypy error count (`1`
  each) for `cohorts.py`/`funnels.py`. Whatever that one pre-existing error
  is per file, it's unrelated to table names (mypy doesn't know Postgres
  schemas) — worth a `mypy` re-run after the swap to confirm the count
  doesn't change, but nothing in the plan should touch it.

**Conclusion: this repoint has zero test blast radius.** No existing test
asserts on `jobs`/`audit_log` being queried, and the one route-level test
mocks the function boundary above the SQL. The honest gap is the *inverse*
one: **no test today would catch a bad repoint** (e.g. a typo'd column
name), so landing this should come with at least one new test that seeds
`session_summaries` rows via the existing Postgres-stub pattern used in
`tests/unit/api/test_analytics_routes.py:31-164` (that file stubs a
different router's tables today, but the `_StubPostgresClient.fetch(query,
...)` dispatch-by-substring pattern is directly reusable for a
`session_summaries`-seeded cohort test).

## Session vs. "agent run" — is `session` even the right unit? (deeper pass)

Went looking specifically at how the two products best known for retention
UX handle *agent* interaction data, not generic page-view retention:

- **Amplitude's Agent Analytics taxonomy** (`amplitude.com/docs/
  amplitude-ai/agent-analytics/taxonomy`) defines an explicit three-level
  hierarchy — **Session → Turn → Span** — and is careful to say the agent
  *session* is a distinct concept from Amplitude's standard `$session_id`
  (an app-visit boundary): "One job a user hands the agent, from start to
  finish." A **Turn** is one user-message/tool-calls/AI-response exchange
  (ordered by a monotonic `[Agent] Turn ID]`); a **Span** is a sub-turn step
  (tool call, vector search, rerank, guardrail). Sessions close via an
  explicit `[Agent] Session End` event carrying `[Agent] Abandonment Turn`
  and an idle-timeout minutes property. Critically: **there is no separate
  "agent run" unit in Amplitude's model** — the closest concept *is*
  "session," just redefined away from its page-view meaning to "one bounded
  task." The doc states this event-per-step design exists specifically so
  teams can "use agent data in funnels, cohorts, and retention charts
  without decomposing a trace first."
- **PostHog's LLM analytics** (`posthog.com/docs/llm-analytics/basics`,
  `traces.mdx`) puts the **trace** (`$ai_trace_id`) as the *required* base
  unit — "a collection of generations and spans that capture a full
  interaction between a user and an LLM" — and treats **session**
  (`$ai_session_id`) as an *optional* property that groups multiple traces
  "based on your chosen grouping strategy." Once captured, LLM events are
  standard PostHog events, so retention/funnels/cohorts apply natively; the
  positioning line is explicit about the retention linkage: "PostHog shows
  you the trace and what it cost you in user retention."

Both category leaders converge on the **same three-tier shape eden already
has**, just with different names: span/tool-call (eden: nothing named this
low yet) < turn/trace (eden: one row per trace, rolled into
`session_summaries.trace_ids`) < session/job (eden: `session_summaries`,
`PRIMARY KEY (org_id, session_id)`, bounded by `session_start`/
`session_end`). Neither Amplitude nor PostHog introduces a fourth "agent
run" unit distinct from session — Amplitude explicitly redefines "session"
*to mean* "one agent run" rather than inventing new vocabulary; PostHog
just lets multiple traces optionally roll into one session without forcing
a session concept on you at all.

**Reasoned opinion**: `session` is the right unit for eden, and no rename or
new "agent run" entity is needed — provided the retention curve is built on
`session_summaries` (session = one bounded job/thread, matching Amplitude's
redefinition) rather than naively repurposing `user_sessions` in isolation.
`user_sessions` (Cat-9) is closer to Amplitude's *deprecated* sense of
session (`$session_id`, an app-visit/API-key-lifetime boundary — its
`first_event_at`/`last_event_at` are wall-clock bounds, not "one job"
bounds) and mixing the two "session" senses is the actual risk in this
data model, not the session-vs-run naming question. Concretely: cohort
*membership* (whose first session started in week N) should be computed
from `session_summaries.session_start` (job-bounded, matches Amplitude's
"Session"), not `user_sessions.first_event_at` (visit-bounded) — reinforcing
why the recommendation above repoints to `session_summaries` and not
`user_sessions`, even though `user_sessions` has the better index today.

## Recommendation (rescoped)

1. **Smallest real lift, in order**:
   a. Land migration `143_session_summaries_user_index.py` (exact SQL
      above): `CREATE INDEX idx_session_summaries_org_user ON
      session_summaries (org_id, user_id, session_start DESC)` — without
      this, any per-user rollup on `session_summaries` scans the org's full
      partition.
   b. Repoint `cohort_retention()`'s two Postgres queries (`cohorts.py:66-83`
      and `119-133`) from `jobs`/`created_at` to
      `session_summaries`/`session_start` — verified zero-blast-radius
      mechanical swap (see diff above), plus one new seeded test since none
      exists today. The dataclasses (`Cohort`, `CohortRow`), the ClickHouse/
      Postgres fallback pattern, the week-bucketing logic, and the response
      envelope are already written and shaped correctly.
   c. **Leave `funnel()` pointed at `audit_log` for now** — repointing it
      cleanly requires the step-vocabulary decision in (2) first; there is
      no `session_summaries` column today that plays the same "arbitrary
      ordered step name" role `audit_log.action` does.
   d. Portal: a genuinely new retention-curve chart component consuming
      `GET /analytics/cohorts` — sketch below; nothing to reuse for the
      *chart shape*, but the surrounding chart-island/token/export scaffold
      is fully reusable.
   e. **Portal wiring fix — higher priority than (d)**: repoint
      `portalApi.sessions` (`GET /orgs/{org_id}/portal/sessions`) from
      `AgentSessionService`/`agent_sessions` to the N12 `GET
      /orgs/{org_id}/sessions` read model, so the shipped session list,
      header, and turn detail all come from `session_summaries` and the
      already-built `had_stumble`/`min_cost`/`agent_id` filters get a UI
      surface for free. This is a fix to already-shipped code, not new
      work, and should land before the retention chart in (d) — see "User
      Experience & Value" above.
2. **Medium-term**: define a lightweight "funnel step" tag on turns, reusing
   the existing `outcome`/`stumble_kinds` vocabulary rather than inventing a
   new schema, specifically so `funnel()` has a real column to repoint to —
   sequenced *after* (1) since it's additive to the same data model.
3. **`BehaviouralDashboard.cohort`**: keep as-is — see
   "`BehaviouralDashboard.cohort`" above for the full rationale (tested,
   live, computes a different report than a retention curve). Only worth a
   naming pass in the portal if/when both surfaces get UI, to avoid two
   different "/cohort" concepts confusing operators.
4. **Framing, unchanged and still well-sourced**: no LLM-ops competitor
   researched ships native funnel/cohort/retention for agent end users —
   they all punt to PostHog/Amplitude. This remains a plausible
   differentiation opportunity, not a parity requirement — but it's worth a
   customer-signal check before building, since "nobody does this" cuts
   both ways (it could be genuine whitespace, or simply unrequested).
5. **Do not** build visual/screen session replay (AgentOps-style). Agent
   products are conversational/API-driven; the turn-by-turn textual timeline
   eden already ships is the correct replay primitive for this category and
   already matches Langfuse's bar — this is a scope call, not a gap.

## Portal component sketch

Confirmed the charting stack first (`clients/portal/package.json`:
`"recharts": "^3.9.1"`; no d3/visx/nivo/victory present). Existing
conventions to reuse, found in `clients/portal/src/`:

- **Code-split "island" pattern** — `app/(portal)/gateway/gateway-charts.tsx`
  and `components/agents/agent-quality-trend.tsx` are both `"use client"`
  files kept separate from their page/tab shell specifically so first paint
  doesn't pull the ~370KB recharts vendor chunk (comment,
  `gateway-charts.tsx:1-5`). A `RetentionCurveChart` component belongs in
  its own file for the same reason, dynamically imported from wherever the
  eventual analytics tab lives.
- **Color tokens** — `src/lib/chart-colors.ts`: `STORAGE_COLORS` (5-color
  `var(--chart-pie-N)` palette) for `<Cell>`/`<Bar>`/`<Line>` `stroke`/`fill`,
  since recharts renders inline SVG attributes that don't resolve CSS
  `var()` reliably server-side — the file already documents this gotcha and
  ships an SSR-safe hex fallback array. One line per cohort in the retention
  chart should cycle through `STORAGE_COLORS`, same as the existing pie
  charts.
- **Chart chrome** — `agent-quality-trend.tsx:21-26` (`tipStyle`: bordered,
  square-cornered tooltip matching the rest of the portal's zero-border-
  radius design language) and `CHART_MOTION_MS = 180` (purposeful ease-out
  only, no continuous animation) are the exact visual conventions to copy
  rather than reinvent.
- **Export** — `src/lib/export.ts` (`downloadCsv`/`downloadPng`, already
  wired into `gateway-charts.tsx`'s `ChartCard`) — reuse directly; a
  retention table is exactly the kind of data an operator wants to export.

**Sketch** — `clients/portal/src/components/analytics/retention-curve-chart.tsx`:

```tsx
"use client";
import {
  CartesianGrid, Line, LineChart, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { STORAGE_COLORS_RESOLVED } from "@/lib/chart-colors";

export type CohortRetentionRow = {
  cohort: string;          // e.g. "week-2026-07-20"
  start_date: string;
  size: number;
  retention: Record<string, number>; // "0".."7" -> 0.0-1.0
};

export function RetentionCurveChart({ cohorts }: { cohorts: CohortRetentionRow[] }) {
  const weeks = Object.keys(cohorts[0]?.retention ?? {}).map(Number).sort((a, b) => a - b);
  const data = weeks.map((w) => {
    const row: Record<string, number | string> = { week: `W${w}` };
    for (const c of cohorts) row[c.cohort] = (c.retention[String(w)] ?? 0) * 100;
    return row;
  });
  return (
    <div className="border border-[var(--line)] bg-[var(--bg)] px-2 py-3 sm:px-3">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis dataKey="week" tick={{ fill: "var(--text-secondary)", fontSize: 11 }} axisLine={{ stroke: "var(--line)" }} tickLine={false} />
          <YAxis domain={[0, 100]} unit="%" tick={{ fill: "var(--text-secondary)", fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 0, fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {cohorts.map((c, i) => (
            <Line key={c.cohort} type="monotone" dataKey={c.cohort}
                  stroke={STORAGE_COLORS_RESOLVED[i % STORAGE_COLORS_RESOLVED.length]}
                  strokeWidth={2} dot={false} isAnimationActive
                  animationDuration={180} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

This is deliberately minimal — one `<Line>` per cohort week-bucket, X axis
weeks-since-cohort-start, Y axis 0-100% retained, `size` shown in the legend
label via `name={`${c.cohort} (n=${c.size})`}` on each `<Line>` (omitted
above for brevity). No new dependency, no new design pattern — every
stylistic choice above is copied from an existing chart in the same
directory tree.

## Sources

- [Langfuse — PostHog integration](https://langfuse.com/integrations/analytics/posthog)
- [PostHog — Best Langfuse alternatives](https://posthog.com/blog/best-langfuse-alternatives)
- [PostHog — LLM analytics positioning](https://posthog.com/handbook/marketing/positioning/llm-analytics)
- [PostHog — Best LangSmith alternatives](https://posthog.com/blog/best-langsmith-alternatives)
- [PostHog — LLM Analytics basics](https://posthog.com/docs/llm-analytics/basics)
- [PostHog — LLM Analytics traces](https://posthog.com/docs/llm-analytics/traces)
- [LangChain — Insights Agent & Multi-turn Evals announcement](https://blog.langchain.com/insights-agent-multiturn-evals-langsmith/)
- [LangChain changelog — Multi-turn Evals GA](https://changelog.langchain.com/announcements/evaluate-end-to-end-agent-interactions-with-multi-turn-evals)
- [Arize — 14 best AI agent observability tools in 2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/)
- [Latitude — Best AI Agent Observability Tools 2026](https://latitude.so/blog/best-ai-agent-observability-tools-2026-comparison)
- [Userpilot — User Retention in 2026: The Two-Stream Model](https://userpilot.com/blog/user-retention/)
- [Userpilot — Customer Retention Analysis: AI Agents as Part of Your User Base](https://userpilot.com/blog/retention-analysis/)
- [Userpilot — Cohort Retention Analysis in 2026](https://userpilot.com/blog/cohort-retention-analysis/)
- [Amplitude — Agent Analytics taxonomy (Session/Turn/Span)](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- [Mixpanel — Cohort analysis in 2026](https://mixpanel.com/blog/cohort-analysis/)
