"""Auto-dataset scheduler for periodic golden dataset promotion.

Phase 5.6: Runs on a configurable schedule to:
1. Collect recent production traces
2. Score them for quality
3. Auto-promote high-quality traces to golden datasets
4. Generate periodic reports

Can be invoked via:
- APScheduler (in-process)
- Celery beat (distributed)
- CLI: eden dataset auto-promote --schedule
- GitHub Actions cron job

Usage:
    from eden.evaluation.scheduler import AutoDatasetScheduler
    scheduler = AutoDatasetScheduler()
    await scheduler.run_promotion_cycle()
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.config import get_settings
from eden.evaluation.auto_dataset import AutoDatasetPromoter, TraceQualityScorer

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class PromotionCycleReport:
    """Report from a single auto-promotion cycle."""

    cycle_id: str
    started_at: str
    completed_at: str | None = None
    traces_collected: int = 0
    traces_scored: int = 0
    traces_promoted: int = 0
    traces_rejected: int = 0
    new_cases_added: int = 0
    dataset_id: str = ""
    dataset_version: str = ""
    errors: list[str] = field(default_factory=list)
    duration_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "cycle_id": self.cycle_id,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "traces_collected": self.traces_collected,
            "traces_scored": self.traces_scored,
            "traces_promoted": self.traces_promoted,
            "traces_rejected": self.traces_rejected,
            "new_cases_added": self.new_cases_added,
            "dataset_id": self.dataset_id,
            "dataset_version": self.dataset_version,
            "errors": self.errors,
            "duration_ms": self.duration_ms,
        }


class AutoDatasetScheduler:
    """Scheduler for periodic auto-dataset promotion.

    Features:
    - Configurable promotion interval (default: daily)
    - Quality threshold adjustment based on dataset size
    - Duplicate trace detection (skip already-promoted traces)
    - Report generation and persistence
    - Dry-run mode for testing
    """

    DEFAULT_INTERVAL_HOURS = 24
    DEFAULT_TRACE_LOOKBACK_HOURS = 48
    DEFAULT_TARGET_DATASET = "gd_auto_production"

    def __init__(
        self,
        interval_hours: int = 24,
        trace_lookback_hours: int = 48,
        target_dataset_id: str = "gd_auto_production",
        promoter: AutoDatasetPromoter | None = None,
        dry_run: bool = False,
    ) -> None:
        self.interval_hours = interval_hours
        self.trace_lookback_hours = trace_lookback_hours
        self.target_dataset_id = target_dataset_id
        self.promoter = promoter or AutoDatasetPromoter()
        self.dry_run = dry_run
        self._running = False
        self._task: asyncio.Task | None = None
        self._postgres_client: Any | None = None

    async def _get_postgres(self) -> Any:
        if self._postgres_client is None:
            from eden.storage.postgres import get_postgres_client
            self._postgres_client = await get_postgres_client()
        return self._postgres_client

    # ── Core cycle ───────────────────────────────────────────────────────────

    async def run_promotion_cycle(self) -> PromotionCycleReport:
        """Execute one full auto-promotion cycle.

        Steps:
        1. Collect traces from the lookback period
        2. Filter out already-promoted traces
        3. Score and promote
        4. Persist report
        """
        start = datetime.now(UTC)
        cycle_id = f"apc-{start.strftime('%Y%m%d%H%M%S')}"
        report = PromotionCycleReport(
            cycle_id=cycle_id,
            started_at=start.isoformat(),
            dataset_id=self.target_dataset_id,
        )

        logger.info(f"Starting auto-promotion cycle {cycle_id}")

        try:
            # Step 1: Collect traces
            traces = await self._collect_traces()
            report.traces_collected = len(traces)

            if not traces:
                logger.info("No traces collected for promotion")
                report.completed_at = datetime.now(UTC).isoformat()
                report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
                await self._persist_report(report)
                return report

            # Step 2: Filter already-promoted traces
            filtered_traces = await self._filter_promoted_traces(traces)
            report.traces_scored = len(filtered_traces)

            if not filtered_traces:
                logger.info("All traces already promoted")
                report.completed_at = datetime.now(UTC).isoformat()
                report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
                await self._persist_report(report)
                return report

            # Step 3: Promote (or dry-run)
            if self.dry_run:
                logger.info(f"DRY RUN: Would process {len(filtered_traces)} traces")
                # Simulate scoring without actual promotion
                scorer = TraceQualityScorer()
                existing = self.promoter._registry.get(self.target_dataset_id)
                existing_cases = existing.cases if existing else []

                promoted = 0
                for trace in filtered_traces:
                    try:
                        score = scorer.score(trace, existing_cases)
                        if scorer.should_promote(score):
                            promoted += 1
                    except Exception as e:
                        report.errors.append(str(e))

                report.traces_promoted = promoted
                report.traces_rejected = len(filtered_traces) - promoted
                report.new_cases_added = promoted
            else:
                result = await self.promoter.process_traces(
                    traces=filtered_traces,
                    target_dataset_id=self.target_dataset_id,
                )
                report.traces_promoted = result["promoted"]
                report.traces_rejected = result["rejected"]
                report.new_cases_added = result["new_cases_added"]
                report.dataset_version = result["dataset_version"]

                # Mark traces as promoted
                await self._mark_traces_promoted(filtered_traces, cycle_id)

            report.completed_at = datetime.now(UTC).isoformat()

        except Exception as exc:
            logger.error(f"Promotion cycle failed: {exc}")
            report.errors.append(str(exc))
            report.completed_at = datetime.now(UTC).isoformat()

        report.duration_ms = (datetime.now(UTC) - start).total_seconds() * 1000
        await self._persist_report(report)

        logger.info(
            f"Promotion cycle {cycle_id} complete: "
            f"collected={report.traces_collected}, promoted={report.traces_promoted}, "
            f"new_cases={report.new_cases_added}"
        )
        return report

    async def _collect_traces(self) -> list[dict[str, Any]]:
        """Collect production traces from the lookback period.

        Sources traces from:
        - Completed jobs with successful outcomes
        - Checkpoint blobs containing test results
        - Usage events with rich metadata
        """
        client = await self._get_postgres()
        since = datetime.now(UTC) - timedelta(hours=self.trace_lookback_hours)

        # Collect from completed jobs
        rows = await client.fetch(
            """
            SELECT
                j.job_id,
                j.request,
                j.outcome_tier,
                j.status,
                j.created_at,
                j.updated_at
            FROM jobs j
            WHERE j.status = 'completed'
              AND j.outcome_tier IS NOT NULL
              AND j.updated_at >= $1
            ORDER BY j.updated_at DESC
            LIMIT 1000
            """,
            since.isoformat(),
        )

        traces = []
        for row in rows:
            request = row["request"] if isinstance(row["request"], dict) else {}
            trace = {
                "trace_id": row["job_id"],
                "description": request.get("description", "Job trace"),
                "environment_type": request.get("environment_type", "custom"),
                "tags": request.get("tags", []),
                "outcome_tier": row["outcome_tier"],
                "metrics": {
                    "duration_seconds": (
                        datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00")) -
                        datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
                    ).total_seconds() if row["updated_at"] and row["created_at"] else 0,
                },
                "test_results": {
                    "passed": 1 if row["outcome_tier"] in ("A", "B", "C") else 0,
                    "total": 1,
                },
                "input_spec": request,
            }
            traces.append(trace)

        return traces

    async def _filter_promoted_traces(
        self,
        traces: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Filter out traces that have already been promoted."""
        client = await self._get_postgres()

        trace_ids = [t["trace_id"] for t in traces]
        if not trace_ids:
            return traces

        # Check which trace IDs have been promoted
        placeholders = ", ".join(f"${i + 1}" for i in range(len(trace_ids)))
        rows = await client.fetch(
            f"""
            SELECT trace_id
            FROM auto_dataset_promotions
            WHERE trace_id IN ({placeholders})
            """,
            *trace_ids,
        )

        promoted_ids = {r["trace_id"] for r in rows}
        return [t for t in traces if t["trace_id"] not in promoted_ids]

    async def _mark_traces_promoted(
        self,
        traces: list[dict[str, Any]],
        cycle_id: str,
    ) -> None:
        """Mark traces as promoted to avoid re-processing."""
        if not traces or self.dry_run:
            return

        client = await self._get_postgres()
        query = """
            INSERT INTO auto_dataset_promotions (trace_id, cycle_id, promoted_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (trace_id) DO NOTHING
        """
        now = datetime.now(UTC).isoformat()
        rows = [(t["trace_id"], cycle_id, now) for t in traces]

        async with client.acquire() as conn:
            await conn.executemany(query, rows)

    async def _persist_report(self, report: PromotionCycleReport) -> None:
        """Persist promotion cycle report to PostgreSQL."""
        client = await self._get_postgres()
        await client.execute(
            """
            INSERT INTO auto_dataset_reports (
                cycle_id, started_at, completed_at, traces_collected,
                traces_scored, traces_promoted, traces_rejected,
                new_cases_added, dataset_id, dataset_version,
                errors, duration_ms
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (cycle_id) DO NOTHING
            """,
            report.cycle_id,
            report.started_at,
            report.completed_at,
            report.traces_collected,
            report.traces_scored,
            report.traces_promoted,
            report.traces_rejected,
            report.new_cases_added,
            report.dataset_id,
            report.dataset_version,
            json.dumps(report.errors),
            report.duration_ms,
        )

    # ── Background scheduling ────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the background promotion scheduler."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._schedule_loop())
        logger.info(
            f"AutoDatasetScheduler started (interval={self.interval_hours}h, "
            f"lookback={self.trace_lookback_hours}h)"
        )

    async def stop(self) -> None:
        """Stop the background scheduler."""
        self._running = False
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        logger.info("AutoDatasetScheduler stopped")

    async def _schedule_loop(self) -> None:
        """Background loop that runs promotion cycles on schedule."""
        while self._running:
            cycle_start = datetime.now(UTC)
            try:
                await self.run_promotion_cycle()
            except Exception as exc:
                logger.error(f"Scheduled promotion cycle failed: {exc}")

            # Maintain consistent interval regardless of processing time
            elapsed = (datetime.now(UTC) - cycle_start).total_seconds()
            sleep_seconds = max(0, self.interval_hours * 3600 - elapsed)
            jitter = random.uniform(0, 60)  # Up to 60s jitter to avoid thundering herd
            total_sleep = sleep_seconds + jitter
            logger.info(f"Next promotion cycle in {total_sleep / 3600:.2f} hours")

            # Use shorter sleeps to allow graceful shutdown
            slept = 0
            while self._running and slept < total_sleep:
                await asyncio.sleep(min(60, total_sleep - slept))
                slept += 60

    # ── Report retrieval ───────────────────────────────────────────────────

    async def get_recent_reports(
        self,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Get recent promotion cycle reports."""
        client = await self._get_postgres()
        rows = await client.fetch(
            """
            SELECT *
            FROM auto_dataset_reports
            ORDER BY started_at DESC
            LIMIT $1
            """,
            limit,
        )
        return [dict(r) for r in rows]

    async def get_dataset_growth(
        self,
        dataset_id: str | None = None,
        days: int = 30,
    ) -> list[dict[str, Any]]:
        """Get dataset growth metrics over time."""
        client = await self._get_postgres()
        target = dataset_id or self.target_dataset_id
        since = datetime.now(UTC) - timedelta(days=days)

        rows = await client.fetch(
            """
            SELECT
                DATE_TRUNC('day', started_at) as day,
                SUM(new_cases_added) as cases_added,
                COUNT(*) as cycles
            FROM auto_dataset_reports
            WHERE dataset_id = $1 AND started_at >= $2
            GROUP BY day
            ORDER BY day ASC
            """,
            target,
            since.isoformat(),
        )
        return [dict(r) for r in rows]


# ── Migration helpers for scheduler tables ─────────────────────────────────

async def create_scheduler_tables() -> None:
    """Create tables needed for the auto-dataset scheduler.

    Called during application startup if tables don't exist.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    await client.execute(
        """
        CREATE TABLE IF NOT EXISTS auto_dataset_promotions (
            trace_id TEXT PRIMARY KEY,
            cycle_id TEXT NOT NULL,
            promoted_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    await client.execute(
        """
        CREATE TABLE IF NOT EXISTS auto_dataset_reports (
            cycle_id TEXT PRIMARY KEY,
            started_at TIMESTAMPTZ NOT NULL,
            completed_at TIMESTAMPTZ,
            traces_collected INTEGER DEFAULT 0,
            traces_scored INTEGER DEFAULT 0,
            traces_promoted INTEGER DEFAULT 0,
            traces_rejected INTEGER DEFAULT 0,
            new_cases_added INTEGER DEFAULT 0,
            dataset_id TEXT NOT NULL,
            dataset_version TEXT,
            errors JSONB DEFAULT '[]',
            duration_ms FLOAT DEFAULT 0
        )
        """
    )
    await client.execute(
        """
        CREATE TABLE IF NOT EXISTS data_platform_alerts (
            alert_id TEXT PRIMARY KEY,
            alert_type TEXT NOT NULL,
            severity TEXT NOT NULL,
            table_name TEXT,
            metric TEXT NOT NULL,
            observed_value FLOAT NOT NULL,
            expected_min FLOAT,
            expected_max FLOAT,
            deviation_percent FLOAT DEFAULT 0,
            message TEXT NOT NULL,
            context JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    await client.execute(
        """
        CREATE TABLE IF NOT EXISTS data_platform_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    logger.info("Auto-dataset scheduler tables created")
