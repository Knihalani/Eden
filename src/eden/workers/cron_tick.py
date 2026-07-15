"""eden-cron entry point (Phase 3b, 2026-06-23).

Wired into the Northflank ``eden-cron`` scheduled job
(northflank.yml ``*/5 * * * *``). Every tick:

1. Cheap due-check for MCP rollup + classifier retrain (every 15 min).
2. If the UTC hour matches one of the heavier scheduled jobs,
   runs that as well:

   * **03:00 UTC** — the daily
     :func:`eden.data_platform.retention_cron.run` (Neon cost
     pass, partition manager, cold archive) + Typesense TTL cleanup.

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

logger = logging.getLogger("eden.workers.cron_tick")


async def _run_typesense_ttl_cleanup(*, dry_run: bool) -> dict[str, object]:
    """Delete Typesense span docs older than 90 days.

    Runs inside the daily 03:00 UTC job. Best-effort: a Typesense
    failure is logged and reported but never fails the cron tick.
    """
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
        return {"errors": [str(exc)]}


async def _run_daily(now: datetime, *, dry_run: bool) -> dict[str, object]:
    """Run the daily 03:00 UTC jobs: retention cron + Typesense TTL."""
    from eden.data_platform.retention_cron import run as retention_run

    out: dict[str, object] = {
        "retention_cron": {},
        "typesense_ttl_cleanup": {},
    }
    try:
        out["retention_cron"] = await retention_run(dry_run=dry_run)
    except Exception as exc:
        logger.exception("[cron_tick] retention_cron failed: %s", exc)
        out["retention_cron"] = {"errors": [str(exc)]}
    try:
        out["typesense_ttl_cleanup"] = await _run_typesense_ttl_cleanup(dry_run=dry_run)
    except Exception as exc:
        logger.exception("[cron_tick] typesense_ttl_cleanup failed: %s", exc)
        out["typesense_ttl_cleanup"] = {"errors": [str(exc)]}
    return out


async def _run_mcp_rollup(*, dry_run: bool) -> dict[str, object]:
    if dry_run:
        return {"skipped": True}
    try:
        from eden.services.observability import get_mcp_service

        return await get_mcp_service().rollup_registry()
    except Exception as exc:
        logger.exception("[cron_tick] mcp_rollup failed: %s", exc)
        return {"errors": [str(exc)]}


async def _run_classifier_retrain() -> dict[str, object]:
    try:
        from eden.signals.classifier_pipeline import ClassifierTrainingPipeline

        return await ClassifierTrainingPipeline().retrain_due_orgs()
    except Exception as exc:
        logger.exception("[cron_tick] classifier_retrain failed: %s", exc)
        return {"errors": [str(exc)]}


async def _tick(*, dry_run: bool) -> dict[str, object]:
    """A single cron tick."""
    now = datetime.now(UTC)
    out: dict[str, object] = {"tick_at": now.isoformat(), "dry_run": dry_run}

    # Daily @ 03:00 UTC: retention_cron + Typesense TTL.
    if now.hour == 3 and now.minute < 10:
        out["daily"] = await _run_daily(now, dry_run=dry_run)

    # Every 15 min: MCP registry rollup + classifier retrain (WS1).
    if now.minute % 15 < 5:
        out["mcp_rollup"] = await _run_mcp_rollup(dry_run=dry_run)
        if not dry_run:
            out["classifier_retrain"] = await _run_classifier_retrain()

    # N23: per-org improvement sweep when schedule is due.
    try:
        from eden.improvement.schedule import run_due_sweeps

        out["improvement_sweeps"] = await run_due_sweeps(dry_run=dry_run)
    except Exception as exc:
        logger.exception("[cron_tick] improvement_sweeps failed: %s", exc)
        out["improvement_sweeps"] = {"errors": [str(exc)]}

    return out


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
        help="If > 0, loop on this interval (for local dev). The "
             "production deploy uses the Northflank scheduler, not "
             "this in-process loop.",
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
                except Exception as exc:  # pragma: no cover - defensive
                    logger.exception("[cron_tick] tick failed: %s", exc)
                await asyncio.sleep(args.loop_seconds)
        else:
            result = await _tick(dry_run=args.dry_run)
            logger.info("[cron_tick] %s", result)

    asyncio.run(_go())
    return 0


if __name__ == "__main__":
    sys.exit(main())
