"""eden-cron entry point (Phase 3b, 2026-06-23).

Wired into the Northflank ``eden-cron`` scheduled job
(northflank.yml ``*/5 * * * *``). Every tick runs
:func:`run_maintenance_due`, which:

1. Runs columnar compaction on an hourly window.
2. Runs MCP rollup + classifier retrain every 15 minutes.
3. At **03:00 UTC**, runs the daily retention cron + Typesense TTL cleanup.

It deliberately **skips** EQL alert watchdog, artifact demotion, and
N23 improvement sweeps — those are hosted separately on ``eden-worker``
or intentionally off (see :func:`run_maintenance_due`).

The 5-minute Northflank cadence is intentional: every tick is cheap,
and only the daily jobs cost real money. Intermediate ticks are no-ops
for the heavy daily work.

CLI:

    python -m eden.workers.cron_tick                    # single tick
    python -m eden.workers.cron_tick --dry-run         # no LLM calls
    python -m eden.workers.cron_tick --no-dry-run      # production
    python -m eden.workers.cron_tick --once            # alias for default

Exit code: 0 always (a tick failure is logged + the next tick
gets a fresh attempt; the Northflank job should not flap).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger("eden.workers.cron_tick")


def _err(exc: BaseException) -> dict[str, object]:
    """Structured failure payload for tick result dicts."""
    return {"errors": [str(exc)]}


async def _safe_step(name: str, coro: Any) -> dict[str, object] | object:
    """Await a step; log + return ``{"errors": [...]}`` on failure (never raise)."""
    try:
        return await coro
    except Exception as exc:
        logger.exception("[cron_tick] %s failed: %s", name, exc)
        return _err(exc)


async def _run_typesense_ttl_cleanup(*, dry_run: bool) -> dict[str, object]:
    """Delete Typesense span docs older than 90 days."""
    if dry_run:
        return {"skipped": True, "reason": "dry_run"}
    try:
        import time as _time

        from eden.observability.typesense_client import get_typesense_client

        client = get_typesense_client()
        if client is None:
            return {"skipped": True, "reason": "typesense_disabled"}
        cutoff = int(_time.time()) - 90 * 24 * 3600
        deleted = await client.delete_older_than(cutoff)
        return {"deleted": deleted, "cutoff_epoch": cutoff}
    except Exception as exc:
        logger.exception("[cron_tick] typesense_ttl_cleanup failed: %s", exc)
        return _err(exc)


# Self-observability tables and how long to keep them. Both are written
# by the platform about itself, on a fixed cadence, forever — and until
# 2026-07-29 nothing ever deleted from either.
#
# Measured on production that day, with 9 orgs and ZERO user telemetry
# in the previous 24h:
#     eden_synthetic_runs      4,860 rows/day
#     eden_component_heartbeats  2,933 rows/day
#
# The synthetic writer is the one that scales: run_golden_probes
# persists one row per probe per org per tick, so it is
# O(orgs x 5 probes x 144 ticks/day) — ~7.2M rows/day at 10,000 orgs,
# none of it user data. Retention does not fix that amplification (see
# the note on run_golden_probes), but it does stop the table growing
# without bound while that is addressed.
#
# 14 days is well past the dashboards that read these (the admin status
# page reads the most recent rows) and past any incident window where
# the history is useful.
_SELF_OBS_RETENTION = (
    ("eden_synthetic_runs", "created_at", 14),
    ("eden_component_heartbeats", "checked_at", 14),
)


async def _run_self_obs_retention(*, dry_run: bool) -> dict[str, object]:
    """Delete self-observability rows older than their retention window."""
    if dry_run:
        return {"skipped": True, "reason": "dry_run"}
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
        if pg is None:
            return {"skipped": True, "reason": "postgres_unavailable"}
        deleted: dict[str, object] = {}
        for table, ts_col, days in _SELF_OBS_RETENTION:
            try:
                # DELETE ... RETURNING would materialise every row; the
                # command tag is enough and costs nothing extra.
                tag = await pg.execute(
                    f"DELETE FROM {table} "  # noqa: S608 - fixed identifiers above
                    f"WHERE {ts_col} < now() - make_interval(days => $1)",
                    days,
                )
                deleted[table] = tag
            except Exception as exc:
                # A table that has not been migrated yet must not abort
                # the rest of the daily batch.
                logger.warning("[cron_tick] self_obs retention %s failed: %s", table, exc)
                deleted[table] = f"error: {str(exc)[:120]}"
        return deleted
    except Exception as exc:
        logger.exception("[cron_tick] self_obs_retention failed: %s", exc)
        return _err(exc)


async def _run_daily(now: datetime, *, dry_run: bool) -> dict[str, object]:
    """Run the daily 03:00 UTC jobs: retention cron + Typesense TTL."""
    from eden.data_platform.retention_cron import run as retention_run

    out: dict[str, object] = {
        "retention_cron": {},
        "typesense_ttl_cleanup": {},
        "self_obs_retention": {},
    }
    out["retention_cron"] = await _safe_step("retention_cron", retention_run(dry_run=dry_run))
    out["typesense_ttl_cleanup"] = await _safe_step(
        "typesense_ttl_cleanup", _run_typesense_ttl_cleanup(dry_run=dry_run)
    )
    out["self_obs_retention"] = await _safe_step(
        "self_obs_retention", _run_self_obs_retention(dry_run=dry_run)
    )
    return out


async def _run_post_merge_monitor(*, dry_run: bool) -> dict[str, object]:
    """Wave 4 (4.2): close due post-merge watch windows."""
    from eden.improvement.post_merge_monitor import PostMergeMonitor

    if dry_run:
        return {"skipped": True, "reason": "dry_run"}
    return await PostMergeMonitor().run_due()


async def _run_mcp_rollup(*, dry_run: bool) -> dict[str, object]:
    if dry_run:
        return {"skipped": True}
    try:
        from eden.services.observability import get_mcp_service

        return await get_mcp_service().rollup_registry()
    except Exception as exc:
        logger.exception("[cron_tick] mcp_rollup failed: %s", exc)
        return _err(exc)


async def _run_classifier_retrain() -> dict[str, object]:
    try:
        from eden.signals.classifier_pipeline import ClassifierTrainingPipeline

        return await ClassifierTrainingPipeline().retrain_due_orgs()
    except Exception as exc:
        logger.exception("[cron_tick] classifier_retrain failed: %s", exc)
        return _err(exc)


async def _run_columnar_compaction(*, dry_run: bool) -> dict[str, object]:
    """Hourly Cat 18 compaction watchdog."""
    if dry_run:
        return {"skipped": True, "reason": "dry_run"}
    try:
        from eden.columnar import ColumnarCompactor

        return await ColumnarCompactor().compact_due()
    except Exception as exc:
        logger.exception("[cron_tick] columnar_compaction failed: %s", exc)
        return _err(exc)


#: Max orgs curated concurrently per tick. Each org runs its own sequential
#: chain of Postgres queries, so this is also the peak number of pool
#: connections the step holds.
_AUTO_CURATOR_CONCURRENCY = 8
#: Daily batch size — watermarked oldest-processed-first, not a fixed prefix.
_AUTO_CURATOR_BATCH_SIZE = 50
_AUTO_CURATOR_WATERMARK_TABLE = "auto_curator_watermark"


async def _run_auto_curator() -> dict[str, object]:
    """Per-org auto-curator; one org failure must not abort the rest."""
    from eden.async_tasks import bounded_gather
    from eden.evaluation.auto_curator import AutoCurator
    from eden.storage.postgres import get_postgres_client
    from eden.storage.watermark import advance_watermark, fetch_stale_candidates

    pg = await get_postgres_client()
    if pg is None:
        return {"skipped": True, "reason": "postgres_unavailable"}
    # Watermarked oldest-processed-first selection (OPT-3) — the prior bare
    # ``SELECT id::text AS org_id FROM organizations LIMIT 50`` with no
    # ``ORDER BY`` returned the same stable-but-arbitrary 50 orgs every
    # single day forever, silently starving everything past row 50. See
    # ``eden.storage.watermark`` and migration 144_auto_curator_watermark.
    org_rows = await fetch_stale_candidates(
        pg,
        candidate_table="organizations",
        watermark_table=_AUTO_CURATOR_WATERMARK_TABLE,
        candidate_id_column="id",
        watermark_id_column="org_id",
        id_alias="org_id",
        limit=_AUTO_CURATOR_BATCH_SIZE,
    )
    from eden.workers.leader import record_watermark_batch

    try:
        org_total = await pg.fetchval("SELECT COUNT(*) FROM organizations")
    except Exception:
        org_total = None
    record_watermark_batch(
        "auto_curator",
        batch_size=len(org_rows),
        candidate_total=int(org_total) if org_total is not None else None,
    )
    curator = AutoCurator()
    org_ids = [str(orow["org_id"]) for orow in org_rows]

    async def _curate_org_and_advance(oid: str) -> dict[str, object]:
        try:
            return await curator.run_for_org(oid)
        finally:
            # Advance on success *and* failure — a poison org that always
            # raises must still advance, or it permanently occupies the
            # front of the watermark ordering and blocks every org behind
            # it forever.
            try:
                await advance_watermark(
                    pg,
                    watermark_table=_AUTO_CURATOR_WATERMARK_TABLE,
                    entity_id=oid,
                )
            except Exception:
                logger.exception(
                    "[cron_tick] auto_curator watermark advance failed org=%s",
                    oid,
                )

    # Was a strictly sequential ``for`` over up to 50 orgs, each of which
    # issues several Postgres round-trips (``_top_agents``, one
    # ``_sample_traces`` + ``_upsert_slices`` per agent, ``_record_run``).
    # The tick's wall clock was therefore the *sum* of every org's latency
    # while the pool sat idle. ``bounded_gather`` overlaps them under the
    # shared process-local semaphore so a slow org cannot monopolise the
    # tick and the fan-out still cannot exceed ``limit`` concurrent orgs.
    #
    # The limit is deliberately well below the pool size: each org runs its
    # own sequential chain, so ``limit`` is also the peak number of pool
    # connections this step holds. ``_run_auto_curator`` is reached only
    # from ``run_tick`` (the cron worker), never from a request handler, so
    # there is no request-pinned connection in the context here — the
    # single-operation-per-connection rule that would otherwise forbid a
    # concurrent fan-out does not apply. The route-level entry point
    # (``routes/learn.py``) calls ``AutoCurator.run_for_org`` directly for a
    # single org and is unaffected.
    #
    # ``bounded_gather`` preserves input order, so ``runs`` still lines up
    # with ``org_rows``.
    settled = await bounded_gather(
        *(_curate_org_and_advance(oid) for oid in org_ids),
        limit=_AUTO_CURATOR_CONCURRENCY,
        return_exceptions=True,
    )

    curator_out: list[dict[str, object]] = []
    errors = 0
    for oid, outcome in zip(org_ids, settled, strict=True):
        if isinstance(outcome, BaseException):
            errors += 1
            logger.exception(
                "[cron_tick] auto_curator failed org=%s: %s",
                oid,
                outcome,
                exc_info=outcome,
            )
            curator_out.append({"org_id": oid, "errors": [str(outcome)]})
        else:
            curator_out.append(outcome)
    result: dict[str, object] = {
        "orgs": len(curator_out),
        "runs": curator_out[:5],
        "error_count": errors,
    }
    if errors:
        result["errors"] = [f"{errors} org(s) failed"]
    return result


async def _once_per_window(key: str, *, ttl_seconds: int) -> bool:
    """Return True if this process won the window (Redis SET NX).

    Prevents the 5-minute worker loop from re-firing the same hourly /
    15-minute / daily slot. If Redis is down, allow the run (same
    best-effort behavior as the old cron cold-start).

    A falsy ``SET NX`` is ambiguous and must not be read as "someone
    else claimed it". An Upstash instance past its plan limit serves
    reads and silently discards writes, so ``SET NX`` returns null with
    nobody holding the key. Treating that as a claim made every gated
    job — retention_cron, the Typesense TTL sweep, auto_curator,
    drift_baselines, mcp_rollup, classifier_retrain, shadow_outcome_join,
    signal_backfill — skip forever while the tick still reported success
    (the skips are filtered out of the caller's log line), which is
    exactly the shape of the July 2026 silent outage. Read the key back
    to disambiguate, the same way ``leader._acquire_with_fallback`` does.
    """
    try:
        from eden.storage.redis import get_redis_client

        r = await get_redis_client()
        if r is None:
            return True
        ok = await r.set(f"eden:maint:{key}", "1", nx=True, ex=ttl_seconds)
        if ok:
            return True
        holder = await r.get(f"eden:maint:{key}")
        if holder is None:
            # Refused with nothing holding it — the write was dropped,
            # not contended. Fail OPEN, matching the docstring.
            logger.warning(
                "[cron_tick] once_per_window %s: SET NX refused with no "
                "holder — Redis is not accepting writes; running anyway",
                key,
            )
            return True
        return False
    except Exception as exc:
        try:
            from eden.storage.redis import note_redis_quota_exhausted

            note_redis_quota_exhausted(exc)
        except Exception:  # noqa: BLE001
            pass
        logger.warning("[cron_tick] once_per_window %s failed: %s", key, exc)
        return True


async def _release_window(key: str) -> None:
    """Drop a window claim so a failed job can retry on the next tick."""
    try:
        from eden.storage.redis import get_redis_client

        r = await get_redis_client()
        if r is None:
            return
        await r.delete(f"eden:maint:{key}")
    except Exception as exc:
        try:
            from eden.storage.redis import note_redis_quota_exhausted

            note_redis_quota_exhausted(exc)
        except Exception:  # noqa: BLE001
            pass
        logger.warning("[cron_tick] release_window %s failed: %s", key, exc)


def _slot_key(prefix: str, now: datetime, *, minutes: int) -> str:
    """Stable key for a wall-clock slot (e.g. 15-minute buckets)."""
    slot = (now.hour * 60 + now.minute) // minutes
    return f"{prefix}:{now.date().isoformat()}:{slot}"


def _result_failed(result: object) -> bool:
    """True when a step returned a structured error payload."""
    if isinstance(result, BaseException):
        return True
    return bool(isinstance(result, dict) and result.get("errors"))


async def _tick(*, dry_run: bool) -> dict[str, object]:
    """Legacy cron entrypoint — maintenance only (no EQL / demotion).

    EQL watchdog and artifact demotion live on ``eden-worker``; running
    them here doubles work if cron is ever re-enabled.
    """
    now = datetime.now(UTC)
    out: dict[str, object] = {"tick_at": now.isoformat(), "dry_run": dry_run}
    maint = await run_maintenance_due(now=now, dry_run=dry_run)
    out.update(maint)
    return out


async def run_maintenance_due(
    *,
    now: datetime | None = None,
    dry_run: bool = False,
) -> dict[str, object]:
    """Due maintenance jobs for the long-running worker (no cold-start cron).

    Skips EQL watchdog, artifact demotion, and improvement sweeps — those
    are hosted separately on ``eden-worker`` or intentionally off.

    Optimizations vs the old every-5m cold start:
    * Redis once-per-window so each slot runs at most once (not twice
      when minute is still inside ``< 5`` / ``< 10``).
    * Failed windows are released so the next tick can retry.
    * Independent due steps run concurrently via ``asyncio.gather``.
    * Shadow join is 15-minute, not every tick.
    """
    now = now or datetime.now(UTC)
    out: dict[str, object] = {"maintenance_at": now.isoformat(), "dry_run": dry_run}
    pending: dict[str, Any] = {}
    claim_keys: dict[str, str] = {}

    def _queue(name: str, coro: Any, *, claim: str | None = None) -> None:
        pending[name] = coro
        if claim is not None:
            claim_keys[name] = claim

    if now.minute < 10:
        hour_key = f"compact:{now.date().isoformat()}:{now.hour:02d}"
        if await _once_per_window(hour_key, ttl_seconds=55 * 60):
            _queue(
                "columnar_compaction",
                _safe_step("columnar_compaction", _run_columnar_compaction(dry_run=dry_run)),
                claim=hour_key,
            )
        else:
            out["columnar_compaction"] = {
                "skipped": True,
                "reason": "already_ran_this_hour",
            }

    if now.hour == 2 and now.minute < 10 and not dry_run:
        day_key = f"auto_curator:{now.date().isoformat()}"
        if await _once_per_window(day_key, ttl_seconds=20 * 3600):
            _queue(
                "auto_curator",
                _safe_step("auto_curator", _run_auto_curator()),
                claim=day_key,
            )
        else:
            out["auto_curator"] = {"skipped": True, "reason": "already_ran_today"}

    if now.hour == 3 and now.minute < 10:
        day_key = f"daily:{now.date().isoformat()}"
        if await _once_per_window(day_key, ttl_seconds=20 * 3600):
            _queue("daily", _run_daily(now, dry_run=dry_run), claim=day_key)
        else:
            out["daily"] = {"skipped": True, "reason": "already_ran_today"}

    # Soft Autonomy Phase 7 — nightly soft-issue novelty review.
    # Own 03:30 UTC slot so it never shares the daily retention claim.
    if now.hour == 3 and 30 <= now.minute < 40 and not dry_run:
        review_key = f"soft_issue_review:{now.date().isoformat()}"
        if await _once_per_window(review_key, ttl_seconds=20 * 3600):
            _queue(
                "soft_issue_review",
                _safe_step("soft_issue_review", _run_soft_issue_review()),
                claim=review_key,
            )
        else:
            out["soft_issue_review"] = {
                "skipped": True,
                "reason": "already_ran_today",
            }

    if now.weekday() == 0 and now.hour == 4 and now.minute < 10 and not dry_run:
        iso = now.isocalendar()
        week_key = f"drift:{iso.year}-W{iso.week:02d}"
        if await _once_per_window(week_key, ttl_seconds=6 * 24 * 3600):
            _queue(
                "drift_baselines",
                _safe_step("drift_baselines", _run_drift_baselines()),
                claim=week_key,
            )
        else:
            out["drift_baselines"] = {
                "skipped": True,
                "reason": "already_ran_this_week",
            }
        # M13 (§6.5): weekly shadow detector promote / delete.
        shadow_key = f"shadow_promote:{iso.year}-W{iso.week:02d}"
        if await _once_per_window(shadow_key, ttl_seconds=6 * 24 * 3600):
            _queue(
                "shadow_promote",
                _safe_step("shadow_promote", _run_shadow_promote()),
                claim=shadow_key,
            )
        else:
            out["shadow_promote"] = {
                "skipped": True,
                "reason": "already_ran_this_week",
            }

    if now.minute % 15 < 5:
        mcp_key = _slot_key("mcp", now, minutes=15)
        if await _once_per_window(mcp_key, ttl_seconds=14 * 60):
            _queue("mcp_rollup", _run_mcp_rollup(dry_run=dry_run), claim=mcp_key)
            if not dry_run:
                # Classifier shares the mcp slot claim; release on either failure.
                _queue(
                    "classifier_retrain",
                    _run_classifier_retrain(),
                    claim=mcp_key,
                )
            # Wave 4 (4.2): close due post-merge watch windows. Shares the
            # 15-min slot — the 1h window needs checking at least hourly
            # and the scan is a cheap indexed lookup.
            _queue(
                "post_merge_monitor",
                _run_post_merge_monitor(dry_run=dry_run),
                claim=mcp_key,
            )
        else:
            out["mcp_rollup"] = {"skipped": True, "reason": "already_ran_this_slot"}
            out["classifier_retrain"] = {
                "skipped": True,
                "reason": "already_ran_this_slot",
            }

    # improvement_sweeps intentionally omitted here — the N23 recurring
    # sweep is hosted by the worker's leader-gated ``improvement_sweep``
    # loop (Wave 1, F-I; see workers/main.py ``_leader_improvement_sweep``).
    # This maintenance tick stays issue-driven/closed-loop only.
    out["improvement_sweeps"] = {
        "skipped": True,
        "reason": "hosted_by_worker_improvement_sweep_loop",
    }

    if not dry_run:
        shadow_key = _slot_key("shadow", now, minutes=15)
        if await _once_per_window(shadow_key, ttl_seconds=14 * 60):
            _queue(
                "shadow_outcome_join",
                _safe_step("shadow_outcome_join", _run_shadow_outcome_join()),
                claim=shadow_key,
            )
        else:
            out["shadow_outcome_join"] = {
                "skipped": True,
                "reason": "already_ran_this_slot",
            }

    if not dry_run and now.minute % 10 < 5:
        # Its own slot rather than sharing the signal claim: a failing
        # signal backfill must not stop the fallback backlog draining,
        # and vice versa. Every 10 minutes because the table this drains
        # is written on every ClickHouse insert failure and, until this
        # step existed, was never read or deleted by anything.
        drain_key = _slot_key("ch_fallback_drain", now, minutes=10)
        if await _once_per_window(drain_key, ttl_seconds=9 * 60):
            _queue(
                "clickhouse_fallback_drain",
                _safe_step("clickhouse_fallback_drain", _run_clickhouse_fallback_drain()),
                claim=drain_key,
            )
        else:
            out["clickhouse_fallback_drain"] = {
                "skipped": True,
                "reason": "already_ran_this_slot",
            }

    if not dry_run and now.minute % 15 < 5:
        ptr_key = _slot_key("pointer_close", now, minutes=15)
        if await _once_per_window(ptr_key, ttl_seconds=14 * 60):
            _queue(
                "pointer_window_close",
                _safe_step("pointer_window_close", _run_pointer_window_close()),
                claim=ptr_key,
            )
        else:
            out["pointer_window_close"] = {
                "skipped": True,
                "reason": "already_ran_this_slot",
            }

    if not dry_run and now.minute % 10 < 5:
        sig_key = _slot_key("signal", now, minutes=10)
        if await _once_per_window(sig_key, ttl_seconds=9 * 60):
            _queue(
                "signal_backfill",
                _safe_step("signal_backfill", _run_signal_backfill()),
                claim=sig_key,
            )
            _queue(
                "signal_cluster_quiet",
                _safe_step("signal_cluster_quiet", _run_signal_cluster_quiet()),
                claim=sig_key,
            )
        else:
            out["signal_backfill"] = {
                "skipped": True,
                "reason": "already_ran_this_slot",
            }
            out["signal_cluster_quiet"] = {
                "skipped": True,
                "reason": "already_ran_this_slot",
            }

    if pending:
        names = list(pending.keys())
        results = await asyncio.gather(*(pending[n] for n in names), return_exceptions=True)
        failed_claims: set[str] = set()
        for name, result in zip(names, results, strict=True):
            if isinstance(result, BaseException):
                logger.exception("[cron_tick] %s failed after gather: %s", name, result)
                out[name] = _err(result)
                if name in claim_keys:
                    failed_claims.add(claim_keys[name])
            else:
                out[name] = result
                if _result_failed(result) and name in claim_keys:
                    failed_claims.add(claim_keys[name])
        for claim in failed_claims:
            await _release_window(claim)

    return out


async def _run_drift_baselines() -> dict[str, object]:
    from eden.insights.drift_baseline_worker import DriftBaselineWorker

    return await DriftBaselineWorker().run_once()


async def _run_soft_issue_review() -> dict[str, object]:
    from eden.services.soft_issue_review import SoftIssueReviewer

    return await SoftIssueReviewer().run_once()


async def _run_shadow_promote() -> dict[str, object]:
    """M13 (§6.5): weekly shadow detector promote / delete."""
    from eden.services.soft_issue_review import SoftIssueReviewer

    return await SoftIssueReviewer().promote_shadow_detectors()


async def _run_shadow_outcome_join() -> dict[str, object]:
    from eden.nudges.shadow_outcomes import ShadowOutcomeJoiner

    return await ShadowOutcomeJoiner().run_once()


async def _run_clickhouse_fallback_drain() -> dict[str, object]:
    """Replay rows that a failed ClickHouse insert parked in Postgres."""
    from eden.data_platform.clickhouse_fallback_drain import run_once

    return await run_once()


async def _run_pointer_window_close() -> dict[str, object]:
    """Path B window-close on the existing maintenance worker."""
    from eden.integrations.slack.ambient import close_due_pointer_windows

    return await close_due_pointer_windows()


async def _run_signal_backfill() -> dict[str, object]:
    from eden.signals.backfill import SignalBackfillWorker

    return await SignalBackfillWorker().run_once()


async def _run_signal_cluster_quiet() -> dict[str, object]:
    from eden.signals.clusterer import SignalEventClusterer

    return await SignalEventClusterer().resolve_quiet_clusters()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Skip LLM calls + DB writes (default true for safety).",
    )
    parser.add_argument(
        "--no-dry-run",
        dest="dry_run",
        action="store_false",
        help="Disable dry-run — actually call LLM + write to DB.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        default=True,
        help="Run one tick and exit (default — the Northflank job "
        "restarts the container every tick).",
    )
    parser.add_argument(
        "--loop-seconds",
        type=int,
        default=0,
        help="If > 0, loop on this interval (for local dev).",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    async def _go() -> None:
        if args.loop_seconds > 0:
            while True:
                try:
                    result = await _tick(dry_run=args.dry_run)
                    logger.info("[cron_tick] %s", result)
                except Exception as exc:  # pragma: no cover
                    logger.exception("[cron_tick] tick failed: %s", exc)
                await asyncio.sleep(args.loop_seconds)
        else:
            # Once-mode must also swallow tick failures so Northflank
            # does not flap; the next schedule is the retry.
            try:
                result = await _tick(dry_run=args.dry_run)
                logger.info("[cron_tick] %s", result)
            except Exception as exc:
                logger.exception("[cron_tick] tick failed: %s", exc)

    asyncio.run(_go())
    return 0


if __name__ == "__main__":
    sys.exit(main())
