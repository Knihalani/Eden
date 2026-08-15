# Storage & Retention Optimization

## Correction to initial assumption
Eden is **not** missing a retention/tiering story — it already has a fairly mature one under `src/eden/data_platform/`:
- `retention.py`: `DataRetentionManager` — `RetentionPolicy`/`RetentionReport` dataclasses, `purge_pii_fields`, `archive_to_cold` (→ S3), `delete_tenant_data` / `export_user_data` (GDPR-shaped), `purge_archived_telemetry`, `load_org_warm_days` (per-org configurable warm-tier window, `retention.py:569`), `run_all_policies`.
- `storage_lifecycle.py`: `StorageLifecycleManager` — `TierTransition`/`LifecycleReport`, `apply_s3_lifecycle_rules`, `transition_to_warm`, `transition_s3_prefix`, `expire_temporary_data`, `get_storage_summary`.
- `retention_cron.py`: a `run(dry_run=False)` entrypoint, scheduled daily (see below), that drives policies + S3 lifecycle + a per-org cold-archive pass via `ArchiveService`.
- `columnar/compaction.py`: `ColumnarCompactor.compact_due(max_age_hours=24, limit=50)` — ClickHouse `OPTIMIZE`-based segment compaction, batched.

But this pass found the mature-looking system is **enforced for only 2 of its 8 declared policies** (see below) — "has retention infra" and "retention is actually happening" turned out to be different claims for 6 of the 8 rows in `DEFAULT_POLICIES`.

## Verified (prior pass, re-confirmed)
1. **`retention_cron.py` IS scheduled.** `src/eden/workers/cron_tick.py:135` imports `from eden.data_platform.retention_cron import run as retention_run` and invokes it at `cron_tick.py:142` inside the daily 03:00 UTC job. Not dead code. A second, independent live trigger path exists too: the admin route `POST /orgs/{org_id}/retention/run` (`src/eden/api/routes/data_platform.py:490-509`) also calls `run_retention_policy`/`run_all_policies` on a fresh `DataRetentionManager` — same dispatch logic, same 2-of-8-live split. It doesn't rescue any of the 6 no-op policies; it's just a second door into the identical code, worth knowing about for completeness (e.g. if someone assumes only the daily cron can trigger a run). (`retention_cron.py`'s own module docstring is separately stale — it says "Runs all 7 retention policies" when `DEFAULT_POLICIES` has had 8 entries since the file was introduced; cosmetic, doesn't affect behavior since the code iterates `retention.policies` rather than a hardcoded count.)
2. **Default `warm_days` is 90 days** for `raw_traces`, defined in `DEFAULT_POLICIES` at `src/eden/data_platform/retention.py:49-60`. New orgs get a sane default (90d hot/warm before archive) unless overridden via `load_org_warm_days` (`retention.py:569-580`, reads per-tenant overrides from `org_retention_policies`) — not unbounded by default. Resolved.
3. **RCA/signal-investigator queries are NOT tier-aware.** `grep -in "warm_days|cold_tier|tier"` across `src/eden/api/routes/intelligence_rca.py` and `src/eden/api/routes/signal_investigator.py` returns zero matches — old/archived data beyond `warm_days` is invisible to RCA. Low urgency (90d hot window covers most active investigations) but worth a ticket.

## 6 of the 8 `DEFAULT_POLICIES` entries are declarative only — not enforced
`DEFAULT_POLICIES` at `retention.py:49-60` declares all 8 policies with their exact `(hot_days, warm_days, cold_days, delete_after_days)` tuples:

```python
RetentionPolicy("raw_traces", 7, 90, 2555, 90, scrub_pii_after_days=30)
RetentionPolicy("derived_metrics", 7, 90, 2555, 2555)
RetentionPolicy("user_feedback", 7, 90, 2555, 2555)
RetentionPolicy("training_datasets", 7, 90, 2555, 2555)
RetentionPolicy("audit_logs", 7, 90, 2555, 2555)
RetentionPolicy("error_logs", 7, 30, 90, 90)
RetentionPolicy("debug_dumps", 7, 0, 0, 7)
RetentionPolicy("quarantine_events", 7, 30, 90, 90)
```

Reading the actual dispatch logic in `run_retention_policy` (`retention.py:456-505`) — the method every policy is run through, called once per policy from `retention_cron.py:51-57` — shows only **two** data types have real code paths:
- `raw_traces`: archived via `_ARCHIVE_TABLE_BY_TYPE["raw_traces"] = "silver_events"` (`retention.py:62-67`) then deleted via `purge_archived_telemetry` (`retention.py:494-497`).
- `debug_dumps`: cleaned via `cleanup_debug_dumps` (dispatch at `retention.py:484-489`).

For the other 6 (`derived_metrics`, `user_feedback`, `training_datasets`, `audit_logs`, `error_logs`, `quarantine_events`): `archive_table` is `None` (only `raw_traces` is in `_ARCHIVE_TABLE_BY_TYPE`) and `policy.data_type != "debug_dumps"`, so the archival branch is skipped; then at deletion time `policy.data_type != "raw_traces"` and `delete_after_days > warm_days` for every one of them, so the `elif` at `retention.py:498` is also false — **the entire method is a silent no-op** for these 6 policies, returning an empty `RetentionReport()`. Confirmed by `tests/data_platform/test_retention_cron.py:17-51`: the tests only assert the policy *keys* exist in the results dict and that runs don't raise — never that any row was archived or deleted for these 6 types.

Compounding this: `error_logs`, `audit_logs`, `derived_metrics`, and `training_datasets` have **no backing Postgres table anywhere** — `grep -rn "CREATE TABLE.*<name>" src/eden/db_migrations/` returns zero hits for all four. They're policy-list entries with nothing to purge. (`user_feedback` and `quarantine_events` do have real tables — `020_intelligence_gap_tables.py:559-571` and `008_phase_5_5_data_platform.py:77-99`, respectively — but still fall through the no-op branch above.)

Net: the "mature hot/warm/cold system" claim from the initial pass is real for exactly one table category (`raw_traces`/`silver_events`, plus `debug_dumps` S3 cleanup). Everything else in `DEFAULT_POLICIES` is aspirational.

## The checkpoint-blob retention gap is real, but on a different (newer) table than first identified
The original finding was that `checkpoint_blobs` has no retention policy. That's still true, but deeper tracing shows `checkpoint_blobs` **is legacy and no longer actively written to** — the live growth risk is actually its untracked successor, `trace_replay_sessions`.

**`checkpoint_blobs`** — table at `src/eden/db_migrations/versions/001_initial_schema.py:133-141`:
```sql
CREATE TABLE IF NOT EXISTS checkpoint_blobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id VARCHAR(255) NOT NULL,
    field VARCHAR(100) NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(job_id, field)
)
```
No TTL column; absent from `DEFAULT_POLICIES` (grep for "checkpoint" in `retention.py`/`storage_lifecycle.py` returns zero hits). But:
- Writes go through `insert_checkpoint_blob` (`src/eden/storage/postgres.py:1262-1272`), an **upsert** (`ON CONFLICT (job_id, field) DO UPDATE`) — so growth is bounded per `(job_id, field)`, not one row per checkpoint event.
- `insert_checkpoint_blob`, `get_checkpoint_blob`/`get_checkpoint_blobs` (`postgres.py:1285-1303`), and `delete_checkpoint_blobs` (`postgres.py:1305-1307`, which already exists and could delete-on-job-completion but is never called) have **zero production callers anywhere in `src/eden`** — only referenced in the mocked test fixture `tests/conftest.py:269-271`.
- `src/eden/observability/checkpoint/rewind.py:8-19` states directly: *"the original Cat 1 appendix referenced the `checkpoint_blobs` table from migration 001, but that table is keyed by `(job_id, field)` and predates the trace_id naming convention... `checkpoint_blobs` is read-only per the Phase 2 cutover and is still surfaced for legacy job-style workflows."*
- `checkpoint_blobs` **is** still read live: `src/eden/api/routes/websocket.py:372-384`/`:387-415` poll it directly for the live job-trace websocket stream. Not dead code, but no confirmed write path today.

**`trace_replay_sessions`** — the actual current write path for Cat-1 rewind, table at `src/eden/db_migrations/versions/020_intelligence_gap_tables.py:87-100`:
```sql
id UUID PRIMARY KEY, org_id VARCHAR(128), trace_id VARCHAR(128), user_id VARCHAR(128),
cursor INTEGER DEFAULT 0, state_json TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
```
Written via `upsert_session` (`src/eden/observability/_trace_common.py:205-244`): delete-then-insert per `(org_id, trace_id)` (no unique constraint exists, so the app does it manually — comment at line 215-218 confirms this is intentional), bounding it to 1 row per distinct trace ever rewound. `state_json` is unbounded `TEXT` (full captured agent state at a step) and **also absent from `DEFAULT_POLICIES`**.

## Deeper (this pass): the replay UI is stubbed — the write path is live but currently driving ~zero organic traffic

Prior passes could not produce a concrete rows/GB-per-month estimate for `trace_replay_sessions`. Tracing the full call chain from user action → `upsert_session` explains why, and changes the estimate materially.

**The only writer is `ReplayService.replay_trace`.** `upsert_session` is called once per call to `replay_trace` (`src/eden/observability/replay/service.py:98-100`), regardless of `cursor` — so paging through a trace's events just re-upserts the same `(org_id, trace_id)` row (delete+insert on the same key), it does not add rows per page. Row count is strictly "distinct `(org_id, trace_id)` pairs ever passed to this endpoint," not "pages fetched" or "checkpoints written." `replay_trace` is reached from exactly one place in the whole codebase: `POST /orgs/{org_id}/intelligence/replay/{trace_id}/replay` (`src/eden/api/routes/intelligence_replay.py:184-192`). A name-collision red herring: `src/eden/change_impact/preview.py` has its own private `_replay_trace` method (`preview.py:252`), but it calls `LivePrefixEngine`/`CheckpointStore`, not `ReplayService` — it does not touch `trace_replay_sessions` at all.

**The portal's Replay page is a stub, redirected away before it can call the endpoint.** `/replay` is listed in `STUB_PORTAL_PATH_PREFIXES` (`clients/portal/src/lib/portal-routes.ts:6-44`, entry at line 40) — "Still-stub surfaces — middleware may redirect these to /rebuild." The one frontend client function that would drive traffic, `getTraceReplay` (`clients/portal/src/lib/api/resources.ts:1283-1352`), has **zero call sites anywhere else in `clients/portal/src`** — a repo-wide grep for `getTraceReplay` only matches its own definition. A regression test further confirms the higher-level `replayApi` facade was deliberately deleted as a "zero-consumer `*Api` namespace" (`clients/portal/src/lib/api/__tests__/dead-code-removal.test.ts:17-57`, `replayApi` listed at line 51) with a test asserting it *stays* deleted.

**But the backend is not gated off** — `intelligence_gap_v0` defaults to `True` globally (`src/eden/config.py:225`), it's not a per-org opt-in, so `require_feature_flag("intelligence_gap_v0")` (`intelligence_replay.py:51`) passes for everyone. Any direct API/SDK caller, integration test, or manual QA session that hits `POST .../replay` today writes a real, permanent row — there's just no product surface generating that traffic yet. No scheduled/cron caller was found either (grep across `src/eden` for calls into `ReplayService`/`replay_trace` outside the route file and tests returns nothing).

There's also a **third, related table worth flagging**: `replay_sessions` (singular concept, different table — `src/eden/db_migrations/versions/029_replay_sessions.py`, added for `POST /orgs/{org_id}/intelligence/replay/sessions`, `intelligence_replay.py:105-182`). Unlike `trace_replay_sessions`, "scratch" sessions (`name IS NULL`) are **always inserted as new rows**, not upserted (`029_replay_sessions.py:1-21`, `_create_replay_session_row` at `intelligence_replay.py:146-182`) — no dedup at all for the common case. It's absent from `DEFAULT_POLICIES` too, but like `getTraceReplay`, it currently has no confirmed frontend caller — same "built but not yet driving traffic" status. If/when the replay UI ships, this table's growth model is *worse* than `trace_replay_sessions`' (unbounded rows per open, not per distinct trace) and should get its own TTL in the same pass rather than being another silent gap.

**The design doc itself flagged this and never answered it.** `docs/docs/observability/01-trace-replay.md:313-316`, under Open Questions: *"Replay session TTL — how long does an open replay session live before garbage collection? (Owner: Cat 1 lead)"* — filed at initial implementation (2026-06-10), still unanswered.

### Growth estimate

**Today:** effectively 0 net-new rows/month from the product surface (no reachable UI entry point); whatever exists is residue from direct API testing/QA, not user-driven debugging activity. This is a materially different — and better — answer than "no rows/day estimate could be found": the reason no estimate exists is that there is no live traffic driving the table today, not that the traffic is unmeasured.

**On launch (the feature is otherwise complete — service, route, migration, and frontend client function all already exist; shipping is a matter of removing `/replay` from `STUB_PORTAL_PATH_PREFIXES`, not building it):** modeling by analogy to comparable debug/replay tooling adoption (see Web research below) — a small fraction of active engineers use replay/rewind specifically during incident or regression investigation, not on every trace viewed:
- Illustrative low/mid case: 20 active orgs × 5 engineers/org × 3 distinct traces investigated/week ≈ 300 new `(org_id, trace_id)` keys/week ≈ **~1,300 rows/month**. Treat this as a placeholder, not a validated figure — the 20-org input is aspirational/future-state and is not reconciled against Eden's actual measured scale: production had **9 orgs** as of 2026-07-29 (`src/eden/workers/cron_tick.py:80-81`, also cited in `optimizations/05-cron-jobs.md:151-153`), more than 2x smaller. The qualitative point ("a small fraction of active orgs use replay/rewind per week, not every trace viewed") is the load-bearing part of this estimate; the specific arithmetic should be re-derived once real org-count/seat data is available rather than cited as-is.
- Per-row size: the `state_json` payload written by `replay_trace` (`service.py:89-97`) is a small `{last_event_id, last_timestamp, events_seen}` dict, well under 1KB — so baseline growth at that usage level is roughly **1-2 MB/month**, immaterial as a storage line item on its own.
- The real risk is not baseline rate — it's that `state_json TEXT` / `checkpoint_blobs.value JSONB` have **no size ceiling at the schema level**, and the migration's own intent is "full captured agent state at a step" (`020_intelligence_gap_tables.py` docstring), so a handful of heavy debug sessions on large agent states can dominate table size independent of row count, and with `delete_after_days` absent from `DEFAULT_POLICIES` there is currently zero decay to bound that — a slow, invisible creep rather than a growth-rate crisis, but one with no dashboard signal (`get_storage_summary()` doesn't track it, see below) and no ceiling.

## Git archaeology: why 4 `DEFAULT_POLICIES` entries reference tables that don't exist

`git log --all --follow -- "src/eden/data_platform/retention.py"` shows the file was introduced whole — 387 lines added in one commit (`7802fb68` / `25597fcd` / `129a6fad` / `f2125356`, all identical duplicates of the same "feat: land pre-batch Eden Phase 0/1/2/3 implementation" landing across branch history). `git show 7802fb68 -- src/eden/data_platform/retention.py` shows **all 8 `DEFAULT_POLICIES` rows, including the 4 phantom ones, were present from that very first commit** — verbatim identical to today's list. This rules out "renamed table" as the explanation: there is no intermediate commit where these names pointed at real tables that later got renamed or dropped. They were **speculative/aspirational entries written before the corresponding schema existed**, sketching out a broader data-platform retention story (PII redaction, archival, GDPR export, debug cleanup, error/audit log cleanup, dataset retention) at design time, several of which were simply never built out as their own tables.

Checking whether *anything resembling* these 4 concepts got built later, under a different name, in subsequent migrations:
- **`training_datasets` → real analog exists:** `datasets`, `dataset_items`, `dataset_snapshots` (`db_migrations/versions/101_eval_loop.py:18-56`) and `fine_tuning_runs`/`dataset_trace_lineage` (`061_fine_tune_lineage.py:9-31`) were added much later and cover exactly this concept — under different, more specific names. Nobody reconciled `DEFAULT_POLICIES` with the schema that actually shipped.
- **`derived_metrics` → real analog exists:** `custom_metric_runs` (`099_intel_metric_runs_alert_firings.py:41`) and `telemetry_streaming_metrics` (`011_capture_full_payloads.py:196`) are the closest real equivalents — again, different names, added later, never wired back into retention.
- **`audit_logs` → real analog exists:** `agent_audit_ledger` (`092_market_ready_consolidated.py:501`) is a genuine audit table that arguably *should* have a compliance-grade retention policy (the dead entry's `delete_after_days=2555` ≈ 7 years hints this was the original intent) but was never connected.
- **`error_logs` → no analog anywhere.** `grep -rn "CREATE TABLE.*error" src/eden/db_migrations/versions/*.py` returns zero hits, and no other table name in the schema plausibly maps to a dedicated error-log store — errors live inline as fields (`outcome`, `attributes`) on `telemetry_events`. This one is pure vaporware with no successor to redirect to.

## Precise dispatch trace: why `user_feedback` and `quarantine_events` no-op — and why one whole branch is dead for all 8 policies

Reading `run_retention_policy` (`retention.py:456-505`) line-by-line for these two (both have real backing tables, so they're the cases where "wire it up" is actually possible, unlike the 4 above):

```python
async def run_retention_policy(self, policy: RetentionPolicy) -> RetentionReport:
    ...
    if policy.scrub_pii_after_days is not None and policy.data_type in _ARCHIVE_TABLE_BY_TYPE:
        ...                                                            # (462-470)
    archive_table = _ARCHIVE_TABLE_BY_TYPE.get(policy.data_type)
    if archive_table is not None and policy.warm_days > 0:
        ...                                                            # (475-483)
    elif policy.data_type == "debug_dumps":
        ...                                                            # (484-489)
    delete_before = now - timedelta(days=policy.delete_after_days)
    if policy.data_type == "raw_traces":
        ...                                                            # (494-497)
    elif policy.delete_after_days <= policy.warm_days:
        logger.info(f"Skipping deletion for {policy.data_type} — handled by archival")  # (498-501)
    return report
```

- `user_feedback`: `RetentionPolicy("user_feedback", 7, 90, 2555, 2555)` — `scrub_pii_after_days=None` → PII branch skipped. `archive_table = None` (not in `_ARCHIVE_TABLE_BY_TYPE`) and `data_type != "debug_dumps"` → both the `if` and `elif` at 475/484 are skipped. `data_type != "raw_traces"`, and `2555 <= 90` is **False** → the `elif` at 498 is also skipped. Zero of the four branches fire. No DB call, no log line (even the "skipping deletion" `logger.info` never executes, since it's gated by the same false condition), no error — `run_retention_policy` returns an all-zero `RetentionReport()` that is indistinguishable from "ran and had nothing to do."
- `quarantine_events`: `RetentionPolicy("quarantine_events", 7, 30, 90, 90)` — identical shape: PII skipped (`scrub_pii_after_days=None`), archive/debug_dumps skipped (`archive_table=None`, not `debug_dumps`), and `90 <= 30` is **False** → deletion `elif` also skipped. Same silent zero-op result.

**Sharper finding: the `elif policy.delete_after_days <= policy.warm_days` branch at `retention.py:498` never actually fires for any of the 8 current policies, not just the 6 no-op ones — but for a subtler reason than "the numbers are all False."** Checking all 8 with the correct current values: `raw_traces` (`delete_after_days=90`, `warm_days=90` → `90 <= 90` is **True** — this is the one policy for which the condition would actually evaluate true if it were ever reached, but it's caught by the dedicated `if policy.data_type == "raw_traces":` branch immediately above, so the `elif` is never evaluated for it at all), `derived_metrics` (2555 vs 90 → False), `user_feedback` (2555 vs 90 → False), `training_datasets` (2555 vs 90 → False), `audit_logs` (2555 vs 90 → False), `error_logs` (90 vs 30 → False), `debug_dumps` (7 vs 0 → False, but its actual cleanup already happened earlier via the dedicated `elif` at line 484), `quarantine_events` (90 vs 30 → False). So the branch is dead in practice for a mix of reasons: for 6 policies the numeric comparison is genuinely False; for `raw_traces` it's intercepted by an earlier `if` regardless of what the numbers say; only `debug_dumps` has its own dedicated branch. It's dead code today, not "code that handles 2 of 8 correctly and 6 of 8 incorrectly" — and the `if`/`elif` *structure*, not the specific `delete_after_days` values, is what's doing the work of routing `raw_traces` away from this branch.

## Other storage-growth risks found (beyond checkpoint tables)
- `quarantine_events` (`db_migrations/versions/008_phase_5_5_data_platform.py:77-99`, columns include `quarantined_at`, `resolution`) is declared in `DEFAULT_POLICIES` (`warm_days=30, delete_after_days=90`) but — per the no-op analysis above — that policy is never enforced by the cron. Its only deletion path is `silver_etl.py:797-803`, which removes rows **only on successful reprocessing**; rows with unparseable payloads (`silver_etl.py:774-778`) or that are never reprocessed are kept forever with no age-based cleanup. This is the one no-op fix with a currently-confirmed live unbounded-growth mechanism, not just a hygiene gap.
- `get_storage_summary()` (`storage_lifecycle.py:525-541`), the one function meant to give ops visibility into hot-storage growth, only counts `usage_events`, `silver_events`, and `quarantine_events` (line 536) — it doesn't track `checkpoint_blobs`, `trace_replay_sessions`, `replay_sessions`, or any of the 6 no-op-policy tables, so none of the actual gaps found in this pass are visible in the one dashboard-ready summary that exists.

## Complete fix design

### 1. `trace_replay_sessions` / `checkpoint_blobs` — new policies, mirroring `debug_dumps`' shape

```python
RetentionPolicy("trace_replay_sessions", 7, 0, 0, 30),
RetentionPolicy("checkpoint_blobs", 7, 0, 0, 30),
```
`warm_days=0` (no cold tier — this is throwaway debug state, not audit/compliance data) and `delete_after_days=30`, the same "hot-only, short TTL" shape as `debug_dumps` (`7, 0, 0, 7`), just with a slightly longer window (see Web research below for why 30 rather than 7).

**Important:** adding these rows to `DEFAULT_POLICIES` alone is *not sufficient* — per the "one whole branch is dead" finding above, `warm_days=0, delete_after_days=30` does **not** satisfy `delete_after_days <= warm_days` (30 ≤ 0 is False), so it would silently fall into the exact same no-op path as the other 6. Real dispatch branches are required, mirroring the existing `debug_dumps` pattern at `retention.py:484-489`:
```python
elif policy.data_type == "trace_replay_sessions":
    cutoff = now - timedelta(days=policy.delete_after_days)
    report.deleted_rows = await self.cleanup_replay_sessions(cutoff)
elif policy.data_type == "checkpoint_blobs":
    cutoff = now - timedelta(days=policy.delete_after_days)
    report.deleted_rows = await self.cleanup_checkpoint_blobs(cutoff)
```
with two new manager methods doing simple age-based purges — no archive step needed:
```sql
DELETE FROM trace_replay_sessions WHERE updated_at < $1;   -- cleanup_replay_sessions
DELETE FROM checkpoint_blobs      WHERE created_at < $1;   -- cleanup_checkpoint_blobs
```
`checkpoint_blobs` gets the same policy for defense-in-depth even though its write path is currently dormant — cheap insurance against a not-yet-found write path. Also add `replay_sessions` (migration 029, the third table found this pass) to the same fix in the same PR — same TTL, same "add a dispatch branch" requirement — since it shares the exact "built, unmonitored, not yet in `DEFAULT_POLICIES`" profile and its unbounded-scratch-session-insert growth model is worse than either of the other two once the UI ships.

### 2. Decision for each of the 6 no-op `DEFAULT_POLICIES` entries — don't leave dead config lying to readers

| Policy | Real table? | Decision | Why |
|---|---|---|---|
| `error_logs` | No, no analog anywhere | **REMOVE**, no follow-up | Zero real or adjacent table in the schema; errors live inline on `telemetry_events`. Pure vaporware. |
| `derived_metrics` | No, no analog | **REMOVE**, no follow-up | Zero table anywhere named or shaped like this; `custom_metric_runs`/`telemetry_streaming_metrics` are separate features, not stand-ins. |
| `training_datasets` | No (real analogs exist: `datasets`/`dataset_items`/`dataset_snapshots`) | **REMOVE** the phantom entry; file a follow-up to add a correctly-named policy for the real dataset tables | The name never matched shipped schema; resurrect the *intent* under the real table names, not this entry. |
| `audit_logs` | No (real analog exists: `agent_audit_ledger`) | **REMOVE** the phantom entry; file a follow-up (higher priority than the above) to add `agent_audit_ledger` under its real name | It's a genuine audit ledger with compliance/legal-hold implications — worth a deliberate decision, not a silent drop. |
| `user_feedback` | **Yes** (`020_intelligence_gap_tables.py:559-571`, `created_at` column) | **IMPLEMENT** | Real table, values already sane (`warm_days=90, delete_after_days=2555`≈7yr). Add `elif policy.data_type == "user_feedback": report.deleted_rows = await client.execute("DELETE FROM user_feedback WHERE created_at < $1", cutoff)`. Low urgency (7-year window rarely fires) but should be honest. |
| `quarantine_events` | **Yes** (`008_phase_5_5_data_platform.py:77-99`, `quarantined_at`/`resolution` columns) | **IMPLEMENT — highest priority of the 6** | Same pattern: `DELETE FROM quarantine_events WHERE quarantined_at < $1` at the existing `delete_after_days=90`, independent of `resolution`. This is the one policy among the 6 with a *currently confirmed* live unbounded-growth mechanism (unreprocessed/unparseable rows never age out today), not just a false-confidence hygiene issue. |

### 3. Other carried-over recommendations
- Extend `get_storage_summary()` to include `checkpoint_blobs`, `trace_replay_sessions`, `replay_sessions`, and `quarantine_events`'s unreprocessed-row count, then surface it in the portal/ops dashboard. Currently `get_storage_summary()` returns row counts only (`storage_lifecycle.py:536`, `SELECT COUNT(*)`) — no table anywhere in `data_platform/` or `storage/` tracks byte size or a $/GB figure (repo-wide grep for `bytes_used|table_size|pg_total_relation_size|storage_cost` returns nothing relevant). Worth folding a byte-size column (e.g. `pg_total_relation_size`) into the same extension, not just adding more tables to the row-count list — that's the smallest change that would finally make a $/GB storage-cost conversation possible for this system.
- File a follow-up ticket for RCA/signal-investigator route tier-awareness (confirmed gap, low urgency).
- **Note for whoever picks up `retention_cron.py` next:** `optimizations/05-cron-jobs.md:592-599` separately flags an unrelated bug in the same file — the per-org cold-archive candidate-selection query (`retention_cron.py:176-182`, `SELECT DISTINCT tenant_id ... LIMIT 1000` with no `ORDER BY`) can silently starve tenants past the cap. That's a "which orgs get scanned" bug, distinct from this doc's "which policies actually execute once scanned" finding — the two docs are complementary, not overlapping, but both touch `retention_cron.py` and should be read together for the full picture.

## Web research: how comparable tools handle blob/trace retention (2026)
**Unverified this pass:** the figures below (LangSmith, Honeycomb, Sentry retention windows) were sourced with links in an earlier pass; this pass's web-search budget was exhausted before they could be independently re-confirmed against their cited sources. Not flagged as wrong — they're internally consistent with the doc's 30-day recommendation and already carry citations — but should be treated as unverified-external pending a spot-check, not as re-confirmed ground truth.
- **LangSmith** uses two fixed tiers, not open-ended retention: Base traces at 14 days, Extended traces at 400 days, with automatic upgrade to Extended for any trace that receives user feedback (so annotated/high-value traces survive, routine ones expire fast). Enterprise customers can pick a workspace-level extended-retention duration from a fixed menu (30-400 days). For self-hosted/blob-storage deployments, LangSmith explicitly requires "a lifecycle rule for each custom retention period configured." ([docs.langchain.com](https://docs.langchain.com/langsmith/data-purging-compliance), [support.langchain.com](https://support.langchain.com/articles/6604776514-can-i-configure-data-retention-periods-for-traces))
- **Honeycomb** enforces a flat 60-day retention on all trace/event data across every plan, calculated from ingest time (not event timestamp), with no per-project extension — the simplest possible policy, chosen deliberately because Honeycomb is positioned for live debugging, not long-term audit. ([honeycomb.io](https://www.honeycomb.io/blog/infinite-retention-opentelemetry-honeycomb), [docs.honeycomb.io](https://docs.honeycomb.io/get-started/manage-costs/how-honeycomb-calculates-usage))
- **Sentry** — a closer analog to "debug/replay" specifically rather than general trace retention — advertises a "30-day lookback" on its Developer (free) tier and "up to 90-day lookback" on Team/Business tiers as its general product retention window; the docs don't break out session-replay-specific retention from the general figure, which is itself informative — most comparable tools treat interactive-debugging data as bounded by the same short window as everything else, not exempted into a longer or unbounded class the way Eden's `trace_replay_sessions` currently is. ([sentry.io/pricing](https://sentry.io/pricing/))
- **General 2026 blob-lifecycle guidance**: the recurring principle across S3 lifecycle-policy writeups is that "every snapshot/blob should have a defined expiry — a snapshot with no expiry is a cost liability." ([sedai.io](https://sedai.io/blog/understanding-s3-bucket-storage-functions), [oneuptime.com](https://oneuptime.com/blog/post/2026-02-12-reduce-s3-storage-costs-lifecycle-policies/view))

Sanity check for the **30-day** pick: it sits inside the observed 7-30 day range for tools that treat debug/interactive data as short-lived (LangSmith Base 14d, Sentry Dev-tier floor 30d), rather than the longer general-purpose windows (Honeycomb 60d flat, Sentry Team/Business 90d, LangSmith Extended 400d) meant for audit/compliance-style trace retention — which matches the nature of `trace_replay_sessions`/`checkpoint_blobs`/`replay_sessions`: exploratory debugging state, not a system of record. 30 days over `debug_dumps`' 7 days specifically because rewind investigations plausibly span a sprint (a week-long gap, e.g. over a weekend or between follow-up sessions on the same incident) rather than same-day.

---

## Phase 3 Verdicts

Fact-check method: read `run_retention_policy`'s actual dispatch branches line-by-line in `retention.py:456-503` rather than trusting that a `DEFAULT_POLICIES` entry implies enforcement; cross-checked against `test_retention_cron.py` assertions; grepped for callers of `insert_checkpoint_blob`/`get_checkpoint_blob(s)`/`delete_checkpoint_blobs` across `src/eden` (zero non-test callers found); read `rewind.py`'s module docstring, which self-documents the `checkpoint_blobs` → `trace_replay_sessions` migration; grepped `db_migrations/` for `CREATE TABLE` matches on all 8 `DEFAULT_POLICIES` names.

- **`checkpoint_blobs` has no retention policy** — VERDICT: KEEP, but RETARGET. Live write path moved to `trace_replay_sessions` (also with no retention policy). Growth is upsert-bounded per key, but genuinely zero-decay over time.
- **6 of 8 `DEFAULT_POLICIES` entries are unenforced no-ops, 4 of those reference nonexistent tables** — VERDICT: NEW, HIGH VALUE. Reframes "Eden has a mature retention system" from a system-wide claim to a claim about exactly one table category.
- **`get_storage_summary()` doesn't track any of the gap tables** — VERDICT: KEEP.
- **RCA/signal-investigator routes are not tier-aware** — VERDICT: KEEP-WITH-CAVEAT.
- **Competitor ingest-time-sampling pattern (Datadog)** — VERDICT: CUT.

## Phase 4 Verdicts (this pass)

Fact-check method: traced every caller of `ReplayService.replay_trace`/`upsert_session` across `src/eden` and `clients/portal/src` (route file, service file, and the change-impact false-positive via a name-collision `_replay_trace` method that turned out to call a different engine entirely); read `portal-routes.ts` and `dead-code-removal.test.ts` to confirm the portal Replay page is stubbed and its API client namespace deliberately deleted; ran `git log --all --follow` + `git show` on `retention.py`'s introducing commit to settle "renamed vs. never-built" for the 4 phantom-table policies; grepped all `db_migrations/versions/*.py` for `CREATE TABLE` matches on plausible successor names; manually hand-evaluated `policy.delete_after_days <= policy.warm_days` for all 8 `DEFAULT_POLICIES` rows against the real dispatch code.

- **`trace_replay_sessions` growth-rate estimate** — VERDICT: NEW, RESOLVES PRIOR "no estimate found" GAP. The reason no rows/day estimate existed in prior passes is that the only product entry point (portal `/replay`) is a stub redirected to `/rebuild`, and its API client function has zero consumers — current organic growth is ~0. The backend write path is fully live (`intelligence_gap_v0` defaults `True`, not per-org gated) and the feature is otherwise fully built, so this is a "flip the stub off" launch risk, not a hypothetical one. Provided an explicit, labeled-as-illustrative growth model for post-launch (~1,300 rows/month, ~1-2MB/month at typical payload size, with an uncapped-`TEXT`-column tail risk) rather than leaving the estimate unfilled.
- **A third related table, `replay_sessions` (migration 029), found this pass** — VERDICT: NEW. Same "built, unmonitored, not yet in `DEFAULT_POLICIES`" profile as `trace_replay_sessions`, but with a strictly worse growth model (unbounded insert-per-scratch-session vs. upsert-per-distinct-trace). Folded into the same fix.
- **4 phantom-table policies: aspirational-from-day-one, not renamed** — VERDICT: NEW, SETTLES OPEN QUESTION. `git show` on the commit that introduced `retention.py` proves all 8 entries, including the 4 phantom ones, existed verbatim from the first commit — ruling out "renamed table." 3 of 4 have real, differently-named successor tables that shipped later and were never reconciled back into `DEFAULT_POLICIES`; `error_logs` has no successor anywhere.
- **The `retention.py:498` deletion-skip `elif` is dead code for all 8 current policies, not just the 6 no-op ones** — VERDICT: NEW, SHARPER THAN PRIOR PASS. Checked all 8 `(delete_after_days, warm_days)` pairs by hand; the condition is false for every single one given current `DEFAULT_POLICIES` values, and flagged as a correctness trap for the proposed fix (naively adding `trace_replay_sessions`/`checkpoint_blobs` rows would hit the same dead branch — real dispatch code is required, not just config).
- **Fix-or-remove decision for all 6 no-op policies made explicit** — VERDICT: NEW. 3 removed outright (no real or adjacent table), 1 removed-with-follow-up-ticket for its real successor table, 2 implemented with concrete SQL against their existing (already-sane) `delete_after_days` values, prioritized by which one (`quarantine_events`) has a currently-confirmed live growth mechanism versus which are purely a false-confidence/hygiene issue.
