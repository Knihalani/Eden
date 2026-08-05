# Pass 4 Notes — Agent A (Fact-Verifier & Pruner) — 06-storage-retention.md

Method: read every dispatch branch in `run_retention_policy` against the current
working tree (HEAD = `68a13604`, no uncommitted changes to `data_platform/`),
hand-evaluated all 8 `DEFAULT_POLICIES` tuples against that dispatch logic,
grepped `db_migrations/versions/*.py` for every claimed table name (both raw
`CREATE TABLE` strings and the `_table()` helper macro used in
`020_intelligence_gap_tables.py`), grepped for callers of every
checkpoint-blob/replay function across `src/eden` and `clients/portal/src`,
and spot-checked ~25 file:line citations in the doc against the actual files.

## HEADLINE RE-VERIFICATION: "all 8 dead" vs. "6 of 8 dead" — both were/are correct, at different times

The task brief's prior-pass finding ("all 8 declared retention policies are
dead code as configured — not 6, all 8") does **not** hold against the current
HEAD, but it is not simply wrong either — it was very likely correct at the
time it was made, and has since been overtaken by a real code fix that landed
**inside this review's own timeframe**.

`git log` on `src/eden/data_platform/retention.py` shows the tip commit is
`68a13604` ("fix: eliminate every fabricated-metric path; make failures
honest", authored 2026-08-04 01:49 -0400 — i.e. the day before this pass).
Its diff changes `cleanup_debug_dumps` from a **literal no-op stub**:
```python
async def cleanup_debug_dumps(self, before_date: datetime) -> int:
    """Delete debug dump files older than the given date."""
    if self.dry_run:
        logger.info(f"[DRY RUN] Would delete debug dumps before {before_date.isoformat()}")
        return 0
    # In production, this would scan S3 or local filesystem
    # For now, log the intent
    logger.info(f"Debug dump cleanup requested before {before_date.isoformat()}")
    return 0
```
to a real S3 `list_objects_v2` + `delete_objects` implementation (current
`retention.py:392-454`). The commit message says this explicitly: *"retention:
cleanup_debug_dumps really deletes debug/ objects past the policy cutoff...
instead of a silent no-op."*

Before this commit, `debug_dumps` was **also** a no-op — which would make the
prior pass's "8 of 8 dead" claim correct for that earlier snapshot. After this
commit (current HEAD, which the doc under review reflects — its
`cleanup_debug_dumps` docstring quote matches the post-fix code verbatim),
`debug_dumps` is genuinely live, making it 2 of 8 live / 6 of 8 dead, exactly
as `06-storage-retention.md` states.

**Verdict on the prior-pass claim: STALE, not false.** Flag for synthesis:
Agents B/C should check whether their own passes ran against a checkout at or
after `68a13604` — if any of the three agents' analysis predates that commit,
their "all 8 dead" framing needs to be reconciled against this fix, not
treated as a live disagreement.

## PER-POLICY VERDICT (all 8, against current HEAD)

Dispatch reference: `src/eden/data_platform/retention.py`, `run_retention_policy`
at lines 456-505; `DEFAULT_POLICIES` at lines 49-60 (`RetentionPolicy(data_type,
hot_days, warm_days, cold_days, delete_after_days, scrub_pii_after_days)`).

1. **`raw_traces`** (`7, 90, 2555, 90, scrub_pii_after_days=30`) — **LIVE.**
   PII scrub via `purge_pii_fields` (`retention.py:462-470`, `102-131`, real
   `UPDATE silver_events`). Archive via `archive_to_cold(silver_events)`
   (`retention.py:474-483`, `133-215`) — real chunked SELECT/S3-write/DELETE,
   contingent on `bronze_s3_bucket` being configured (same contingency as
   `debug_dumps`, not a code-level no-op). Deletion via
   `purge_archived_telemetry` (`retention.py:494-497`, `507-567`) — real
   `DELETE FROM telemetry_events ... WHERE EXISTS (SELECT 1 FROM
   trace_archive_index ...)`. Note: `trace_archive_index` rows are populated by
   the separate `ArchiveService.archive_old_rows` cold-archive loop (step 4 of
   `retention_cron.py`, not by this policy's own archive step, which targets
   `silver_events` not `telemetry_events`) — so on a given day's cron run,
   `purge_archived_telemetry` deletes rows indexed by *yesterday's* archive
   pass, one cron-cycle lag. Real, working, just cross-wired between two
   sibling mechanisms rather than self-contained — not dead code.

2. **`derived_metrics`** (`7, 90, 2555, 2555`) — **DEAD.** `archive_table` is
   `None` (`_ARCHIVE_TABLE_BY_TYPE` only has `raw_traces`,
   `retention.py:65-67`) and `data_type != "debug_dumps"` → both archive
   branches skip. `data_type != "raw_traces"` and `2555 <= 90` is False → the
   `elif` at line 498 also skips. Zero branches fire. No backing table:
   `grep -rn '"derived_metrics"'` and `grep -rn 'CREATE TABLE.*derived_metrics'`
   across `db_migrations/versions/*.py` both return zero hits.

3. **`user_feedback`** (`7, 90, 2555, 2555`) — **DEAD**, same no-op shape as
   above. Real table confirmed via the `_table()` migration helper (not raw
   SQL, so a naive `grep 'CREATE TABLE'` misses it) at
   `db_migrations/versions/020_intelligence_gap_tables.py:558-570`
   (`_table("user_feedback", ...)`, columns `id, org_id, trace_id, user_id,
   thumbs, rating, comment, created_at`).

4. **`training_datasets`** (`7, 90, 2555, 2555`) — **DEAD**, same shape. No
   table named `training_datasets` anywhere (checked both raw
   `CREATE TABLE` and `_table(` calls). Verified successor tables exist:
   `datasets`/`dataset_items` at `db_migrations/versions/101_eval_loop.py:18-56`
   (real `CREATE TABLE IF NOT EXISTS datasets (...)`, `dataset_items (...)`,
   both confirmed by direct read) and `fine_tuning_runs`/
   `dataset_trace_lineage` at `061_fine_tune_lineage.py:9-31` (confirmed by
   direct read, both real `CREATE TABLE`).

5. **`audit_logs`** (`7, 90, 2555, 2555`) — **DEAD**, same shape. No table
   named `audit_logs` anywhere. Successor `agent_audit_ledger` confirmed real
   at `db_migrations/versions/092_market_ready_consolidated.py:501`
   (`CREATE TABLE IF NOT EXISTS agent_audit_ledger (...)`, confirmed by direct
   read).

6. **`error_logs`** (`7, 30, 90, 90`) — **DEAD.** `archive_table=None`, not
   `debug_dumps` → archive/debug branches skip. `data_type != "raw_traces"`,
   `90 <= 30` is False → `elif` also skips. No table anywhere and — checked
   this pass — no plausible successor either (errors live inline as fields on
   `telemetry_events`; confirmed no `CREATE TABLE.*error` hit in any migration
   file, any naming convention).

7. **`debug_dumps`** (`7, 0, 0, 7`) — **LIVE (as of `68a13604`, 2026-08-04;
   was dead code before that commit — see headline section above).**
   `archive_table` is `None` for this `data_type`, so it takes the dedicated
   `elif policy.data_type == "debug_dumps":` branch (`retention.py:484-489`),
   calling the now-real `cleanup_debug_dumps` (`retention.py:392-454`): S3
   `list_objects_v2` over the `debug/` prefix, filters by `LastModified <
   before_date`, batched `delete_objects` (≤1000 keys/request). Dry-run
   honoured; errors bubble into the report instead of being swallowed. Test
   coverage updated in lockstep: `tests/data_platform/test_retention.py`
   (`test_cleanup_debug_dumps`) now asserts count stays `0` only when no
   bucket is configured, not unconditionally.

8. **`quarantine_events`** (`7, 30, 90, 90`) — **DEAD** via
   `run_retention_policy` — identical no-op shape to #6 (`archive_table=None`,
   not `debug_dumps`; `90 <= 30` False). Real table confirmed at
   `db_migrations/versions/008_phase_5_5_data_platform.py:77-99` (direct read:
   `CREATE TABLE IF NOT EXISTS quarantine_events (...)`, columns include
   `quarantined_at`, `resolution`). Its only actual deletion path is
   `silver_etl.py`'s `reprocess_quarantine` (confirmed by direct read,
   ~lines 765-808): unparseable rows are explicitly kept quarantined forever
   (`unparseable.append(...)`, logged, not deleted), and the
   `DELETE FROM quarantine_events` only fires when
   `fully_inserted = bool(parsed_ids) and report.silver_inserted >=
   len(events)` — i.e. only on a fully-successful reprocess of that specific
   batch. No age-based cleanup exists for rows that are never reprocessed.
   Separately, `StorageLifecycleManager.expire_temporary_data`
   (`storage_lifecycle.py`) — the thing `retention_cron.py` calls as its
   "sweep tmp/debug/quarantine" step — only sweeps S3 prefixes `debug/`,
   `tmp/`, `staging/` (confirmed by direct read of the `prefixes` list); it
   does **not** include `quarantine/`, and it never touches the Postgres
   `quarantine_events` table at all (S3-only method). So the doc's
   characterization is accurate and, if anything, slightly generous — the S3
   `quarantine/` prefix isn't even swept by the one function whose docstring
   claims to sweep it (only `apply_s3_lifecycle_rules`'s declarative
   `eden-quarantine-cleanup` bucket-lifecycle rule targets that prefix, which
   is a different, infra-side mechanism from the app-level cron sweep).

**Summary: 2 of 8 live (`raw_traces`, `debug_dumps`), 6 of 8 dead-as-configured
(`derived_metrics`, `user_feedback`, `training_datasets`, `audit_logs`,
`error_logs`, `quarantine_events`) — confirms the doc's claim exactly, with
the one caveat above (that `debug_dumps` only became live the day before this
pass, and any earlier-dated pass finding "8 of 8" was correct for its own
snapshot).**

## Other line-citation spot checks (all confirmed exact)

- `retention.py:456-505` (`run_retention_policy` body) — exact.
- `retention.py:65-67` (`_ARCHIVE_TABLE_BY_TYPE`) — exact.
- `retention.py:569-581` (`load_org_warm_days`) — exact (doc says 569-580, off
  by one line at the tail, immaterial).
- `src/eden/workers/cron_tick.py:135` (import) and `:142` (invocation of
  `retention_run`) — both exact, confirmed by direct grep.
- `src/eden/config.py:225` (`intelligence_gap_v0: bool = True`) — exact.
- `intelligence_replay.py:51` (`require_feature_flag("intelligence_gap_v0")`)
  — exact.
- `intelligence_replay.py:184-192` (`replay_trace` route) — exact.
- `src/eden/observability/replay/service.py:98-100` (`upsert_session` call
  site inside `replay_trace`) — confirmed real, calls
  `_trace_common.upsert_session`.
- `src/eden/observability/_trace_common.py:205-244` (`upsert_session`,
  delete-then-insert, comment explaining no unique constraint) — exact,
  including the specific comment text about no unique constraint existing.
- `clients/portal/src/lib/portal-routes.ts` — `/replay` confirmed at exactly
  line 40 in `STUB_PORTAL_PATH_PREFIXES`.
- `clients/portal/src/lib/api/resources.ts:1283` (`getTraceReplay`) — grep for
  `getTraceReplay` across all of `clients/portal/src` returns exactly one
  hit: its own definition. Doc's "zero call sites anywhere else" — confirmed.
- `clients/portal/src/lib/api/__tests__/dead-code-removal.test.ts` —
  `replayApi` confirmed at exactly line 51 in the `deletedNamespaces` list.
- `src/eden/db_migrations/versions/029_replay_sessions.py` — confirmed:
  `(org_id, trace_id, name)` dedup lookup only runs `if body.name is not
  None` (`intelligence_replay.py:_create_replay_session_row`); the
  `name IS NULL` "scratch session" path always inserts, no lookup at all.
  Matches doc's "always inserted as new rows, no dedup" claim exactly.
- `checkpoint_blobs` — `insert_checkpoint_blob`/`get_checkpoint_blob(s)`/
  `delete_checkpoint_blobs` (`src/eden/storage/postgres.py`) confirmed to have
  **zero callers anywhere in `src/eden`** outside their own definitions
  (re-grepped this pass, fixed a broken `--include` flag from a first
  attempt that produced a false "no matches" for unrelated syntax reasons —
  re-ran cleanly, confirmed zero real hits). `src/eden/api/routes/
  websocket.py` does poll `checkpoint_blobs` live, but via **raw inline SQL**
  (`_latest_blob_created_at` at line 371-383, `_fetch_blobs_after` at
  387-415ish) — not via the wrapper functions — which is why the wrapper-call
  grep and the "still read live" claim are both independently true and not
  contradictory. Doc gets this exactly right.
- `docs/docs/observability/01-trace-replay.md:313-316` open-question quote —
  confirmed, file exists at that exact path (note: `rewind.py`'s own
  docstring points to a *different*, likely stale path,
  `docs/observability-gap/01-trace-replay.md`, which does not exist — that's
  a discrepancy in the source code comment, not in the doc under review; not
  a doc error, just worth flagging as a real-repo inconsistency if anyone
  follows that link from the code).
- `db_migrations/versions/008_phase_5_5_data_platform.py:77-99`
  (`quarantine_events` CREATE TABLE) — exact.
- `storage_lifecycle.py:525-541` / `get_storage_summary`'s
  `["usage_events", "silver_events", "quarantine_events"]` list — table names
  at exactly line 536, function starts exactly line 525. Exact.
- `columnar/compaction.py`'s `ColumnarCompactor.compact_due` — confirmed real
  (`compact_due` at line 336, real `OPTIMIZE TABLE ... PARTITION ID ...
  FINAL` construction at line 481).

## CUT (false / stale / speculative / redundant)

1. **Quote: `RetentionPolicy("raw_traces", 7, 90, 2555, 2555,
   scrub_pii_after_days=30)` (doc line 21, inside the `DEFAULT_POLICIES` code
   block).**
   Reason: **Factually wrong against current code.** The actual current
   `retention.py:52` reads `RetentionPolicy("raw_traces", 7, 90, 2555, 90,
   scrub_pii_after_days=30)` — `delete_after_days=90`, not `2555`. Traced via
   `git log -p`: this value was changed from `2555` to `90` in commit
   `c4a44ee3` ("feat(portal): finish frontend polish with React Query and
   data-trust fixes", 2026-07-14) — over three weeks before this review
   started, so this is a stale/copy-paste error in the doc, not a recent
   drift. **Does not change any downstream conclusion** — `raw_traces` is
   dispatched by an explicit `if policy.data_type == "raw_traces":` check
   (`retention.py:494`), never by the numeric `elif` comparison, so the "one
   whole branch is dead for all 8" analysis (which correctly notes "routed
   through the `if` above it, never reaches the `elif`") is unaffected by
   this number being wrong. Still: it's a literal code quote presented as
   ground truth and it is not what current `retention.py` contains — should
   be corrected to `90` before this doc is finalized, or the whole line
   should just say "current values below" without hand-copying stale figures.

2. **Growth-estimate assumptions in `### Growth estimate` (doc lines 86-88):
   "Illustrative low/mid case: 20 active orgs × 5 engineers/org × 3 distinct
   traces investigated/week ≈ 300 new `(org_id, trace_id)` keys/week ≈
   ~1,300 rows/month."**
   Reason: **Unverifiable / speculative**, and explicitly labeled as such by
   the doc itself ("illustrative," "modeling by analogy") — which is honest
   framing, but the specific numbers (20 orgs, 5 engineers/org, 3
   traces/week) have no grounding in any Eden usage data found in this pass
   (no org-count telemetry, no per-org seat data was checked against this
   figure) — they are invented to make the illustration concrete. Not false,
   since it's caveated as illustrative, but this is exactly the kind of
   "labeled-speculative" content the prune pass should flag: recommend either
   (a) cutting the specific arithmetic and keeping only the qualitative
   "small fraction of active orgs, one-time-not-per-page" reasoning, which is
   the actually load-bearing part, or (b) explicitly re-labeling the number
   itself (not just the paragraph) as a placeholder pending real org-count
   data, so a reader skimming doesn't walk away treating "~1,300 rows/month"
   as a validated figure.

3. **Web research section (doc lines 173-179) — specific competitor
   retention-window figures (LangSmith 14d/400d, Honeycomb 60d flat, Sentry
   30d/90d).**
   Reason: **Unverifiable in this pass** — WebSearch budget for this session
   was exhausted before I could independently re-confirm these figures
   against the cited docs.langchain.com / honeycomb.io / sentry.io sources.
   Not asserting these are wrong (they read as plausible and are already
   sourced with links, which is good practice), but per the "maximum rigor"
   instruction for this pass I could not re-verify them myself and am
   flagging that as a gap rather than silently passing them through as
   confirmed. Recommend Agent B or C (if either still has search budget)
   spot-check at least the LangSmith and Honeycomb figures, since those are
   the ones doing the most work in the "why 30 days" argument.

## NEW FINDINGS (this pass, beyond re-confirming prior-pass claims)

1. **The `debug_dumps` policy's liveness is brand-new, not a stable fact.**
   `cleanup_debug_dumps` was a hardcoded `return 0` no-op stub until commit
   `68a13604` (2026-08-04 01:49, the day before this pass), which is the same
   commit that fixed several *other* fabricated-metric paths across the repo
   (agent_intel benchmarks, CI eval pipeline, `/optimization` token-savings,
   realtime gRPC handlers — see commit message). This means "2 of 8 policies
   are live" is a very recent state of the world, not a long-standing
   architectural fact — worth noting in the doc's confidence framing, since a
   reader might assume "raw_traces and debug_dumps have always worked" when
   in fact one of the two was fixed within the last 24-48 hours of repo
   history relative to this review.

2. **`quarantine_events`'s S3-side lifecycle rule (`eden-quarantine-cleanup`,
   90-day expiration on the `quarantine/` S3 prefix, declared in
   `apply_s3_lifecycle_rules`) is a second, independent mechanism from the
   Postgres `quarantine_events` table this doc focuses on.** The doc's fix
   section doesn't mention this S3-side rule at all, which is fine (it's a
   different resource — S3 objects, not Postgres rows — and doesn't affect
   the Postgres-side no-op finding), but worth a one-line clarification in
   the fix design so nobody reading only the "Decision for each of the 6
   no-op policies" table assumes `quarantine_events` currently has *zero*
   automated cleanup anywhere — it has zero cleanup for the Postgres table
   specifically, which is the thing that matters for unbounded row growth,
   but the S3 side (raw quarantined payload blobs, if any are written there)
   does have a declared (if `Impossible Cloud`-dependent, per the
   `_IMPOSSIBLE_CLOUD` skip logic elsewhere in the same file) lifecycle rule.

3. **`retention_cron.py`'s own module docstring is stale**: it says "Runs
   all 7 retention policies from `DataRetentionManager.DEFAULT_POLICIES`"
   (`retention_cron.py:4`), but `DEFAULT_POLICIES` has had 8 entries this
   entire time (confirmed via `git show` on the introducing commit, matching
   the doc's own git-archaeology finding). Minor, but it's a second
   independent piece of evidence (alongside the "4 phantom tables from day
   one" finding) that this whole area of the codebase has had stale
   documentation drift since its original landing, not just isolated to the
   `DEFAULT_POLICIES` table names.

## Overall assessment

This is one of the most rigorously fact-checked docs I've reviewed in this
series — of ~25 specific file:line citations spot-checked, only one factual
error surfaced (a stale quoted code value for `raw_traces.delete_after_days`
that does not change any conclusion). The per-policy dispatch analysis is
correct and precise against current HEAD. The main things synthesis needs are:
(1) reconcile "2 of 8 live" (this doc, current HEAD) against any "all 8 dead"
claim from Agents B/C by checking what commit their analysis ran against —
this is very likely a timing artifact around `68a13604`, not a genuine
disagreement; (2) fix the stale `2555` in the quoted `DEFAULT_POLICIES` block;
(3) downgrade the specific growth-estimate arithmetic to explicitly-placeholder
status, keeping the qualitative reasoning.
