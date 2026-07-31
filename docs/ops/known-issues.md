# Known issues — verified, not yet fixed

Every entry below was verified against current source (and, where
possible, against the live database) on 2026-07-30. Entries that turned
out to be wrong are recorded at the bottom rather than deleted, because
knowing a claim is false is worth as much as knowing one is true.

Ordered by live impact.

---

## Live, unfixed

### 1. ~~ClickHouse mirror discards write failures~~ — PARTLY FIXED 2026-07-30; drain settled 2026-07-31

`sink.insert` does not raise on a failed write; it returns an
`IngestionReport` with `rows_failed` set and parks the rows in
`clickhouse_fallback`. The collector discarded that value, so a
100%-failing mirror looked identical to a healthy one.

**Fixed:** the collector now reads `rows_failed`, counts the drop, and
logs at ERROR with the sink's own error text. `_fallback_to_postgres`
now records `error_message` — the column existed all along, which is
why all 82 parked rows (Jul 6 → Jul 24) carry a NULL reason.

**2026-07-31 status:** all 82 rows now have `resolved_at` set
(`open=0`, `dead=0`, `resolved=82`). Nothing remains in the drain
queue. Pre-fix rows with NULL `error_message` are historical only.
Never customer-facing — durable write is Postgres `telemetry_events`.

### 2. ~~Silver ETL reports every event as passing when validation fails~~ — FIXED 2026-07-31

`data_platform/silver_etl.py` previously round-tripped through a
Postgres temp table into ``validate_silver_events`` *before* silver
write, so the scan always matched zero rows and ``error_count`` was
always 0. A broad ``except`` then returned ``(events, 0)``, making
``quarantine_on_violation`` unreachable.

**Fixed:** `_validate_quality` now evaluates each event in-process via
``evaluate_row(..., SILVER_EVENT_EXPECTATIONS)``, returns only passing
events, and counts real violations. Failures log the specific
expectations. Safe today because `usage_events` is empty; required
before metering.

### 3. ~~`_push_clickhouse` logs a success it did not perform~~ — FIXED 2026-07-30

`if sink is None: return` no-op'd while `run_batch` logged
`Pushed {n} events to ClickHouse` regardless. `_push_clickhouse` now
returns a bool and the caller logs what actually happened.

### 4. ~~`reprocess_quarantine` deletes events it never reprocessed~~ — FIXED 2026-07-30

Events failing `json.loads` were silently `continue`d, then
`if report.silver_inserted > 0` deleted **all** `quarantine_ids`
including the dropped ones. A batch of 10 with 3 corrupt payloads and 7
successful inserts deleted all 10 — and the quarantine table is the
only copy, so this was permanent silent loss in the one place built
specifically to avoid losing data. Partial inserts had the same shape.

Now deletes only the ids actually reprocessed, and only on full
success; unparseable rows are logged at ERROR and kept.

### 5. ~~Clerk slug collision in the self-heal path fails silently~~ — FIXED 2026-07-30

`api/deps.py` inserted Clerk's `slug` verbatim while
`organizations.slug` is UNIQUE (`organizations_slug_key`, confirmed
against the live schema). `create_org` dedupes by appending 8 hex
chars; this path did not. On violation the INSERT raised, the handler
logged a warning and returned None, and `/auth/me` then answered 200
with no org — leaving the customer on "Syncing organization with Eden…"
permanently.

Zero duplicate slugs in production, which is exactly why it never fired
— and exactly why it would have fired on the day two real customers
picked the same organization name. Now dedupes the same way `create_org`
does.

### 6. Duplicate organizations are minted by Clerk, not by Eden

One production user owns 7 orgs, all named "Kaiav's Organization", one
per sign-in between Jul 12-24.

**The obvious explanation is wrong** and worth recording. Eden's mirror
is already idempotent (`deps.py:1045`, `INSERT ... WHERE NOT EXISTS`),
and there are 7 *distinct* `clerk_org_id`s. The name and the slug suffix
`1783846581937158695` (a Unix nanosecond timestamp) are generated
nowhere in this repo — Eden's slugifier appends `uuid4().hex[:8]`, 8 hex
characters, never 19 digits. A repo-wide grep for `'s Organization`
returns zero source hits.

These were created by **Clerk's hosted create-organization session
task**, which re-shows whenever the session has no active org. The
portal historically never called `setActive` after sign-in.

**Code fix (2026-07-31):** `OrgProvider` now calls `setActive` when the
user has Clerk memberships (or an Eden `clerk_org_id`) but no active
org.

**Ops fix (2026-07-31):** Clerk
`organization_settings.force_organization_selection` set to **false**
on both production (`ins_3FJJw1RScIsFcbJi7YLG6R2tmso`) and development
(`ins_3FG3Go0jmcbsGJ3xPOzNTsFfkSn`) via `clerk config patch`. Verified
with a follow-up `clerk config pull`.

### 7. ~~Stale identity rows in production `users`~~ — FIXED 2026-07-31

- One row had `clerk_id` set to another user's Eden primary key, so
  `id = X OR clerk_id = X` matched two rows. **Already fixed at the
  source** (`auth.py:954`, commit `80b25934`, one day after that row was
  created); no new ghosts since. The row itself was deleted 2026-07-31
  (`e0c21ab9-…`, zero FK refs).
- One row had `email = ''` while `users_email_key` is UNIQUE. Deleted
  2026-07-31 (`0446839d-…`, zero FK refs). Empty-email remaining: 0;
  clerk_id-ghost remaining: 0.

---

## Latent (unreachable today)

### 8. RTBF misses the tables holding user content

See `docs/ops/disabled-features.md` §2. Behind `rtbf_fanout_v1=False`;
its two bypass callers are both dead code (`rtbf_tracker.py` has no
production callers; `promotion_hooks.py:678` calls `process_request`
without its required `org_id` and raises into a swallowed `except`).

The dead auto-fire block at `promotion_hooks.py:668-688` is a candidate
for deletion.

### 9. D.14 onboarding state machine writes to columns that do not exist

`services/onboarding/state_machine.py` uses `current_step`,
`completed_steps`, `cat_enablements`, `first_trace_at`,
`milestones_reached`. The live table has `org_id`, `step`,
`org_setup_choice`, `completed_by_users`, `agents_onboarded`,
`updated_at`. `_persist` swallows the failure at `logger.debug` and
returns a synthetic `StateRow`, and the routes return
`{"status":"ok","live":true}`. Advance, milestone and enable_cat all
report success and persist nothing.

Root cause is the two parallel migration systems:
`migrations/029_onboarding_wizard.sql:62` created the live table, and
alembic `056_onboarding_state.py:51` uses `CREATE TABLE IF NOT EXISTS`
so it silently no-op'd — while alembic still records 056 as applied.

**Blast radius is small:** the portal does not call these endpoints
(`onboardingV2Api` has zero component consumers, and the server-side
`OnboardingMilestoneHook` is never instantiated). The wizard the portal
actually uses is `/orgs/{org}/onboarding/state` in `routes/github.py:1301`,
which matches the live schema and does persist — 6 production rows prove
it.

This is a landmine in the public OpenAPI surface, not an active break.
Either delete `services/onboarding/` + `routes/onboarding.py`, or write
a real migration. Do not ship endpoints that only claim "ok".

---

## Infrastructure

### 10. Upstash Redis is at its hard limit

`/health` reports `max requests limit exceeded. Limit: 500000, Usage:
500000`. The fleet is riding the Postgres leader-election fallback.

**Not currently customer-visible:** `/ready` is 200, the liveness and
readiness probes target `/ready` and `/live` (not `/health`), rate
limiting still works, and requests succeed.

The quota resets at the start of the month. The burn that consumed it
was the *pre*-2026-07-29 configuration (20s renewals on two permanently
held locks plus 120s leader ticks ≈ 17k/day ≈ 510k/month — which lands
almost exactly on the 500k observed). The current configuration measures
at ~3,488/day ≈ 106k/month, i.e. 21% of the free allowance, so this
should not recur.

---

### 11. ~~`northflank.yml` secret groups do not match reality~~ — FIXED 2026-07-31

Manifest `secretKeyRef` groups now name the live single-key groups
(`jwt-secret`, `postgres-host`, …) with the live key names
(`JWT_SECRET`, `POSTGRES-HOST`, …). Optional keys that do not exist
live (`POSTGRES_CHANNEL_BINDING`, `TYPESENSE_*`, `METRICS_BEARER_TOKEN`)
remain pointed at the fictional `eden-required` group with
`optional: true` so apply does not fail. Do **not** reshape live
secrets.

---

## Checked and found healthy

Recorded so the same ground is not re-covered:

- **API key issuance** (`routes/api_keys.py:325-465`) propagates real
  503/409/400/404 with no success-shaped degradation. Fresh keys get
  `ingest:write` by default.
- **Durable trace ingest** raises `IngestionUnavailable` → HTTP 503 with
  `Retry-After` on Postgres failure, rather than a fake 200.
- **Clerk webhook signature verification** — proper HMAC, 5-minute
  replay window, refuses when the signing secret is unset.
  `CLERK_WEBHOOK_SIGNING_SECRET` is confirmed present in production.
- **Export catalogs** — all six `fetch_*` queries validated against the
  live schema twice (every column checked against
  `information_schema.columns`, and every query EXPLAINed). A prior
  report that 3 of 6 named nonexistent columns was accurate when
  written and has since been fixed in `c61b06c7`.
- **LLM spend on timers is genuinely zero** — `evolution_loop_enabled`
  and `judges_async_tailer_enabled` are both False and not overridden in
  `northflank.yml`; `usage_events`, `evolution_ops_spend` and
  `production_eval_daily_spend` are all empty.
- **No dangling `create_task` / un-awaited coroutines** anywhere.
- **Settings-flag drift is zero** repo-wide.

---

## Fixed later on 2026-07-30 (recorded so they are not re-investigated)

- **Quota middleware blocked at two thirds of the cap.** `_evaluate_hard_limits`
  blocked on `soft_exceeded` and on any utilisation >= 80%, against the
  contract at `plan_tiers.py:71`. `cost_usd` is a global mutating resource,
  so this ran on every POST/PUT/PATCH/DELETE. Now blocks only on a hard
  breach. This was the single biggest launch risk found.
- **`/ingest/chunks` had never stored a row** — `chunk_id` built as
  `f"{event_id}:{chunk_index}"` for a `uuid NOT NULL` column. Same defect
  class as the app-events bug. Now `uuid5`, preserving idempotency.
- **13 tables the code queries did not exist.** Alembic reported head, so
  `upgrade` was a permanent no-op. Created from the project's own DDL.
- **`onboarding_state` missing 6 columns** — the D.14 state machine reported
  `{"status":"ok"}` and persisted nothing. Columns added; its real SELECT
  now prepares.
- **Login ignored `deleted_at`** — account deletion did not stick.
- **`get_org_resource_limits` omitted `plan_name` / `requests_per_minute`**,
  so every org was rate-limited at the default and evaluated as `org_free`.
- **WebSocket `receive_task` UnboundLocalError** in a `finally`, leaking a
  connection-registry entry per aborted handshake.
- **`send_password_reset_email` did not exist** — the ImportError was
  swallowed and the endpoint returned 200. Every password-auth user who
  forgot their password was permanently locked out. Implemented; dispatch
  failure now logs at ERROR.
- **SDKs ignored `rejected`** — a fully-rejected batch looked like a clean
  flush, and `doctor` reported `ok: true` off a 2xx alone. Both SDKs now
  parse the body; `doctor` requires acceptance.
- **`/portal/keys` returned `[]` on failure** — same class as `/orgs`; a
  customer would mint a duplicate key. Now 503.
- **`/health` could not see a read-only database.** Witnessed live: the Neon
  endpoint went read-only for ~2 minutes, all writes failed, and `/health`
  reported `postgres: connected` throughout.

---

## ROOT CAUSE, found 2026-07-30 20:19Z — Northflank is not draining old replicasets

The service is configured `instances: 1`. It was running **10 containers
across 6 replicasets**, the oldest up more than two hours and surviving
many deploys:

```
eden-api-67478966c   x2  since 20:16:54Z   <- newest build
eden-api-75d5fd5d85  x2  since 19:54:34Z
eden-api-7c8b4d9c47  x2  since 19:52:14Z
eden-api-577dd78fcb  x2  since 19:48:56Z
eden-api-66f6d66d7b  x1  since 19:45:11Z
eden-api-6b659fb59d  x1  since 18:15:08Z   <- held BOTH leader locks
```

Found via the Northflank REST API (`/services/eden-api/containers`);
the CLI has no logs or instances command, and the service status fields
report `COMPLETED/DEPLOYING` and `SUCCESS/IN_PROGRESS` in combinations
that do not mean what they sound like.

### This is one bug, not four

Several separately-investigated symptoms collapse into this:

* **Deploys never complete.** New pods come up healthy, old pods are
  never drained, traffic keeps going to an old one. Confirmed: a build
  succeeded at 19:54 and 21 minutes later — with no interfering pushes —
  the old image was still serving.
* **Upstash hit its 500,000 hard limit.** The cost audit attributed this
  to the pre-2026-07-29 lock-renewal cadence, and the arithmetic landed
  suspiciously exactly on 500k. Ten fleets each attempting lock
  acquisition on their tick is a better explanation. **Treat that part
  of the cost audit as unreliable** — it assumed one fleet.
* **Neon never reached its suspend timeout.** Same correction: ten
  fleets polling keeps it awake regardless of any one interval.
* **The background fleet was running stale code.** `eden_leader_leases`
  showed both locks held by `eden-api-6b659fb59d-xhcxs`, the container
  from 18:15 — so every worker-side fix landed today was inert, and that
  container predates the `EDEN_PRODUCTION=1` env change applied at
  ~19:05, leaving the fleet in a different config from the rest.

### Not an outage

`/ready` 200 throughout. Postgres at 15 of 901 connections with
pgbouncer pooling correctly. Leader election worked exactly as designed
— one holder, both locks, no split brain. This is waste and a stuck
pipeline, not data loss.

### Fix

Scale the service to 0 and back to 1. That drops every replicaset and
brings up one container on the current image, so the pending commits
land and the fleet restarts on current code with production mode
actually applied. Seconds of downtime at zero users.

Do it in the same pass as setting `PORTAL_BASE_URL` (see below), since
both need one restart.

### Prevention

`/live` now reports `commit` from the `EDEN_GIT_SHA` build arg. Twice
today "is it deployed?" was unanswerable — `app_version` is a
hand-maintained `0.1.0` that names the release, never the code, and the
only reliable check was probing for a route one commit happened to
remove.
