# Session model — canonical reference (FEAT-152 / FEAT-57)

**Status:** ✅ DONE 2026-08-06 (FEAT-152). Decision documented; no table-merge
migration. Written against `main` after Wave 7's FEAT-56
(`155_session_summaries_user_index` + `analytics/cohorts.py` repointed to
`session_summaries`). FEAT-57 named the consolidation work; FEAT-152 is
the explicit three-table decision this doc records.

Eden has three tables that all use the word "session." They are **not**
three redundant copies of the same concept — they model three different
things — but nothing before this doc said so in one place, and two of the
three (`agent_sessions`, `session_summaries`) look interchangeable at a
glance because both are keyed by a session id populated by the SDK. This
doc is the disambiguation. See also `docs/docs/how-to/agent-sessions.md`,
which already carries a shorter version of the same warning for SDK users.
Code pointer: `src/eden/sessions/canonical.py` (`CANONICAL_TABLE`,
`TABLE_ROLES`).

## The three tables, one line each

| Table | What it is | Who writes it | Who reads it |
|---|---|---|---|
| `session_summaries` | **Canonical read model for product/session metrics.** One row per `(org_id, session_id)`, incrementally rolled up from `telemetry_events` + `agent_stumbles` every time a trace in the session finalizes. | `eden.sessions.rollup.SessionRollupIndexer` (hooked into the `trace.finalized` consumer) | Portal session list/timeline (`/orgs/{org_id}/sessions`, `portal.py::list_portal_sessions`), `analytics/cohorts.py` (retention), `analytics/funnels.py` (funnel steps) |
| `agent_sessions` | **Ingest-side lifecycle record for one SDK-driven agent run** (F23: `session.begin()` → `.trace()` × N → `complete_session()`). Tracks success/failure and the raw `trace_ids` list as the SDK reports them. | `eden.services.agent_sessions.AgentSessionService`, via `/orgs/{org_id}/ingest/agent-sessions/*` (SDK, API-key auth) and `/orgs/{org_id}/agent-sessions/*` (portal/Clerk auth) | `api/routes/agent_sessions.py` (direct CRUD — used for the raw session record, not for aggregate analytics) |
| `user_sessions` | **Cat-9 "user intelligence" behavioral-analytics identity** — an app/site-visit-shaped session (anonymous-until-`identify()`, HMAC `session_secret`), used to compute engagement proxies: active/dormant/returned users, single-turn abandonment rate, median session length. This is a *different notion of session* from the other two — it is not keyed to agent runs or traces at all, only to `(org_id, user_id, session_id)` + first/last event timestamps and turn/trace counts. | `eden.services.app_intel.sessions.SessionIdentityService` (`/orgs/{org_id}/intelligence/user/sessions/*`) | `eden.services.user_intel.sessions.SessionAnalytics` (`/intelligence/user/sessions/aggregate`), `eden.services.user_intel.segments` (per-user segmentation) |

## Why three, not one

- `agent_sessions` is the **source of truth for one SDK run's outcome**
  (did this multi-turn agent interaction succeed?). It exists before any
  trace in it has finalized — `session.begin()` writes the row
  synchronously.
- `session_summaries` is a **derived, recompute-on-write aggregate over
  `telemetry_events`**, not over `agent_sessions`. It doesn't need
  `agent_sessions` to exist at all: any trace carrying a `session_id`
  (via `attributes->>'session_id'` or the typed column, however it got
  there — F23 SDK session helpers, a bare `session_id` tag, or an older
  SDK) rolls up into `session_summaries`. This is why it, not
  `agent_sessions`, is the right read model for "what happened across
  this session's turns" (cost, tokens, stumbles, issues, outcome) — it's
  computed from the same event stream every other trace/cost view reads,
  so its numbers can never disagree with the trace list for the same
  turns.
- `user_sessions` answers a **product-analytics question that has
  nothing to do with agent runs** — "is this end-user engaged, dormant,
  or churned?" — and predates F23/N12 (migration `024`, Cat 9 v1). It is
  *not* an auth/login-session table (verified against
  `services/app_intel/sessions.py` and migration `024`: no password,
  role, or auth-token columns — `session_secret` is an HMAC seed used
  only to prevent a caller from forging someone else's anonymous session
  id, the same shape as a web-analytics visitor-session cookie, not an
  auth session). Eden's actual login/auth sessions are Clerk-managed and
  have no dedicated Postgres table in this codebase.

## Join keys / relationships

There is **no foreign key** between any of the three tables — this is
the fragmentation the original finding (`features/11-session-analytics.md`)
flagged. The relationships that do exist are by convention, not by
constraint:

- `agent_sessions.id` (UUID, minted by `session.begin()`) is **the same
  string** the SDK then stamps onto every span in that run as
  `telemetry_events.session_id` / `attributes->>'session_id'` — which is
  exactly the value `session_summaries.session_id` is keyed by. So for
  any session created through the F23 SDK helpers,
  `agent_sessions.id::text = session_summaries.session_id` **for the
  same `org_id`**, even though nothing in the schema enforces it (no
  FK, no shared migration, and `session_summaries.session_id` accepts
  any string — a caller that tags spans with a session id from outside
  the SDK's `session.begin()` gets a `session_summaries` row with no
  corresponding `agent_sessions` row at all, which is an accepted,
  documented degradation, not a bug).
- `user_sessions.session_id` is **an unrelated namespace**
  (`secrets.token_hex(16)`, allocated by `SessionIdentityService.start()`)
  and is never joined to `agent_sessions.id` or `session_summaries.session_id`
  anywhere in the codebase. A given end-user's product-analytics session
  (`user_sessions`) and the agent runs they triggered during it
  (`agent_sessions` / `session_summaries`) share only `user_id` —
  there is no session-to-session join, so "which agent turns happened
  during web-session X" is not an answerable query today. That's a real
  gap, but it is a *different* one from the fragmented-metrics finding
  this doc addresses (FEAT-57's source doc is about session-based
  *product metrics* disagreeing across tables, not about cross-linking
  a web visit to the agent runs inside it) — flagging it here rather
  than silently merging it into the fix's scope.

## Canonical read model for product metrics

**Use `session_summaries` for anything answering "how did this
session/turn/agent-run go" at the product-metrics layer** — cost,
tokens, latency, turn count, outcome, stumble/issue counts, retention
cohorts, and funnel steps. This is already true of every consumer that
matters:

| Consumer | Table it reads | Verified |
|---|---|---|
| `analytics/cohorts.py` (`cohort_retention`, `list_cohorts`) | `session_summaries` | FEAT-56 (Wave 7) |
| `analytics/funnels.py` (`funnel`, Postgres fallback) | `session_summaries` | FEAT-53 (pre-Wave-7) |
| `api/routes/portal.py::list_portal_sessions` (portal `/sessions` list) | `session_summaries` via `eden.sessions.list_sessions` | FEAT-55 (pre-Wave-7) |
| `api/routes/sessions.py` timeline router (`/orgs/{org_id}/sessions`, `/sessions/{id}/timeline`) | `session_summaries` via `eden.sessions` | N12 (native) |

No remaining consumer was found querying `jobs`, `agent_sessions`, or
`user_sessions` for this class of "session/turn product metrics" —
grepped `FROM user_sessions`, `FROM agent_sessions`, `FROM
session_summaries`, `FROM jobs` across `src/eden/analytics/` and
`src/eden/api/routes/portal.py` on 2026-08-06; the only `agent_sessions`
reads are `services/agent_sessions.py`'s own CRUD (the raw ingest
record, which is its correct job) and `api/routes/agent_sessions.py`
(direct session lookup by id, not an aggregate). `user_sessions` reads
are confined to `services/user_intel/` and `services/app_intel/
sessions.py`, which is the Cat-9 behavioral-analytics surface these
rows exist for — not a stand-in for `session_summaries`.

**Do not add a new "product session analytics" read path against
`agent_sessions` or `user_sessions`.** If a future feature needs
per-turn cost/outcome/stumble data, it should read `session_summaries`
(via `eden.sessions.list_sessions` / `get_session_timeline`, or the
thin pointer in `eden.sessions.canonical` — see below) even if the
session in question originated from `agent_sessions`.

## What this doc deliberately does not do

Per the wave scope, this is "document + migrate consumers + add code
pointers," not a physical merge. `agent_sessions` and `user_sessions`
are **not being deleted or merged into `session_summaries`** — they
serve real, distinct purposes (ingest lifecycle record; user-behavioral
analytics identity) that `session_summaries` does not replace. A future,
separately-scoped piece of work could still:

1. Add an explicit FK/join hint (`session_summaries.agent_session_id`)
   so "agent run → rollup" is a constraint, not a convention. Not done
   here — it changes the rollup's write path
   (`eden/sessions/rollup.py::SessionRollupIndexer`) and needs its own
   migration + backfill design, which is out of this point's scope
   ("Large-but-sequenced," not "one more table merge migration").
2. Decide whether `user_sessions`-style engagement metrics should ever
   be joined to agent-run data (e.g., "did this web visit include an
   agent interaction that stumbled?"). No consumer asks this question
   today, so there is nothing to reconcile yet.

## Also verified (not fixed, out of scope for FEAT-152 / FEAT-57)

`services/governance_intel/gdpr.py`'s RTBF anonymization sweep
anonymizes `user_sessions.user_id` but not `agent_sessions.user_id` or
`session_summaries.user_id`. This is a real data-completeness gap
adjacent to this doc's subject, but it is governance/RTBF-owned code
(outside this batch's file scope) — noted here for whoever picks up
that surface next, not fixed in this pass.
