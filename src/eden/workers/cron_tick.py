"""eden-cron entry point (Phase 3b, 2026-06-23).

Wired into the Northflank ``eden-cron`` scheduled job
(northflank.yml ``*/5 * * * *``). Every tick:

1. Runs :func:`eden.code_change.scheduler.evaluate_pending_clusters`
   so the Cat 23 pipeline sees new incident clusters within
   15 min (the scheduler's own internal cadence; ticks faster
   than the rate at which new clusters form).
2. If the UTC hour matches one of the heavier scheduled jobs,
   runs that as well:

   * **03:00 UTC** — :func:`stale_pending_sweep` + the daily
     :func:`eden.data_platform.retention_cron.run` (Neon cost
     pass, partition manager, cold archive).
   * **Monday 09:00 UTC** — :func:`weekly_digest`.

The hourly cadence is intentionally simple: every tick is
cheap (the scheduler pre-filters before LLM calls), and only
the daily / weekly jobs cost real money. The Northflank job
runs at ``*/5 * * * *``; we ignore the intermediate ticks for
the heavy jobs.

CLI:

    python -m eden.workers.cron_tick                    # single tick
    python -m eden.workers.cron_tick --dry-run         # no LLM calls
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


async def _run_daily(now: datetime, *, dry_run: bool) -> dict[str, object]:
    """Run the daily 03:00 UTC jobs: stale sweep + retention cron."""
    from eden.code_change.scheduler import stale_pending_sweep
    from eden.data_platform.retention_cron import run as retention_run

    out: dict[str, object] = {"stale_pending_sweep": {}, "retention_cron": {}}
    try:
        out["stale_pending_sweep"] = await stale_pending_sweep(dry_run=dry_run)
    except Exception as exc:
        logger.exception("[cron_tick] stale_pending_sweep failed: %s", exc)
        out["stale_pending_sweep"] = {"errors": [str(exc)]}
    try:
        out["retention_cron"] = await retention_run(dry_run=dry_run)
    except Exception as exc:
        logger.exception("[cron_tick] retention_cron failed: %s", exc)
        out["retention_cron"] = {"errors": [str(exc)]}
    return out


async def _run_weekly(now: datetime, *, dry_run: bool) -> dict[str, object]:
    """Run the Monday 09:00 UTC weekly digest."""
    from eden.code_change.scheduler import weekly_digest

    try:
        return await weekly_digest(dry_run=dry_run)
    except Exception as exc:
        logger.exception("[cron_tick] weekly_digest failed: %s", exc)
        return {"errors": [str(exc)]}


async def _tick(*, dry_run: bool) -> dict[str, object]:
    """A single cron tick. Always runs the scheduler; sometimes
    runs the daily / weekly jobs based on the UTC clock."""
    from eden.code_change.scheduler import evaluate_pending_clusters

    now = datetime.now(UTC)
    out: dict[str, object] = {"tick_at": now.isoformat(), "dry_run": dry_run}

    # 1. Always: Cat 23 scheduler (cheap because of pre-filters).
    try:
        out["cat23_scheduler"] = await evaluate_pending_clusters(
            dry_run=dry_run,
        )
    except Exception as exc:
        # Emit a structured marker so the NF log scraper
        # / alert rule can grep for it. ``logger.exception``
        # already logs the traceback at ERROR; the marker
        # is the operator-facing signal.
        logger.exception("[cron_tick] evaluate_pending_clusters failed: %s", exc)
        logger.error("CRON_TICK_FAILURE evaluate_pending_clusters %s", type(exc).__name__)
        out["cat23_scheduler"] = {"errors": [str(exc)], "failure_marker": True}

    # 2. Daily @ 03:00 UTC: stale_pending_sweep + retention_cron.
    if now.hour == 3 and now.minute < 10:
        out["daily"] = await _run_daily(now, dry_run=dry_run)

    # 3. Weekly Monday @ 09:00 UTC: weekly_digest.
    if now.weekday() == 0 and now.hour == 9 and now.minute < 10:
        out["weekly"] = await _run_weekly(now, dry_run=dry_run)

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