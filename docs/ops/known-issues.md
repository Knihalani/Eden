# Known issues — verified, not yet fixed

Every entry below was verified against current source (and, where
possible, against the live database) on 2026-07-30. Entries that turned
out to be wrong are recorded at the bottom rather than deleted, because
knowing a claim is false is worth as much as knowing one is true.

Ordered by live impact.

---

## Live, unfixed

### 1. ~~ClickHouse mirror discards write failures~~ — PARTLY FIXED 2026-07-30

`sink.insert` does not raise on a failed write; it returns an
`IngestionReport` with `rows_failed` set and parks the rows in
`clickhouse_fallback`. The collector discarded that value, so a
100%-failing mirror looked identical to a healthy one.

**Fixed:** the collector now reads `rows_failed`, counts the drop, and
logs at ERROR with the sink's own error text. `_fallback_to_postgres`
now records `error_message` — the column existed all along, which is
why all 82 parked rows (Jul 6 → Jul 24) carry a NULL reason.

**Still open:** the `clickhouse_fallback` drain is not advancing
(`n_tup_upd` and `n_tup_del` both 0 since Jul 6). The 82 existing rows
remain unreplayed and, being pre-fix, have no `error_message` to
diagnose from.

**Never customer-facing.** The durable write is Postgres
`telemetry_events`, and the portal trace list reads that same table.

### 2. Silver ETL reports every event as passing when validation fails

`data_platform/silver_etl.py:482` — the broad `except` returns
`(events, 0)`, so a failed quality validation is reported as "all events
passed, zero violations", surfaced only as a `logger.warning`.

Even on the success path (`:481`) it returns all `events` as passing, so
`run_batch`'s `normalized = passed` is a no-op and
`quarantine_on_violation` can never quarantine anything despite
`report.quality_violations` being non-zero. The inline comment concedes
this: *"we trust all events if the batch-level report passes."*

**Deliberately not fixed today.** `usage_events` is empty, so this
processes nothing, and a behaviour change to ETL error handling on
launch day is worse than the bug. Fix before metering goes live.

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
portal never calls `setActive` after sign-in.

**Fix is in the Clerk dashboard, not the codebase:** disable the forced
create-organization task, and call `setActive` on sign-in when the user
already has an org. (Eden's own `POST /orgs` now has an idempotency
guard, which was a genuine gap, but it was not the cause of these.)

### 7. Stale identity rows in production `users`

- One row has `clerk_id` set to another user's Eden primary key, so
  `id = X OR clerk_id = X` matches two rows. **Already fixed at the
  source** (`auth.py:954`, commit `80b25934`, one day after that row was
  created); no new ghosts since. The row itself should still be deleted.
- One row has `email = ''` while `users_email_key` is UNIQUE. If Clerk
  ever delivers a user with no email, `_upsert_user` inserts `email=''`,
  conflicts, and the recovery UPDATE re-claims that soft-deleted row for
  the new user. Unproven that Clerk can produce this; it is a one-row
  cleanup to eliminate the possibility.

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

### 11. `northflank.yml` secret groups do not match reality

`scripts/northflank_drift_check.py` reports exactly one remaining
drift, and it is informational:

```
manifest: eden-required (one group, 30 keys)
live    : 31 single-key groups under other names (JWT-SECRET, not JWT_SECRET)
```

Credentials **are** delivered and working — this is purely that the
manifest's `secretKeyRef` group name does not exist, so the file could
never be applied as written. Every other declaration (compute plan,
health checks, 61 environment variables) now matches the live project.

Not fixed today: rewriting 31 secret references in the deployment
manifest is not a change worth making on launch day for zero runtime
effect. Fix by updating the manifest to name the real groups — not by
restructuring the live secrets, which are working.

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
