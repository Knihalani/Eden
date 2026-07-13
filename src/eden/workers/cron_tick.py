"""eden-cron entry point (Phase 3b, 2026-06-23).

Wired into the Northflank ``eden-cron`` scheduled job
(northflank.yml ``*/5 * * * *``). Every tick:

1. Runs :func:`eden.code_change.scheduler.evaluate_pending_clusters`
   so the Cat 23 pipeline sees new incident clusters within
   15 min (the scheduler's own internal cadence; ticks faster
   than the rate at which new clusters form).
2. Cheap due-check for the recurring optimization agent
   (:func:`eden.code_change.triggers.scheduled_trigger.run`) via
   :class:`eden.closed_loop.efficiency.AgentEfficiencyController`.
2b. Post-merge monitor tick
   (:meth:`eden.code_change.post_merge_monitor.PostMergeMonitor.tick_due`)
   so merged Cat 23 PRs get 1h/6h/24h/7d regression windows.
3. If the UTC hour matches one of the heavier scheduled jobs,
   runs that as well:

   * **03:00 UTC** — :func:`stale_pending_sweep` + the daily
     :func:`eden.data_platform.retention_cron.run` (Neon cost
     pass, partition manager, cold archive).
   * **Monday 09:00 UTC** — :func:`weekly_digest`.

The hourly cadence is intentionally simple: every tick is
cheap (the scheduler pre-filters before LLM calls), and only
the daily / weekly jobs cost real money. The Northflank job
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


async def _run_post_merge_monitor(*, dry_run: bool) -> dict[str, object]:
    """Tick the Cat 23 post-merge regression monitor."""
    try:
        from eden.code_change.post_merge_monitor import PostMergeMonitor

        return await PostMergeMonitor().tick_due(dry_run=dry_run)
    except Exception as exc:
        logger.exception("[cron_tick] post_merge_monitor failed: %s", exc)
        return {"errors": [str(exc)]}


async def _run_scheduled_optimization(
    now: datetime, *, dry_run: bool
) -> dict[str, object]:
    """Fire the recurring optimization agent for orgs whose schedule is due.

    Cheap path: every tick iterates opted-in orgs and runs
    :meth:`AgentEfficiencyController.should_run_scheduled` (pure due-check
    + optional budget). Only due orgs gather candidates and call
    :func:`scheduled_trigger.run`.
    """
    from eden.closed_loop.efficiency import AgentEfficiencyController
    from eden.code_change.candidate_sources import gather_candidates
    from eden.code_change.policy import CodeChangePolicyService
    from eden.code_change.scheduler import _get_org_policy, _list_active_orgs
    from eden.code_change.triggers import scheduled_trigger

    summary: dict[str, object] = {
        "orgs_scanned": 0,
        "orgs_due": 0,
        "orgs_run": 0,
        "dry_run": dry_run,
        "results": [],
    }
    ctrl = AgentEfficiencyController()
    results: list[dict[str, object]] = []

    try:
        orgs = await _list_active_orgs()
    except Exception as exc:
        logger.exception("[cron_tick] list active orgs failed: %s", exc)
        return {**summary, "errors": [str(exc)]}

    summary["orgs_scanned"] = len(orgs)
    for org_id in orgs:
        try:
            policy = await _get_org_policy(org_id)
            allowed, reason = await ctrl.should_run_scheduled(
                org_id, policy, now=now
            )
            if not allowed:
                continue
            summary["orgs_due"] = int(summary["orgs_due"]) + 1
            if dry_run:
                results.append(
                    {
                        "org_id": org_id,
                        "dry_run": True,
                        "reason": reason,
                    }
                )
                continue

            candidates = await gather_candidates(org_id, policy=policy)
            max_prs = int(policy.get("max_prs_per_run") or 2)
            run_summary = await scheduled_trigger.run(
                candidates,
                policy=policy,
                max_prs=max_prs,
            )
            # Stamp last run so the next tick in the hour window suppresses.
            try:
                await CodeChangePolicyService().update(
                    org_id,
                    {"last_optimization_run_at": now.isoformat()},
                )
            except Exception as stamp_exc:
                logger.debug(
                    "[cron_tick] stamp last_optimization_run_at failed: %s",
                    stamp_exc,
                )
            summary["orgs_run"] = int(summary["orgs_run"]) + 1
            results.append(
                {
                    "org_id": org_id,
                    "candidates": len(candidates),
                    **(run_summary if isinstance(run_summary, dict) else {}),
                }
            )
        except Exception as exc:
            logger.exception(
                "[cron_tick] scheduled optimization failed for %s: %s",
                org_id,
                exc,
            )
            results.append({"org_id": org_id, "error": str(exc)})

    summary["results"] = results
    return summary


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

    # 1b. Always: cheap due-check for the recurring optimization agent.
    try:
        out["scheduled_optimization"] = await _run_scheduled_optimization(
            now, dry_run=dry_run
        )
    except Exception as exc:
        logger.exception("[cron_tick] scheduled_optimization failed: %s", exc)
        out["scheduled_optimization"] = {
            "errors": [str(exc)],
            "failure_marker": True,
        }

    # 1c. Always: Cat 23 post-merge monitor (Gate 4b).
    try:
        out["post_merge_monitor"] = await _run_post_merge_monitor(
            dry_run=dry_run
        )
    except Exception as exc:
        logger.exception("[cron_tick] post_merge_monitor failed: %s", exc)
        out["post_merge_monitor"] = {
            "errors": [str(exc)],
            "failure_marker": True,
        }

    # 2. Daily @ 03:00 UTC: stale_pending_sweep + retention_cron.
    if now.hour == 3 and now.minute < 10:
        out["daily"] = await _run_daily(now, dry_run=dry_run)

    # 2b. Every 15 min: MCP registry rollup + classifier retrain (WS1).
    if now.minute % 15 < 5:
        out["mcp_rollup"] = await _run_mcp_rollup(dry_run=dry_run)
        if not dry_run:
            out["classifier_retrain"] = await _run_classifier_retrain()

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
