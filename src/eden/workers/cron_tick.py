"""eden-cron entry point (Phase 3b, 2026-06-23).

Wired into the Northflank ``eden-cron`` scheduled job
(northflank.yml ``*/5 * * * *``). Every tick:

1. EQL alert watchdog + columnar compaction (hourly window).
2. MCP rollup + classifier retrain (every 15 min).
3. N23 improvement sweeps when org schedule is due.
4. If the UTC hour matches one of the heavier scheduled jobs,
   runs that as well:

   * **03:00 UTC** — retention cron + Typesense TTL cleanup.

The hourly cadence is intentionally simple: every tick is
cheap, and only the daily jobs cost real money. The Northflank job
runs at ``*/5 * * * *`` with ``--no-dry-run``; we ignore the
intermediate ticks for the heavy jobs.

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


async def _run_daily(now: datetime, *, dry_run: bool) -> dict[str, object]:
    """Run the daily 03:00 UTC jobs: retention cron + Typesense TTL."""
    from eden.data_platform.retention_cron import run as retention_run

    out: dict[str, object] = {
        "retention_cron": {},
        "typesense_ttl_cleanup": {},
    }
    out["retention_cron"] = await _safe_step(
        "retention_cron", retention_run(dry_run=dry_run)
    )
    out["typesense_ttl_cleanup"] = await _safe_step(
        "typesense_ttl_cleanup", _run_typesense_ttl_cleanup(dry_run=dry_run)
    )
    return out


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


async def _run_eql_alert_watchdog(*, dry_run: bool) -> dict[str, object]:
    """Cat 19 alert-as-code watchdog — evaluate due rules."""
    if dry_run:
        return {"skipped": True, "reason": "dry_run"}
    try:
        from eden.dsl import AlertAsCode

        return await AlertAsCode().fire_due()
    except Exception as exc:
        logger.exception("[cron_tick] eql_alert_watchdog failed: %s", exc)
        return _err(exc)


async def _run_auto_curator() -> dict[str, object]:
    """Per-org auto-curator; one org failure must not abort the rest."""
    from eden.evaluation.auto_curator import AutoCurator
    from eden.storage.postgres import get_postgres_client

    pg = await get_postgres_client()
    if pg is None:
        return {"skipped": True, "reason": "postgres_unavailable"}
    org_rows = await pg.fetch(
        "SELECT id::text AS org_id FROM organizations LIMIT 50"
    )
    curator_out: list[dict[str, object]] = []
    curator = AutoCurator()
    errors = 0
    for orow in org_rows:
        oid = str(orow["org_id"])
        try:
            curator_out.append(await curator.run_for_org(oid))
        except Exception as exc:
            errors += 1
            logger.exception(
                "[cron_tick] auto_curator failed org=%s: %s", oid, exc
            )
            curator_out.append({"org_id": oid, "errors": [str(exc)]})
    result: dict[str, object] = {
        "orgs": len(curator_out),
        "runs": curator_out[:5],
        "error_count": errors,
    }
    if errors:
        result["errors"] = [f"{errors} org(s) failed"]
    return result


async def _tick(*, dry_run: bool) -> dict[str, object]:
    """A single cron tick (legacy entrypoint / manual escape hatch)."""
    now = datetime.now(UTC)
    out: dict[str, object] = {"tick_at": now.isoformat(), "dry_run": dry_run}

    out["eql_alert_watchdog"] = await _safe_step(
        "eql_alert_watchdog", _run_eql_alert_watchdog(dry_run=dry_run)
    )
    # Prefer the long-running worker for EQL when both are up; cron
    # remains a legacy fallback. Improvement sweeps are disabled here —
    # drafts are issue-driven (closed-loop / issue_patch_trigger) only.

    maint = await run_maintenance_due(now=now, dry_run=dry_run)
    out.update(maint)

    if not dry_run:
        out["artifact_demotion"] = await _safe_step(
            "artifact_demotion", _run_artifact_demotion()
        )

    return out


async def _once_per_window(key: str, *, ttl_seconds: int) -> bool:
    """Return True if this process won the window (Redis SET NX).

    Prevents the 5-minute worker loop from re-firing the same hourly /
    15-minute / daily slot. If Redis is down, allow the run (same
    best-effort behavior as the old cron cold-start).
    """
    try:
        from eden.storage.redis import get_redis_client

        r = await get_redis_client()
        if r is None:
            return True
        ok = await r.set(f"eden:maint:{key}", "1", nx=True, ex=ttl_seconds)
        return bool(ok)
    except Exception as exc:
        logger.warning("[cron_tick] once_per_window %s failed: %s", key, exc)
        return True


def _slot_key(prefix: str, now: datetime, *, minutes: int) -> str:
    """Stable key for a wall-clock slot (e.g. 15-minute buckets)."""
    slot = (now.hour * 60 + now.minute) // minutes
    return f"{prefix}:{now.date().isoformat()}:{slot}"


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
    * Independent due steps run concurrently via ``asyncio.gather``.
    * Shadow join is 15-minute, not every tick.
    """
    now = now or datetime.now(UTC)
    out: dict[str, object] = {"maintenance_at": now.isoformat(), "dry_run": dry_run}
    pending: dict[str, Any] = {}

    def _queue(name: str, coro: Any) -> None:
        pending[name] = coro

    if now.minute < 10:
        hour_key = f"compact:{now.date().isoformat()}:{now.hour:02d}"
        if await _once_per_window(hour_key, ttl_seconds=55 * 60):
            _queue(
                "columnar_compaction",
                _safe_step(
                    "columnar_compaction", _run_columnar_compaction(dry_run=dry_run)
                ),
            )
        else:
            out["columnar_compaction"] = {
                "skipped": True,
                "reason": "already_ran_this_hour",
            }

    if now.hour == 2 and now.minute < 10 and not dry_run:
        day_key = f"auto_curator:{now.date().isoformat()}"
        if await _once_per_window(day_key, ttl_seconds=20 * 3600):
            _queue("auto_curator", _safe_step("auto_curator", _run_auto_curator()))
        else:
            out["auto_curator"] = {"skipped": True, "reason": "already_ran_today"}

    if now.hour == 3 and now.minute < 10:
        day_key = f"daily:{now.date().isoformat()}"
        if await _once_per_window(day_key, ttl_seconds=20 * 3600):
            _queue("daily", _run_daily(now, dry_run=dry_run))
        else:
            out["daily"] = {"skipped": True, "reason": "already_ran_today"}

    if now.weekday() == 0 and now.hour == 4 and now.minute < 10 and not dry_run:
        week_key = f"drift:{now.isocalendar().week}:{now.year}"
        if await _once_per_window(week_key, ttl_seconds=6 * 24 * 3600):
            _queue(
                "drift_baselines",
                _safe_step("drift_baselines", _run_drift_baselines()),
            )
        else:
            out["drift_baselines"] = {
                "skipped": True,
                "reason": "already_ran_this_week",
            }

    if now.minute % 15 < 5:
        mcp_key = _slot_key("mcp", now, minutes=15)
        if await _once_per_window(mcp_key, ttl_seconds=14 * 60):
            _queue("mcp_rollup", _run_mcp_rollup(dry_run=dry_run))
            if not dry_run:
                _queue("classifier_retrain", _run_classifier_retrain())
        else:
            out["mcp_rollup"] = {"skipped": True, "reason": "already_ran_this_slot"}

    # improvement_sweeps intentionally omitted — issue-driven drafts only.
    out["improvement_sweeps"] = {
        "skipped": True,
        "reason": "issue_driven_only_use_closed_loop",
    }

    if not dry_run:
        shadow_key = _slot_key("shadow", now, minutes=15)
        if await _once_per_window(shadow_key, ttl_seconds=14 * 60):
            _queue(
                "shadow_outcome_join",
                _safe_step("shadow_outcome_join", _run_shadow_outcome_join()),
            )
        else:
            out["shadow_outcome_join"] = {
                "skipped": True,
                "reason": "already_ran_this_slot",
            }

    if not dry_run and now.minute % 10 < 5:
        sig_key = _slot_key("signal", now, minutes=10)
        if await _once_per_window(sig_key, ttl_seconds=9 * 60):
            _queue(
                "signal_backfill",
                _safe_step("signal_backfill", _run_signal_backfill()),
            )
            _queue(
                "signal_cluster_quiet",
                _safe_step("signal_cluster_quiet", _run_signal_cluster_quiet()),
            )
        else:
            out["signal_backfill"] = {
                "skipped": True,
                "reason": "already_ran_this_slot",
            }

    if pending:
        names = list(pending.keys())
        results = await asyncio.gather(
            *(pending[n] for n in names), return_exceptions=True
        )
        for name, result in zip(names, results, strict=True):
            if isinstance(result, BaseException):
                logger.exception(
                    "[cron_tick] %s failed after gather: %s", name, result
                )
                out[name] = _err(result)
            else:
                out[name] = result  # type: ignore[assignment]

    return out


async def _run_drift_baselines() -> dict[str, object]:
    from eden.insights.drift_baseline_worker import DriftBaselineWorker

    return await DriftBaselineWorker().run_once()


async def _run_improvement_sweeps(*, dry_run: bool) -> dict[str, object]:
    from eden.improvement.schedule import run_due_sweeps

    return await run_due_sweeps(dry_run=dry_run)


async def _run_artifact_demotion() -> dict[str, object]:
    from eden.nudges.demotion_worker import ArtifactDemotionWorker

    return await ArtifactDemotionWorker().run_once()


async def _run_shadow_outcome_join() -> dict[str, object]:
    from eden.nudges.shadow_outcomes import ShadowOutcomeJoiner

    return await ShadowOutcomeJoiner().run_once()


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
