# Pass 4 — Agent C (Adversarial Skeptic) — optimizations/06-storage-retention.md

## ADVERSARIAL CHECK RESULT: yes, policies survive — but note the "all 8 dead" framing isn't actually what the doc claims

The task brief's "Prior finding: all 8 declared retention policies are dead code as configured"
does **not** match what `optimizations/06-storage-retention.md` itself asserts. The doc's own
verdict, stated repeatedly (doc lines 10, 18, 189), is **6 of 8** are unenforced no-ops — it
explicitly documents 2 survivors: `raw_traces` and `debug_dumps`. I independently re-derived
this from source rather than trusting the doc's prose, and it holds up:

- `raw_traces`: dispatched via the dedicated `if policy.data_type == "raw_traces":` branch at
  `src/eden/data_platform/retention.py:494-497`, calling `purge_archived_telemetry`
  (`retention.py:507-...`) which issues a real `DELETE FROM telemetry_events ... WHERE
  te.timestamp < $1 ... AND EXISTS (SELECT 1 FROM trace_archive_index ...)` (confirmed reading
  the live SQL, `retention.py:548-560`). Also archived first via `archive_to_cold` at
  `retention.py:474-483` (`_ARCHIVE_TABLE_BY_TYPE = {"raw_traces": "silver_events"}`,
  `retention.py:65-67`). Real DB calls, not stubs.
- `debug_dumps`: dispatched via `elif policy.data_type == "debug_dumps":`
  (`retention.py:484-489`), calling `cleanup_debug_dumps` (`retention.py:392-...`), which does a
  real paginated S3 `list_objects_v2`/`delete_objects` against the `debug/` prefix.
- Both are reached through `run_retention_policy`, called once per policy from
  `retention_cron.run()` (`src/eden/data_platform/retention_cron.py:50-55`).
- **Scheduling confirmed independently**, not just trusted from the doc: `src/eden/workers/
  cron_tick.py:135` imports `retention_run`, `cron_tick.py:142` invokes it inside `_run_daily`
  (`cron_tick.py:133-148`, the `03:00 UTC` job). Cross-checked against
  `optimizations/05-cron-jobs.md:49-52`, which *independently* documents the same schedule and
  additionally notes `retention_cron.py`'s own docstring (`retention_cron.py:11-12`,
  "Northflank: a daily scheduled job (cron: `0 2 * * *`)") is itself stale — it doesn't run via
  a Northflank cron at hour 2, it runs via the leader-elected background-loop supervisor at hour
  3. This doesn't contradict 06's claim (06 correctly says "03:00 UTC"), but 06 doesn't mention
  the docstring is wrong — minor, worth a one-line note if 06 is revised.
- **A second, independent live call site found this pass, not in the doc**: the admin route
  `POST /orgs/{org_id}/retention/run` (`src/eden/api/routes/data_platform.py:490-509`) also
  calls `manager.run_retention_policy(p)` / `manager.run_all_policies()` — same dispatch, same
  2-of-8-live/6-of-8-dead split, no different code path. Doesn't change the verdict (same dead
  branches), but is a second real trigger path worth noting for completeness — a manual
  admin-triggered run hits the identical no-op for the other 6, it isn't a hidden survivor.

**Effort spent trying to find a 3rd/4th survivor among the other 6 (`derived_metrics`,
`user_feedback`, `training_datasets`, `audit_logs`, `error_logs`, `quarantine_events`) — none
found:**
- `grep -rn "DELETE FROM user_feedback\|DELETE FROM quarantine_events\|DELETE FROM audit_logs\|
  DELETE FROM error_logs\|DELETE FROM derived_metrics\|DELETE FROM training_datasets" src/eden/`
  → only one hit, `silver_etl.py:803` (`quarantine_events`, on-success-reprocessing only, not
  age-based) — matches the doc's claim exactly.
- `grep -rn "run_retention_policy\|run_all_policies\|DataRetentionManager(" src/eden/` (excluding
  tests) → only `retention_cron.py` and `api/routes/data_platform.py` (above); no third caller.
- Checked the two *other* legs of the same daily cron job (`cron_tick.py:133-148`) in case
  retention for these tables happens under a different name: `typesense_ttl_cleanup`
  (`cron_tick.py:56-72`, deletes Typesense span docs >90d) and `self_obs_retention`
  (`cron_tick.py:101-129`, deletes `eden_synthetic_runs`/`eden_component_heartbeats` >14d, added
  2026-07-29 per the code comment). Both are real, live, age-based deletions — but neither
  touches any of the 8 `DEFAULT_POLICIES` table names. They don't rescue any of the 6.
- No feature flag gates the 6 no-op branches on/off (there's no flag at all — the branches are
  simply absent from the `if/elif` chain, not disabled).
- **Conclusion: could not find a 3rd or 4th survivor after real effort.** The doc's own 2-of-8
  claim is accurate and is the ceiling, not an understatement.

## CUT

> `RetentionPolicy("raw_traces", 7, 90, 2555, 2555, scrub_pii_after_days=30)` (doc's DEFAULT_POLICIES
> code block, and the later "raw_traces (2555 vs 90, but routed through the if above it, never
> reaches the elif)" parenthetical in the "Sharper finding" section)

**Reason: factually wrong quote of current source — this is a real citation error, not a
stylistic nit.** Current `src/eden/data_platform/retention.py:52` reads:
`RetentionPolicy("raw_traces", 7, 90, 2555, 90, scrub_pii_after_days=30)` — `delete_after_days`
is **90**, not 2555. Verified via `git blame -L 52,52`: this value was changed from `2555` → `90`
in commit `c4a44ee3` ("feat(portal): finish frontend polish with React Query and data-trust
fixes", 2026-07-14). I confirmed the `2555` value the doc quotes *was* correct at the
`retention.py`-introducing commit (`git show 7802fb68:src/eden/data_platform/retention.py` shows
`RetentionPolicy("raw_traces", 7, 90, 2555, 2555, ...)` verbatim) — so the doc author likely
picked up the stale value while doing the git-archaeology section (which does look at old
commits) and let it bleed into the "current state" quote earlier in the doc, rather than an error
introduced by hallucination. All 7 other `DEFAULT_POLICIES` entries' quoted tuples were checked
against current source and are byte-for-byte correct — this is an isolated, single-line error.

**Does not change any conclusion** — `raw_traces` is still caught by its own dedicated
`if policy.data_type == "raw_traces":` branch (`retention.py:494`) before the `elif` at line 498
is ever evaluated, regardless of what `delete_after_days` is set to, so "never reaches the elif"
stays true either way. Recommend fixing the quoted numbers rather than deleting the passage — but
flagging as CUT-and-replace since presenting a wrong number as a verbatim `python` code block is
worse than not showing the code at all.

## NEW FINDINGS

1. **The stale-value bug above has a sharper implication the doc missed.** With the *actual*
   current values (`delete_after_days=90`, `warm_days=90`), `policy.delete_after_days <=
   policy.warm_days` evaluates to **`90 <= 90` → True** for `raw_traces` — the *only* one of the
   8 policies for which the `elif` at `retention.py:498` would actually fire, if it were ever
   reached. The doc's "Sharper finding" claims the elif is "unreachable for every single policy
   currently in `DEFAULT_POLICIES`," which is still true in outcome (raw_traces never reaches it
   because the earlier `if` intercepts it first) — but the reasoning as written ("2555 vs 90 →
   the branch would still be False even if reached") is wrong for raw_traces specifically; with
   correct numbers it would be True if reached. Worth a one-line correction so a future reader
   doesn't get the wrong impression that raw_traces' numbers were chosen to guarantee no overlap
   with the elif — they weren't; the `if`/`elif` structure is doing that work, not the values.

2. **`retention_cron.py`'s own module docstring has a second staleness bug beyond the one
   `05-cron-jobs.md` already caught (Northflank cron time).** The docstring
   (`retention_cron.py:2-3`) says "Runs all **7** retention policies from
   `DataRetentionManager.DEFAULT_POLICIES`" — but `DEFAULT_POLICIES` has **8** entries
   (`retention.py:49-60`). Off-by-one, cosmetic, doesn't affect behavior (the code iterates
   `retention.policies`, not a hardcoded count) — not worth its own line item, but confirms the
   general pattern (seen twice now across two independent checks) that this module's docstrings
   drift from its actual behavior faster than the code does.

3. **Sibling-doc cross-reference, not a contradiction, worth linking:**
   `optimizations/05-cron-jobs.md:592-598` independently flags a starvation bug in
   `retention_cron.py`'s cold-archive candidate scan (`retention_cron.py:176-182`,
   `SELECT DISTINCT tenant_id FROM telemetry_events WHERE timestamp < ... LIMIT 1000` with no
   `ORDER BY` — same class of bug as the `auto_curator`/`classifier_retrain` findings in that
   doc). This is a different code path within the same file (`retention_cron.run()` step 4, the
   per-org `ArchiveService` cold-archive loop) from the `DEFAULT_POLICIES` dispatch logic 06
   analyzes — not a contradiction, just adjacent coverage of the same file that 06 doesn't
   mention and 05 doesn't connect back to 06's dead-policy findings. Synthesis may want to note
   both docs touch `retention_cron.py` for unrelated reasons so a reader doesn't think one
   subsumes the other.

4. **KNOWN-SUBSYSTEMS.md has no entry for `data_platform/` or retention at all** — it's only
   listed under "Not yet inspected but plausibly relevant" (line 72: `..., columnar/,
   data_platform/`). No contradiction to reconcile; 06 is the first/only pass-level doc to
   actually inspect this subsystem, so there's nothing in ground-truth to cross-check the core
   claims against beyond what I re-derived from source directly (done above).

5. **Web research section (LangSmith/Honeycomb/Sentry retention windows) could not be
   independently re-verified this pass** — the session's web search budget was exhausted before
   I could spot-check the Honeycomb 60-day-flat claim. The citations have specific URLs attached
   and are internally consistent with the doc's 30-day recommendation logic; I'm not flagging
   them as false, just noting I couldn't confirm them independently as I would have liked for a
   true adversarial pass. Recommend a future pass spot-check at least one (e.g. the Honeycomb
   claim, since it's the most specific/falsifiable of the three).

## Everything else independently re-verified and holds up (no changes needed)

For the record, since this is an adversarial pass — the following load-bearing claims were
checked against current source (not just trusted) and confirmed accurate: `user_feedback` table
at `020_intelligence_gap_tables.py:559-571` (via `_table("user_feedback", ...)` helper, not raw
`CREATE TABLE` SQL — grepping for the literal SQL string would have missed it, which may be why
an earlier pass could have gotten this wrong); `quarantine_events` columns at
`008_phase_5_5_data_platform.py:79-90`; `agent_audit_ledger` at
`092_market_ready_consolidated.py:501`; zero migrations anywhere define `error_logs`,
`audit_logs`, `derived_metrics`, or `training_datasets` tables; `custom_metric_runs`/
`telemetry_streaming_metrics`/`datasets`+`dataset_items`+`dataset_snapshots`/`fine_tuning_runs`+
`dataset_trace_lineage` all exist as claimed; `checkpoint_blobs` has zero non-test callers of
`insert_checkpoint_blob`/`get_checkpoint_blob(s)`/`delete_checkpoint_blobs` anywhere in
`src/eden`, but is still read live by `api/routes/websocket.py:378/398/408`; `ReplayService.
replay_trace`/`upsert_session` traced end-to-end — only reachable from
`intelligence_replay.py:184-192`, no scheduled/cron caller, `change_impact/preview.py`'s
`_replay_trace` (line 252) is a genuine name-collision that calls a different engine; `/replay`
confirmed in `STUB_PORTAL_PATH_PREFIXES` (`portal-routes.ts:40`), `getTraceReplay`
(`resources.ts:1283`) has zero callers anywhere in `clients/portal/src`, `replayApi` confirmed
removed at `dead-code-removal.test.ts:51`; `intelligence_gap_v0` confirmed `True`-by-default,
global not per-org, at `config.py:225`; `replay_sessions` (migration 029) confirmed insert-only
for scratch sessions — unique index at `029_replay_sessions.py:48-51` is `WHERE name IS NOT
NULL`, so unnamed rows are never deduped; open-question citation at
`docs/docs/observability/01-trace-replay.md:315-316` confirmed verbatim.
