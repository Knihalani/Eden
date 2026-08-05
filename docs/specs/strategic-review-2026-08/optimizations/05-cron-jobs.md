# 05 — Cron / background-job efficiency

Scope: `src/eden/workers/cron_tick.py` (`run_maintenance_due`, the shared
maintenance entry point), plus every job it fans out to: `auto_curator.py`,
`soft_issue_review.py`, `drift_baseline_worker.py`,
`signals/classifier_pipeline.py`, `signals/backfill.py`, `signals/clusterer.py`,
`data_platform/retention_cron.py`, `data_platform/clickhouse_fallback_drain.py`,
`columnar/compaction.py`, plus the process that actually calls it
(`workers/main.py`, `workers/leader.py`) and the deployment manifest
(`northflank.yml`). Research only — no code changed.

## Correction to the starting premise (pass 1)

`cusum_detect` / `annotate_change_points` (`src/eden/predictive/cusum.py`) are
**not** on any cron schedule. The only caller is
`eden.predictive.quality.QualityPredictor.predict` (`src/eden/predictive/quality.py:230-231`),
reached only from the on-demand API route
`src/eden/api/routes/intelligence_predictive.py:53`. `cron_tick.py` never
imports `eden.predictive`. No further action needed on this file.

## Correction to the deployment/scope framing (pass 2)

Pass 1 described this file's scope as "the eden-cron entry point, Northflank
`*/5 * * * *`." That is **stale**. Verified against `northflank.yml`:

- `northflank.yml:14-15` and `:784-813` — the `eden-cron` Northflank job is
  **disabled**: `cronExpression: "0 0 1 1 *"` (once a year) and its command is
  a literal no-op (`echo "eden-cron disabled: maintenance + EQL + demotion run
  on eden-worker"; exit 0`). It "never imports eden code and never reads any
  env var" (comment, `northflank.yml:814-816`).
- The real caller is a **leader-elected in-process loop**,
  `_leader_maintenance` (`src/eden/workers/main.py:662-706`), which calls
  `cron_tick.run_maintenance_due(dry_run=False)` directly
  (`main.py:672-674`) on an interval of `_idle_poll_period()`
  (`main.py:697,703,709-716`) — **600 seconds by default** (10 minutes, from
  `settings.idle_poll_period_seconds`), not 5.
- That loop today runs inside **`eden-api`** (`EDEN_RUN_BACKGROUND_WORKERS=1`
  on the API service — see `main.py:914-931`), because the Developer Sandbox
  plan only allows one always-on service. The `eden-worker` Job exists only
  as a manually-triggered break-glass fallback (`EDEN_RUN_BACKGROUND_WORKERS=0`
  by default, `northflank.yml:677-678`).
- Net effect on the rest of this doc: the hour/minute gates inside
  `run_maintenance_due` (`cron_tick.py:377-531`) are unchanged and still the
  right thing to read for "when does X run" — a leader-elected 10-minute
  poll checking `now.hour`/`now.minute` windows reproduces the same schedule
  a real cron would, just hosted differently. But two framing points from
  pass 1 needed fixing: (a) there is no separate cold-start cron container to
  reason about, everything lives in the API process's background-loop
  supervisor; (b) `data_platform/retention_cron.py`'s own module docstring
  (`retention_cron.py:11-12`, "Northflank: a daily scheduled job (cron:
  `0 2 * * *`)") is itself stale for the same reason — it actually runs at
  hour==3 via `_run_daily` (`cron_tick.py:402-407`), not via a Northflank
  cron at hour 2.
- A directly relevant **production incident**, documented at
  `northflank.yml:595-621` (2026-07-29): `eden-worker`'s `backoffLimit: 0`
  meant a crashed run was simply gone — "between 2026-07-21 and 07-24
  forty-five consecutive runs failed and nothing ever restarted them, so
  every background loop (maintenance, insights, EQL watchdog, webhook drain,
  self-obs, quality pipeline, trace-finalized consumer) was dead in prod for
  **7.4 days** while the API happily served reads." This is the "no
  retry/backoff" failure mode from the task's checklist, already realized
  once for the *entire* maintenance fleet, not hypothetical (figures sourced
  verbatim from an in-repo incident comment, not independently re-derived
  from logs). Fixed by bumping `backoffLimit: 3` (`northflank.yml:622-623`);
  a second, still-open hazard from the same incident — `runOnSourceChange:
  cd-promote` starting a duplicate fleet copy on every deploy with no
  old-run cleanup — is noted as NOT fixed (`northflank.yml:613-621`),
  mitigated only by leader locks making the duplicate "safe rather than
  correct." The same comment block records a concrete instance of the cost:
  after repeated redeploys, **five copies were "RUNNING" at once** — five
  idle pollers each billing Upstash and Neon for one job's worth of work
  (`northflank.yml:600-604`).
- `cron_tick.py`'s own top-of-file module docstring (`cron_tick.py:1-17`) is
  stale in two further ways beyond the Northflank-cadence line already
  corrected above. It claims the tick includes an "EQL alert watchdog +
  columnar compaction (hourly window)" step and runs "N23 improvement
  sweeps when org schedule is due." Neither is true of the code that
  executes: there is no EQL-watchdog call anywhere in `cron_tick.py` —
  `run_maintenance_due`'s own docstring says so explicitly ("Skips EQL
  watchdog, artifact demotion, and improvement sweeps — those are hosted
  separately on `eden-worker` or intentionally off," `cron_tick.py:357-358`;
  EQL actually runs via a separate leader loop, `workers/main.py:293`,
  covered in the pass-3 sweep below) — and improvement sweeps are
  unconditionally skipped, not conditionally run:
  `out["improvement_sweeps"] = {"skipped": True, "reason":
  "issue_driven_only_use_closed_loop"}` (`cron_tick.py:472-475`). The module
  docstring is therefore wrong on three separate points, not just the
  cadence one — worth a one-line doc-comment fix alongside the code fixes
  proposed below.

## Full schedule map (from `run_maintenance_due`, `src/eden/workers/cron_tick.py:350-550`)

All jobs are gated by Redis `SET NX` per time-slot (`_once_per_window`,
`cron_tick.py:256-303`) so overlapping pods / a tick that fires slightly late
cannot double-run a slot. A falsy `SET NX` is disambiguated by reading the key
back (`cron_tick.py:283-292`) specifically to avoid a July 2026 incident where
an Upstash instance past its plan limit served reads but silently discarded
writes — treating that as "someone else claimed it" would have made every
gated job skip forever while the tick still reported success
(`cron_tick.py:263-272`, docstring names the incident directly). Failed
claims are released (`_release_window`, `cron_tick.py:305-321`) so a crash
retries next tick rather than being skipped for the rest of the window. This
infrastructure layer is solid and independently confirmed this pass.

| Job | Frequency | Scan / bound | Concurrency |
|---|---|---|---|
| `columnar_compaction` | hourly (minute<10) | `ColumnarCompactor.compact_due(limit=50, max_age_hours=24)` — `ORDER BY last_compaction_at ASC NULLS FIRST` (`columnar/compaction.py:336-358`) — **watermarked, self-rotating** | n/a |
| `auto_curator` | daily 02:00 UTC | `SELECT id::text AS org_id FROM organizations LIMIT 50` — **no ORDER BY** (`cron_tick.py:202`) | `bounded_gather(limit=8)` across orgs (`cron_tick.py:226-230`) |
| `daily` (retention_cron + typesense TTL + self-obs retention) | daily 03:00 UTC | fixed cutoffs (90d, 14d) for TTL/retention, but see finding #4 below for the cold-archive candidate-selection sub-query inside `retention_cron.run()` (only that sub-query was checked for this defect this pass; the other TTL/typesense/self-obs-retention sub-queries were not individually re-swept) | sequential per-org, cheap I/O each |
| `soft_issue_review` | daily, own slot 03:30–03:40 UTC | top 20 orgs by 24h issue count, `ORDER BY n DESC LIMIT 20` (`_rank_hot_orgs`, `soft_issue_review.py:103-113`) — **watermarked by activity**, ≤3 agents/org, ≤50 traces/org | **fully sequential** `for org_id in org_ids` (`soft_issue_review.py:75`) |
| `drift_baselines` | weekly, Mon 04:00 UTC | `SELECT DISTINCT org_id, agent_id FROM agent_issues WHERE last_seen >= now()-7d LIMIT 100` — **no ORDER BY** (`drift_baseline_worker.py:25-33`) | fully sequential, ×7 `DRIFT_DIMENSIONS` per pair, up to 2 round-trips/dimension (1 histogram read + 1 conditional baseline upsert) — up to 1,400 round-trips total |
| `shadow_promote` (`promote_shadow_detectors`) | weekly, same Mon 04:00 UTC gate (own claim key) | global `LIMIT 200`, `ORDER BY created_at ASC` (oldest-first, has an ORDER BY — different bug class, see #3), `enabled=false AND cluster_id LIKE 'auto:%'` — **not scoped per org** (`soft_issue_review.py:401-411`) | fully sequential per-row `UPDATE`/`DELETE`/Slack-notify |
| `mcp_rollup` | every 15 min | `rollup_registry()` — set-based `GROUP BY org_id, mcp_server_name`, no `LIMIT` (`observability/mcp_traces.py:287-315`) — scales fine | — |
| `classifier_retrain` | every 15 min | `ClassifierTrainingPipeline.retrain_due_orgs()` — `SELECT DISTINCT org_id, signal_id FROM signal_events WHERE detected_at > now()-7d LIMIT 50` — **no ORDER BY** (`classifier_pipeline.py:234-241`) — **NEW finding, see #7** | sequential `for row in rows` (`classifier_pipeline.py:246-249`) |
| `shadow_outcome_join` | every 15 min | `ShadowOutcomeJoiner.run_once(limit=200)` — `SELECT no.id, no.trace_id, n.id, ai.fingerprint FROM nudge_outcomes no JOIN nudges n ... WHERE no.mode='shadow' AND no.outcome_success IS NULL AND no.matched=true AND no.recorded_at >= now()-14d LIMIT $1` — **no ORDER BY, NEW finding #5, see pass-3 sweep below** (`nudges/shadow_outcomes.py:14-42`) | — |
| `clickhouse_fallback_drain` | every 10 min | `run_once(limit=_BATCH_LIMIT=500)`, oldest-first with **exponential backoff** (`data_platform/clickhouse_fallback_drain.py:163-181`) and a **dead-letter path** (`dead_at`, `:89-140`) — best-practice example in this codebase | `bounded_gather` across target tables, `_REPLAY_CONCURRENCY=4` (`:145`) |
| `signal_backfill` | every 10 min | `SignalBackfillWorker.run_once(max_jobs=3)`, per-job resumable keyset-ish cursor via `traces_done` as an `OFFSET` over `ORDER BY trace_id` (`signals/backfill.py:204-219`) — idempotent, resumable, but `OFFSET` not true keyset (see #8) | — |
| `signal_cluster_quiet` | every 10 min | single set-based `UPDATE signal_clusters ... WHERE status='open' AND last_seen < cutoff` (no org_id filter but no per-row loop either) — scales fine (`signals/clusterer.py:152-193`) | — |

## Systematic check: which jobs have the `auto_curator` bug class?

Every `LIMIT`-bearing selection query reachable from `run_maintenance_due`
was individually re-read and classified. "Bug class" = candidate-set
selection query with `LIMIT N` and **no `ORDER BY`** (or an `ORDER BY` that
doesn't rotate/watermark), run on a cadence shorter than the time it would
take to cover the full candidate population once — i.e. the exact shape that
makes `auto_curator` silently stop scaling.

| Query | File:line | Has `ORDER BY`? | Rotates/watermarks? | Verdict |
|---|---|---|---|---|
| `organizations` org list | `cron_tick.py:202` | No | No | **BUG — same class as reported** |
| `agent_issues` org/agent pairs (drift) | `drift_baseline_worker.py:27-33` | No | No | **BUG — same class** |
| `signal_events` org/signal pairs (classifier retrain) | `classifier_pipeline.py:234-241` | No | No | **BUG — same class, NEW this pass** |
| `telemetry_events` distinct tenant_id (cold-archive candidates) | `retention_cron.py:176-182` | No | No | **BUG — same class, NEW this pass** |
| `agent_issues` hot orgs (soft-issue review) | `soft_issue_review.py:103-113` | Yes, `n DESC` | Yes — re-ranks by fresh 24h activity every run | OK |
| `nl_signals` shadow detectors (promote/delete) | `soft_issue_review.py:401-411` | Yes, `created_at ASC` | FIFO, but consumption rate < creation rate (different bug — see #6, throughput not selection) | Partial — not the ORDER BY bug, but still an eventual-coverage problem |
| `columnar_partitions` due for compaction | `columnar/compaction.py:349-358` | Yes, `last_compaction_at ASC NULLS FIRST` | Yes — genuinely self-rotating watermark | **Best pattern in the codebase** |
| `signal_backfill_jobs` per-org trace window | `signals/backfill.py:204-219` | Yes, `trace_id`, with `OFFSET`=`traces_done` | Yes — resumable within a job, but `OFFSET` degrades on large windows (see #8) | OK with a caveat |
| `nudge_outcomes` shadow rows (outcome join) | `nudges/shadow_outcomes.py:14-42` | No | No | **BUG — same class, NEW this pass (pass 3)** — partially self-mitigating (see #10) but still the identical defect shape |

**Verdict: the pattern is confirmed to recur — again.** Pass 2 found three
independent instances of "candidate-selection query has a `LIMIT` and no
`ORDER BY`, run on a fixed schedule that never revisits the excluded tail" in
addition to the already-reported one (four total). Pass 3's exhaustive sweep
(below — every remaining cron-reachable *and* leader-loop query in the
codebase, not just the `run_maintenance_due` fan-out) found **one more**,
for **five total**:

1. `auto_curator` (`cron_tick.py:202`) — daily, 50-org cap, **no time-window
   floor at all** (scans the entire `organizations` table every day with
   nothing bounding candidate growth). Highest severity: the excluded set is
   permanent and grows with the whole org base, forever.
2. `drift_baselines` (`drift_baseline_worker.py:27-33`) — weekly, 100-pair
   cap, scoped to a 7-day activity window. Still no `ORDER BY`, but the 7-day
   window at least means the *set* of candidates changes week to week (an
   org/agent pair only "loses its seat" while it keeps generating fresh
   issues) — narrower blast radius than #1 but the same defect.
3. `classifier_retrain` (`classifier_pipeline.py:234-241`) — **every 15
   minutes**, 50-pair cap, 7-day activity window (**new finding**). Highest
   *tick frequency* of the three (96 tries/day vs. 1/day and 1/week), which
   somewhat self-heals if Postgres happens to vary its physical/hash-agg
   order run to run — but there is no guarantee of that, and a `SELECT
   DISTINCT` on a stable, mostly-append-only `signal_events` table commonly
   gets served by the same hash-aggregate plan run to run, in which case the
   same 50 (org, signal) pairs would win every single tick and every other
   pair's classifier would simply never retrain. This needs the same fix as
   #1/#2: rank by `MAX(detected_at)` ascending (stalest-first) or activity
   volume, mirroring `_rank_hot_orgs`.
4. `retention_cron`'s cold-archive candidate scan
   (`retention_cron.py:176-182`) — daily, 1,000-tenant cap, floored by
   `min_scan_days` (**new finding**). Lowest urgency of the four: 1,000 vs.
   a production org count in the low tens (a self-obs heartbeat comment
   elsewhere records "9 orgs" as of 2026-07-29, `cron_tick.py:80-81`) —
   *if* `telemetry_events.tenant_id` maps roughly 1:1 to `org_id`, that gives
   on the order of 100x headroom before this bites. That mapping is not
   independently confirmed in this pass (the "9 orgs" figure is a self-obs
   count from a different subsystem, not a `telemetry_events` tenant count),
   so treat the headroom estimate as directional, not exact. Still
   architecturally identical to #1 and should get the same fix opportunistically
   rather than being re-discovered under incident conditions once the tenant
   count grows.
5. `shadow_outcome_join` (`nudges/shadow_outcomes.py:14-42`) — **new this
   pass**, every 15 minutes, 200-row cap, 14-day window
   (`no.recorded_at >= now() - interval '14 days'`), no `ORDER BY`. Lowest
   severity of the five because it is *partially self-mitigating*: the query
   filters on `no.outcome_success IS NULL`, and every row it successfully
   processes gets `outcome_success` set (`shadow_outcomes.py:60-68`), which
   removes that row from the candidate set on the very next tick — the same
   "processing shrinks the pool" shape as `ArtifactDemotionWorker.run_once`
   (`nudges/demotion_worker.py:14-43`, `ORDER BY stumble_rate DESC`, ranked
   *and* self-clearing). But self-mitigation is not a substitute for
   determinism: without `ORDER BY`, Postgres is free to return a different
   physical subset on any run where the plan changes (autovacuum, a
   parallel-worker scan, a statistics refresh), and if the arrival rate of
   new `mode='shadow', matched=true` rows within a 15-minute window ever
   exceeds 200, there is no guarantee the *oldest* unresolved rows are the
   ones selected — some could be pushed out indefinitely by newer arrivals
   while never provably "stuck," exactly the invisible-failure shape
   described below. Confirmed by direct read of the full method body,
   `nudges/shadow_outcomes.py:14-73`.

## Why this bug class evades the existing monitoring

The task asked to check "no monitoring on failure" as part of the same
systematic pass. Cron/maintenance-loop monitoring in this codebase is
real and reasonably good at the *exception* level:
`run_if_leader` (`workers/leader.py:210-280`) tracks per-loop
`_work_failures` (`leader.py:113,259-269`) and per-loop tick counts
(`_tick_counts`), both surfaced into a self-obs heartbeat/status record
(`workers/main.py:492-509`) that feeds an admin status page and is wired to
page on new degraded/fail transitions (comment, `main.py:313-318`).

None of that catches the `LIMIT`-without-`ORDER BY` bug class, because
**the query never errors.** `auto_curator`, `drift_baselines`, and
`classifier_retrain` all return `200`/success-shaped results every single
run — `pg.fetch(...)` succeeds, `bounded_gather` completes, the tick logs
`"maintenance tick keys=[...]"` with no `errors` key (`main.py:676-686`).
There is no query that would ever raise here; the failure mode is a
silently-too-small result set, which is invisible to exception-based
monitoring, exit-code checks, or heartbeat pings by construction. This
matches 2026 industry guidance directly (see Research below): "a due,
active job must run" is a necessary but not sufficient correctness bar — a
scheduler/job framework that only guarantees delivery of the *tick*
provides zero guarantee about the *coverage* of what that tick's query
selects. The only way to catch this class is either (a) a coverage metric
(e.g. `distinct orgs curated in the last N days` vs. `total active orgs`,
alerting on a growing gap) or (b) fixing the selection query itself to be
watermarked so there is structurally no excluded tail to miss.

## Other concrete inefficiencies (file:line)

5. **`soft_issue_review.run_once` processes its 20 orgs strictly
   sequentially** — `soft_issue_review.py:75-90`
   (`for org_id in org_ids: ... await self._review_org(...)`). Each org can
   issue up to 3 sequential LLM calls (`_review_org`, `:165-183`, itself a
   sequential `for agent_id in agents` loop). Worst case ~60 sequential LLM
   round-trips in one job, serialized. `auto_curator` already has the fix
   pattern next door (`bounded_gather(limit=8)`, `cron_tick.py:226-230`) —
   `_claim_org` (per-org Redis claim, `soft_issue_review.py:482-507`)
   already makes cross-pod concurrency safe, so nothing structural blocks
   parallelizing this loop too.

6. **Shadow-detector creation throughput exceeds promotion/deletion
   throughput — unbounded backlog growth in `nl_signals`.** Creation:
   ≤20 orgs/night × ≤3 detectors/org = ≤60/night ≈ 420/week
   (`_MAX_ORGS_PER_NIGHT=20`, `_MAX_NEW_DETECTORS_PER_ORG=3`,
   `soft_issue_review.py:46,49`). Consumption: `promote_shadow_detectors`
   runs **weekly** and inspects only the oldest **200** rows globally
   (`soft_issue_review.py:401-411`, `LIMIT 200`). 420 created/week vs. 200
   evaluated/week means the `enabled=false` backlog in `nl_signals` grows
   without bound over time, and it's a single global FIFO queue not scoped
   per org, so a burst from one noisy org can delay every other org's
   detectors from ever being evaluated. This one *does* have an `ORDER BY`
   (`created_at ASC`), so it is not the same defect as #1/#2/#3/#4 above —
   it is a throughput-budget mismatch, not a missing-watermark bug. Also:
   rows that never reach `min_firings` (20) just sit in `hold` state
   indefinitely — no age-based expiry/deletion exists for stale non-firing
   shadow detectors.

7. **`drift_baselines` also does a fully sequential 7-dimension nested
   loop** — `drift_baseline_worker.py:35-44`, 7 dimensions
   (`insights/drift_reports.py:14-22`) — up to 1,400 sequential DB
   round-trips in one weekly run (100-pair cap × 7 dimensions × up to 2
   round-trips/dimension: one `_histogram` read plus one conditional
   `upsert_baseline` write when the histogram is non-empty,
   `drift_baseline_worker.py:59-79`, `drift_reports.py:249-257` —
   independently re-derived and confirmed exact), no batching/concurrency,
   on top of the missing-`ORDER BY` defect already covered in the
   systematic table above.

8. **`signal_backfill`'s per-job cursor uses `OFFSET`, not a true keyset
   cursor** — `signals/backfill.py:204-219`
   (`ORDER BY trace_id OFFSET $4 LIMIT $5` where `$4 = traces_done`). This is
   resumable and idempotent (correct behavior on crash/retry — the job
   record persists `traces_done` and picks up from there), which is the
   *good* half of the pattern. But `OFFSET n` still re-scans and discards the
   first `n` rows of the sort order on every batch, so a backfill job with a
   very large `traces_total` degrades toward O(n²) work across its batches
   instead of O(n). Not urgent — the window is capped at 30 days
   (`_DEFAULT_WINDOW_DAYS`/`enqueue_backfill` clamp, `backfill.py:16,63`) and
   `_MAX_TRACES_PER_MINUTE=100` — but the fix (compare `trace_id >
   $last_trace_id` instead of `OFFSET`) is small and turns this into the
   textbook keyset pattern research recommends below.

*(A ninth candidate item — `drift_baselines` and `shadow_promote` sharing
the Mon 04:00 UTC gate/`asyncio.gather` with no shared throughput budget —
was considered and cut: the mechanism is real (`cron_tick.py:425-451,
533-535`) but there is no measured contention or timeout evidence behind
it, so it isn't tracked as a numbered finding here.)*

None of the jobs scan all traces / all history unboundedly on the *data*
side — every hot path uses either a `LIMIT`, a fixed lookback window
(24h/7d/90d), or a set-based SQL statement. The real problems are (a) four
`LIMIT N` candidate-selection queries with no `ORDER BY` — one already
reported, three found this pass — meaning a fixed/arbitrary subset is served
every run while the excluded tail grows with the org base and is never
revisited; (b) one `LIMIT N` queue with a correct `ORDER BY` but a
throughput budget smaller than its input rate; and (c) avoidable
serialization within `soft_issue_review` and `drift_baseline_worker` where a
concurrency-bounded fan-out (the pattern `auto_curator` already uses) would
cut wall-clock roughly proportional to the concurrency limit chosen.

## Pass 3 — exhaustive final sweep: every remaining cron/scheduled job

Pass 2 scoped this doc to `run_maintenance_due`'s fan-out only. Pass 3 widens
the sweep to **every leader-elected background loop** (`workers/main.py`'s
`_supervise(...)` registrations, `main.py:278-343`) and every dormant/legacy
scheduler referenced anywhere in `src/eden`, since the task's own incident
text ("every background loop — maintenance, insights, EQL watchdog, webhook
drain, self-obs, quality pipeline, trace-finalized consumer") names five
loops this doc had never individually opened. Each was read in full and its
candidate-selection query (if any) classified the same way as the table
above.

| Loop / job | Registration | Query | Verdict |
|---|---|---|---|
| `insights_loop` | `main.py:278`, `_leader_insights_loop` → `InsightsDetectorLoop.tick_once` | Two-part: `_list_tenants_with_new_scores` (`insights/detector_loop.py:209-249`, set-based `EXISTS`/`UNION`, **no `LIMIT` at all** — every tenant with new data is returned) + `_process_tenant` (`:251-296`, `ORDER BY scored_at ASC, judge_run_id ASC LIMIT $n`, composite keyset) backed by a persisted per-tenant watermark table `judge_scores_processed` (`_read_watermark`/`_upsert_watermark`, `:427-497`) | **Best pattern in the codebase** — a true composite-key keyset cursor with a unique tiebreaker, exactly the shape the Research section below recommends. Arguably a stronger template than `compaction.py` since it has a tiebreaker column. |
| `eql_alert_watchdog` | `main.py:293`, → `AlertAsCode.fire_due` | `eql_alert_rules` where `enabled` and `next_fire_at <= now()`, `ORDER BY next_fire_at ASC NULLS FIRST LIMIT $2` (`dsl/alerts.py:274-312`) | OK — watermarked (`next_fire_at` itself is the cursor, advanced by `_evaluate_rule` after firing). |
| `artifact_demotion` | `main.py:300`, → `ArtifactDemotionWorker.run_once` | `nudges`/`nudge_outcomes` join, `ORDER BY stumble_rate DESC LIMIT $1` (`nudges/demotion_worker.py:14-43`) | OK — ranked worst-first *and* self-shrinking: a demoted row's `mode` flips off `'promoted'`, permanently removing it from the `WHERE n.mode = 'promoted'` predicate, so there is no excluded tail that survives across ticks. |
| `self_obs_probes` | `main.py:316`, → `run_scheduled_probes` → `_list_org_ids` | `SELECT id FROM organizations WHERE id > $cursor ORDER BY id LIMIT $2`, module-global `_rotation_cursor` wrapping to the start on exhaustion (`self_obs/scheduler.py:92-120`) | OK — genuine rotating keyset pagination, a second best-practice exemplar. |
| `webhook_drain` | `main.py:285`, → `process_pending_deliveries` | `webhook_deliveries` outbox, `status IN ('pending','retrying')`, `ORDER BY next_attempt_at NULLS FIRST` (`services/webhook_delivery.py:527-567`) | OK — watermarked, plus a Redis signal short-circuits the idle cooldown so enqueues are picked up without waiting for the poll boundary. |
| `worker_liveness_loop` | `main.py:343` | Unconditional heartbeat write, no candidate-selection query (`main.py:408-433`) | N/A — not this bug class by construction. |
| quality_pipeline sidecar (`SidecarWorker._poll_events`) | `workers/sidecars.py:248-286` → `observability/quality_pipeline/worker.py` | Forward keyset cursor, `ORDER BY created_at ASC, event_id ASC LIMIT $n`, cursor = `last_event_id` (`quality_pipeline/worker.py:1055-1097`) | OK — and notably, a comment at `quality_pipeline/worker.py:929` records that an **earlier version of the watermark's own storage query** (the cursor-value row itself, not the `telemetry_events` poll) **used `ORDER BY id DESC LIMIT 1` and grew without bound** before being fixed to a single upserted row. Direct in-codebase precedent that this general bug class (unbounded/unwatermarked selection) has bitten Eden before, in a different file, and been fixed correctly — the specific defect there (append-only cursor storage) differs from the missing-`ORDER BY` shape catalogued in this doc, but the lesson is the same. |
| `AutoDatasetScheduler` (`evaluation/scheduler.py`) | **Not registered anywhere** — `AutoDatasetScheduler(` has zero call sites outside its own module docstring example (`scheduler.py:17`); never `.start()`-ed from `workers/main.py`, `workers/leader.py`, or any API route | `_collect_traces`: `ORDER BY j.updated_at DESC LIMIT 1000` over a `trace_lookback_hours` window (`scheduler.py:205-231`) | **Correction, not a bug** — same shape as pass 1's `cusum_detect` finding: dormant/unreachable code, not on any active schedule in production today. Flagged for completeness only: if this scheduler is ever wired up, `ORDER BY ... DESC LIMIT 1000` on a *lookback window* has its own latent gap (a burst of >1000 completed jobs within one `trace_lookback_hours` window would silently drop the oldest of that burst, not just the newest) — worth using the same watermark fix below rather than `DESC` recency-limiting, before this is ever activated. |
| `cluster_signal` (`signals/clusterer.py:57-84`) | Called per `(org_id, signal_id)` from `signal_cluster_quiet`'s caller path | `ORDER BY detected_at DESC LIMIT 500` scoped to one org+signal and a `_LOOKBACK_DAYS` window | OK — not a global candidate-selection query; scoping to a single (org, signal) pair means there is no cross-tenant excluded tail, only a bounded per-signal window. |

**Net result of the sweep: no 6th instance.** Five leader-loop queries
outside the original `cron_tick.py` scope were checked in full and all five
are either watermarked, ranked-and-self-shrinking, unbounded-but-set-based
(no `LIMIT`), or not a candidate-selection query at all. Combined with the
one *new* finding inside the original scope (`shadow_outcome_join`, #5
above), this pass's total is **5 confirmed instances, 0 further instances
found after checking every other cron-reachable and leader-loop query in the
repository.**

## Pass 3 — Northflank `backoffLimit` sweep (same misconfiguration elsewhere?)

`grep -n "backoffLimit" northflank.yml` returns exactly three lines: two
comments describing the 2026-07-29 incident (`northflank.yml:598,609-610`)
and one live setting, `backoffLimit: 3` (`northflank.yml:623`, the fix for
`eden-worker`). **No other Northflank service in the manifest sets
`backoffLimit` to `0`, or to anything else, at all.**

There are only two `kind: Job` definitions in the whole file
(`grep -n "kind: Job" northflank.yml` → `northflank.yml:582`, `:792`):

- **`eden-worker`** (`:582-`) — has `settings: { backoffLimit: 3 }`
  (`:622-623`). Fixed, as already documented.
- **`eden-cron`** (`:792-`) — has **no `settings:` block and no
  `backoffLimit` key anywhere in its spec** (confirmed by reading the full
  block, `northflank.yml:792-825`: `compute`, `build`, `schedule`, `command`,
  `env` only). This means it silently inherits whatever Northflank's
  platform default is — the same default that was `0` for `eden-worker`
  before the incident fix made it explicit. **Currently inert risk, not an
  active one**: `eden-cron`'s `command` is a literal `echo ...; exit 0`
  (`:812-816`), so there is nothing for it to crash *doing*, which is why
  this has not caused an incident. But the gap is structurally identical to
  the pre-fix `eden-worker`: if `eden-cron` is ever re-enabled with a real
  command (its own comment block says "Kept as a free-tier job slot
  placeholder," `northflank.yml:786-790`, implying exactly that future),
  it would start from zero retries with no one having to opt into that,
  because the safe value was never made explicit. One-line fix,
  opportunistic: add `settings: { backoffLimit: 3 }` to `eden-cron` now,
  while it is risk-free to change, rather than waiting for someone to
  reactivate it and rediscover the default the hard way.

No `Service`-kind definitions (`eden-api`, `eden-staging-us-central`) carry a
`backoffLimit` field — that setting is Northflank's Job-specific retry
count; long-running services use a different restart-policy mechanism and
are out of scope for this specific check.

## Pass 3 — the exact unified fix

Every one of the 5 buggy queries needs the same shape of change: replace an
arbitrary/unordered `LIMIT N` with a deterministic **oldest-touched-first**
ordering backed by a persisted watermark, exactly what `columnar/compaction.py:349-358`
already does in-table (`ORDER BY last_compaction_at ASC NULLS FIRST`) and
what `insights/detector_loop.py:427-497` already does via a side table
(`judge_scores_processed`, composite `(scored_at, judge_run_id)` cursor).
Four of the five buggy queries select an *entity* (org, org/agent pair,
org/signal pair, tenant) that cannot easily grow an in-table watermark
column (`organizations`, `agent_issues`, `signal_events`, `telemetry_events`
are either shared/high-churn or not owned by the consuming job) — so the
right template for those four is `detector_loop.py`'s **side-table
watermark**, not `compaction.py`'s in-table column. The fifth
(`shadow_outcome_join`) is row-level and self-clearing, so it needs only an
`ORDER BY`, not a new table.

**1. One reusable helper (sketch, not implemented — this doc is
research-only): `eden/storage/watermark.py`.** Two functions, mirroring the
two patterns already proven correct in this codebase — `compaction.py`'s
in-table watermark column and `detector_loop.py`'s side-table composite
watermark:

- `fetch_stale_candidates(pg, *, candidates_cte, watermark_table, key_cols,
  limit, watermark_col="last_processed_at", params=())` — wraps the
  caller's WHERE-filtered candidate query in a CTE, left-joins it against a
  per-entity watermark table, and returns the `limit` rows with the oldest
  (or `NULL`) watermark first (`ORDER BY w.<watermark_col> ASC NULLS
  FIRST`).
- `advance_watermark(pg, *, watermark_table, key_cols, key_values,
  watermark_col="last_processed_at")` — an `INSERT ... ON CONFLICT
  (key_cols) DO UPDATE` upsert of `NOW()` into that table, called once a
  candidate finishes processing.

Together these replace `SELECT ... LIMIT N` with no `ORDER BY` — undefined
order per Postgres's own docs, see Research below — with a deterministic,
self-rotating selection: whatever was processed longest ago (or never) is
always picked first, so there is structurally no excluded tail to miss.

**2. The four entity-selection fixes, each a two-line call-site change plus
one new watermark table (`CREATE TABLE ... (key_cols..., last_processed_at
TIMESTAMPTZ, PRIMARY KEY (key_cols...))`, mirroring `judge_scores_processed`'s
shape exactly):**

| Query | Before | After |
|---|---|---|
| `auto_curator` (`cron_tick.py:202`) | `SELECT id::text AS org_id FROM organizations LIMIT 50` | `fetch_stale_candidates(pg, candidates_cte="SELECT id::text AS org_id FROM organizations", watermark_table="auto_curator_watermark", key_cols=("org_id",), limit=50)`; call `advance_watermark(...)` per org at the end of `AutoCurator.run_for_org` (`evaluation/auto_curator.py:34`). |
| `drift_baselines` (`drift_baseline_worker.py:27-33`) | `SELECT DISTINCT org_id, agent_id FROM agent_issues WHERE last_seen >= now()-7d LIMIT 100` | Same helper, `candidates_cte` unchanged, `watermark_table="drift_baseline_watermark"`, `key_cols=("org_id","agent_id")`; advance after the 7-dimension loop completes for that pair. |
| `classifier_retrain` (`classifier_pipeline.py:234-241`) | `SELECT DISTINCT org_id, signal_id FROM signal_events WHERE detected_at > now()-7d LIMIT 50` | Same helper, `watermark_table="classifier_retrain_watermark"`, `key_cols=("org_id","signal_id")` — this is now literally the same shape as `insights/detector_loop.py`'s already-working pattern for a near-identical `(org, signal)` retrain problem; copy its watermark table, don't reinvent it. |
| `retention_cron` cold-archive scan (`retention_cron.py:176-182`) | `SELECT DISTINCT tenant_id FROM telemetry_events WHERE timestamp < ... LIMIT 1000` | Same helper, `watermark_table="retention_archive_watermark"`, `key_cols=("tenant_id",)`. |

**3. The fifth (`shadow_outcome_join`, `nudges/shadow_outcomes.py:14-42`)
needs no new table** — it is already self-clearing (processing sets
`outcome_success`, removing the row from the `WHERE ... IS NULL` predicate).
The fix is a one-line addition, same shape as `webhook_delivery.py`'s
`ORDER BY next_attempt_at NULLS FIRST` or `demotion_worker.py`'s
`ORDER BY stumble_rate DESC`:

```sql
-- add before "LIMIT $1" in nudges/shadow_outcomes.py:41
ORDER BY no.recorded_at ASC
```

This alone removes the nondeterminism: oldest unresolved shadow outcomes are
now guaranteed to be attempted first every tick, so a burst of >200
new rows in one 15-minute window can never starve an older unresolved row
indefinitely.

## Research: 2026 scheduled-job design at scale

- **Idempotency is the load-bearing property, not an optional extra.**
  Production schedulers are at-least-once by default; a job must produce the
  same result whether it runs once or twice (operator reruns, container
  restarts re-queuing pending work). Eden's per-org work is generally good
  on this axis already: `AutoCurator.run_for_org` upserts eval slices
  (`evaluation/auto_curator.py:34`, `_upsert_slices`), and
  `soft_issue_review` dedupes shadow detectors by a content-addressed
  `cluster_id = signal_signature(description)` so "re-running the night
  never creates duplicates" (`soft_issue_review.py:17-19`). The bug class
  found in this pass is upstream of that — in *which* candidates get
  selected, not in what happens once they're selected.
  [CronGuard — 12 Cron Job Best Practices for Production (2026)](https://www.cronguard.dev/guides/cron-job-best-practices)
- **Watermarks over full rescans.** Use an incremental marker
  (`last_sync_at`, `processed_until_id`) instead of re-scanning the whole
  table and hoping a `LIMIT` catches everything relevant. Eden's
  `ColumnarCompactor.compact_due` (`columnar/compaction.py:349-358`,
  `ORDER BY last_compaction_at ASC NULLS FIRST`) is exactly this pattern
  done correctly and is the template the other four buggy queries should
  copy — order by "how long since we last touched this candidate," oldest
  first.
  [CronWizard — Cron Job Best Practices for Production Systems](https://www.cronwizard.com/best-practices)
- **`LIMIT` without `ORDER BY` is undefined order, not "whatever's oldest."**
  Postgres makes no ordering guarantee absent `ORDER BY`; in practice this
  tends to be stable-per-plan (physical/insertion order, or a stable
  hash-aggregate for `DISTINCT`), which is exactly what turns "arbitrary"
  into "the same 50 rows every single time" — the mechanism behind all four
  bugs in this doc.
  [Sequin — Keyset Cursors, Not Offsets, for Postgres Pagination](https://blog.sequinstream.com/keyset-cursors-not-offsets-for-postgres-pagination/)
- **Keyset (cursor) pagination over `OFFSET`, with a unique tiebreaker.**
  `OFFSET` re-scans and discards every prior row on each batch (the `#8`
  finding above); the fix is `WHERE (sort_col, id) > (last_val, last_id)
  ORDER BY sort_col, id LIMIT n`. A non-unique sort column alone (e.g.
  `created_at` with millisecond collisions) silently skips or duplicates
  rows across pages — the fix is always a composite key with a unique
  tiebreaker.
  [OneUptime — How to Implement Keyset Pagination for Large Datasets](https://oneuptime.com/blog/post/2026-02-02-keyset-pagination/view)
- **Multi-tenant fairness needs an explicit mechanism, not an incidental
  side effect of `LIMIT`.** Sharded/round-robin queues (one logical shard
  per tenant, dequeued round-robin) and weighted fair dispatch (Temporal's
  task-queue fairness keys, AWS SQS Fair Queues as of July 2025) exist
  specifically so one tenant's backlog can't starve every other tenant's
  turn — the same failure shape as `shadow_promote`'s single global FIFO
  (#6 above), where one noisy org's detector backlog can delay every other
  org's detectors from ever being evaluated.
  [Inngest — How we built a fair multi-tenant queuing system](https://www.inngest.com/blog/building-the-inngest-queue-pt-i-fairness-multi-tenancy)
  · [AWS — Amazon SQS introduces fair queues for multi-tenant workloads](https://aws.amazon.com/about-aws/whats-new/2025/07/amazon-sqs-introduces-fair/)
- **Dead-letter handling and exit-status/heartbeat monitoring.** A job
  should exit non-zero (or, for a loop, record a structured failure) on
  error, emit a heartbeat on success, and quarantine poison messages rather
  than retrying them forever. `clickhouse_fallback_drain.py` already does
  this well: exponential backoff capped at `_BACKOFF_CAP_MINUTES`
  (`:170-173`), oldest-first draining, and an explicit dead-letter path
  (`mark_obsolete_pre_fix_rows_dead`, `:89-140`, setting `dead_at` so
  undiagnosable rows stop being retried forever without being silently lost).
  This is the best-designed job in the fleet and a reasonable template for
  hardening the others.
  [CronGuard — 12 Cron Job Best Practices for Production (2026)](https://www.cronguard.dev/guides/cron-job-best-practices)
- **Coverage/scale correctness, not just liveness, is the real bar at
  scale.** At high job-definition-count scale, the correctness contract
  designers are held to is "a due, active job must run" (at-least-once
  delivery) *and* explicit reasoning about idempotency — jobs are not
  assumed idempotent by default. Eden's leader-loop infrastructure
  (`workers/leader.py`) satisfies the delivery half well (confirmed this
  pass); the gap this doc identifies is entirely on the "what does the job's
  own query actually cover" half, which no scheduler-level guarantee can
  substitute for.
  [Prachub — Design a Cron Job Scheduler (Snowflake interview question writeup)](https://prachub.com/interview-questions/design-a-cron-job-scheduler)
- **This is not an Eden-specific quirk — Postgres's own documentation names
  the exact failure mode, in these words.** "When using `LIMIT`, it is
  important to use an `ORDER BY` clause that constrains the result rows into
  a unique order. Otherwise you will get an unpredictable subset of the
  query's rows... The ordering is unknown, unless you specified `ORDER BY`."
  And, on why it isn't "usually stable in practice": "you are very likely to
  get different plans (yielding different row orders) depending on what you
  give for `LIMIT`... This is not a bug; it is an inherent consequence of the
  fact that SQL does not promise to deliver the results of a query in any
  particular order unless `ORDER BY` is used." This upgrades all 5 findings
  in this doc from "an Eden bug" to "an instance of a documented,
  well-known SQL anti-pattern class" — worth a systemic code-review/lint
  gate rather than five one-off patches (see the proposed rule below).
  [PostgreSQL 17 docs — 7.6. LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html)
- **A concrete, implementable lint rule for this codebase.** Eden's SQL
  lives as raw triple-quoted strings passed to `asyncpg`-style calls
  (`pg.fetch(...)`, `client.fetchrow(...)`, confirmed interface at
  `storage/postgres.py:799-1040`), not a dbt/sqlfluff-managed SQL tree, so
  an off-the-shelf SQL linter doesn't directly apply. Minimal-effort
  equivalent: a small CI script (`scripts/lint_unordered_limit.py`, run as
  a pre-commit hook + required CI step alongside the existing `ruff`/`mypy`
  checks) that walks every `*.py` file under `src/eden/`, extracts
  triple-quoted strings passed as the first positional arg to
  `.fetch(`/`.fetchrow(`/`.fetchval(`, and fails the build listing
  `file:line` for any that contain `LIMIT` but not `ORDER BY` — with a
  single opt-out escape hatch (an inline `-- lint: unordered-limit-ok
  (reason)` comment) for legitimate exceptions like existence checks
  (`SELECT 1 ... LIMIT 1`, `soft_issue_review.py:349`) where "which row" is
  meaningless. Run against the current tree, this rule would catch all 5
  findings in this doc and 0 false positives among the confirmed-OK queries
  catalogued above (every one of those already carries an `ORDER BY`).

---

## Verdicts (consolidated across all review passes)

Fact-check method: every cron-reachable module was read in full and
cross-checked against source (`cron_tick.py`, `drift_baseline_worker.py`,
`classifier_pipeline.py`, `retention_cron.py`, `soft_issue_review.py`,
`backfill.py`, `clickhouse_fallback_drain.py`, `columnar/compaction.py`,
`clusterer.py`, `workers/main.py`, `workers/leader.py`, `northflank.yml`),
plus every leader-elected loop registered at `workers/main.py:278-343` and
the one dormant scheduler (`evaluation/scheduler.py`). A pass-4
fact-check independently re-verified ~35 file:line citations and every
quoted SQL string in this doc against source; all matched (several to the
exact line), and the one arithmetic claim independently re-derived from
scratch (drift_baselines' 1,400-round-trip figure) checked out exactly.

| Finding | Verdict | Note |
|---|---|---|
| #1 `auto_curator` org selection, no `ORDER BY` (`cron_tick.py:202`) | **KEEP — highest severity** | Silent, permanent, worsening-with-growth coverage gap, not a performance issue. Fix pattern already exists in-codebase (`compaction.py`'s watermark column). |
| #2 `drift_baselines` org/agent selection, no `ORDER BY`, 1,400-round-trip nested loop | **KEEP** | Re-verified this pass; round-trip math independently re-derived and confirmed exact. |
| #3 `classifier_retrain` org/signal selection, no `ORDER BY`, 96 ticks/day | **KEEP** | Same defect shape as #1/#2; highest tick frequency of the five, which somewhat self-heals only if Postgres varies its plan run to run — not guaranteed. |
| #4 `retention_cron` cold-archive scan, no `ORDER BY` | **KEEP — low urgency** | ~100x headroom estimate is directional (see caveat above), not an exact measurement. |
| #5 `shadow_outcome_join`, no `ORDER BY` | **KEEP — lowest severity** | Partially self-mitigating (row clears itself once resolved) but still nondeterministic under burst load. |
| `soft_issue_review` fully sequential 20-org loop (~60 LLM round-trips) | **KEEP-WITH-CAVEAT** | Wall-clock/job-duration concern; the cross-referenced ≈$0.20/night LLM-cost figure (file 03) is itself a code-comment-sourced worst-case ceiling, not a measured invoice line, so treat "not a cost concern" as directionally true rather than settled. |
| Shadow-detector creation (≤420/wk) exceeds promotion/deletion (200/wk) | **KEEP-WITH-CAVEAT** | Arithmetic checks out from code constants, but it's a worst-case ceiling, not a measured `nl_signals` backlog — worth a backlog-depth metric before prioritizing a fix. |
| `drift_baselines` sequential 7-dimension nested loop | **KEEP** | Same file as #2; fix pattern is the bounded-concurrency approach `auto_curator` already uses. |
| `signal_backfill` `OFFSET`-based cursor | **KEEP — low priority** | Correct/idempotent/resumable; only degrades once a backfill spans far more traces than today's 30-day/100-per-minute caps allow. |
| `drift_baselines`/`shadow_promote` share Mon 04:00 window, no throughput budget | **CUT** | Speculative — mechanism is real, no measured contention or timeout evidence. |
| 2026-07-29 `backoffLimit: 0` incident (7.4-day fleet outage) | **ADD as context** | Already remediated (`backoffLimit: 3`). Residual open risk: duplicate-fleet-on-deploy (`runOnSourceChange: cd-promote`), concretely five copies "RUNNING" at once per the incident comment — an infra/deploy follow-up, not a code-level cron fix. |
| `eden-cron`'s missing `backoffLimit` | **ADD — opportunistic** | Same unset-default gap `eden-worker` had pre-incident; currently inert since `eden-cron`'s command is a static no-op, but free to fix now (`backoffLimit: 3`). |
| Monitoring gap: `LIMIT`-without-`ORDER BY` is invisible to exception-based monitoring | **ADD** | Cross-cutting root cause behind #1-#5; needs either a coverage metric or the query fixes themselves. |
| Unified watermark-fix pattern | **ADD** | Trimmed to pattern description + call sites (full inline implementation removed — this doc is research-only, no code changed). |
| Lint rule proposal (`scripts/lint_unordered_limit.py`) | **ADD — systemic follow-up** | PostgreSQL's own docs confirm this is a documented anti-pattern class, justifying a standing CI check over five one-off patches. |
| "19 total queries classified (13 cron + 6 leader-loop)" tally | **CUT (imprecise)** | The two tables shown in this doc list 9 and 9 rows respectively, not 13 and 6 — the finer count wasn't reconciled to what's actually shown. The underlying conclusion (5 confirmed instances, 0 further found after an exhaustive sweep) is unaffected; the specific sub-counts are dropped rather than presented as a verified tally. |

(Findings above were built up across three review passes — an initial
systematic sweep of `run_maintenance_due`'s fan-out, then an exhaustive
sweep of every other leader-elected loop and dormant scheduler in the
repository. All were independently re-verified in pass 4; see the
consolidated verdict table above for the final status of each.)
