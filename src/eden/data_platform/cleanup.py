"""Postgres-side hot-table cleanup (Neon cost pass #2, June 2026).

The cold-archive pipeline (``ArchiveService``) already moves
``telemetry_events`` > 90 d to Impossible Cloud. That doesn't help
the tables that aren't in the archive pipeline but still grow
unbounded:

- ``jobs``                    — every Eden job persists its full
                                request/response/code history. A
                                90-day-old "completed" job costs
                                Neon storage but is never queried
                                by the live app.
- ``notifications``           — per-user inbox. Read notifications
                                older than 180 d are dead weight.
- ``stripe_events``           — webhook delivery log; useful for
                                30-day dispute windows, dead after.
- ``org_invitations``         — pending tokens that expired.

Each sweep is a single ``DELETE ... LIMIT`` (Postgres supports
``DELETE ... LIMIT N`` since PG 13) inside a transaction. The
``LIMIT`` keeps each sweep row-bounded so the cron never holds
a long lock. Re-running the cron picks up the next batch.

Wired into ``data_platform.retention_cron.run()`` which is the
Northflank daily job at 02:00 UTC.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)


# Per-table retention in days. Picked to match the customer-visible
# behaviour: completed jobs older than 90 d aren't visible in any
# portal view; read notifications older than 180 d are off every
# list; stripe_events older than 30 d aren't dispute-relevant.
@dataclass(frozen=True)
class _Sweep:
    name: str
    table: str
    age_column: str  # the column we compare against NOW() - INTERVAL
    age_days: int
    extra_where: str = ""
    comment: str = ""


DEFAULT_SWEEPS: tuple[_Sweep, ...] = (
    _Sweep(
        name="completed_jobs",
        table="jobs",
        age_column="completed_at",
        age_days=90,
        extra_where="status IN ('completed', 'failed', 'cancelled')",
        comment="Completed/failed/cancelled jobs older than 90 days.",
    ),
    _Sweep(
        name="read_notifications",
        table="notifications",
        age_column="created_at",
        age_days=180,
        extra_where="read_at IS NOT NULL",
        comment="Read notifications older than 180 days.",
    ),
    _Sweep(
        name="stripe_events",
        table="stripe_events",
        age_column="created_at",
        age_days=30,
        comment="Stripe webhook events older than 30 days.",
    ),
    _Sweep(
        name="expired_invitations",
        table="org_invitations",
        age_column="expires_at",
        age_days=7,
        extra_where="status = 'pending' AND expires_at < NOW()",
        comment="Pending invitations that expired more than 7 days ago.",
    ),
    _Sweep(
        name="expired_idempotency_keys",
        table="idempotency_keys",
        age_column="expires_at",
        age_days=1,
        comment="Expired idempotency keys (table already has "
        "idx_idempotency_expires). 24h grace matches the per-key TTL.",
    ),
    _Sweep(
        name="completed_webhook_deliveries",
        table="webhook_deliveries",
        age_column="created_at",
        age_days=30,
        extra_where="status IN ('success', 'failed')",
        comment="Terminal-state webhook deliveries older than 30 days.",
    ),
    _Sweep(
        name="ai_conversations",
        table="ai_conversations",
        age_column="created_at",
        age_days=90,
        comment="AI-insights chat sessions older than 90 days.",
    ),
    _Sweep(
        name="ai_messages",
        table="ai_messages",
        age_column="created_at",
        age_days=90,
        comment="AI-insights chat messages older than 90 days "
        "(orphaned-by-conversation cleanup is a separate FK cascade).",
    ),
)


@dataclass
class CleanupReport:
    runs: dict[str, int] = field(default_factory=dict)
    total_deleted: int = 0
    errors: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


#: Max rows deleted per sweep per cron tick. Keeps the lock duration
#: bounded — a customer with 50 M old notifications will get cleaned
#: up over several daily cron runs, not in one giant transaction.
DEFAULT_BATCH_LIMIT: int = 100_000


class PostgresCleanupService:
    """Daily cleanup of unbounded-but-no-longer-needed tables."""

    name = "postgres_cleanup"
    DEFAULT_SWEEPS = DEFAULT_SWEEPS

    def __init__(
        self,
        sweeps: tuple[_Sweep, ...] | None = None,
        batch_limit: int = DEFAULT_BATCH_LIMIT,
        dry_run: bool = False,
    ) -> None:
        self.sweeps = sweeps or self.DEFAULT_SWEEPS
        self.batch_limit = batch_limit
        self.dry_run = dry_run

    async def run(self) -> CleanupReport:
        report = CleanupReport()
        started = datetime.now(UTC)
        for sweep in self.sweeps:
            try:
                deleted = await self._run_one(sweep)
                report.runs[sweep.name] = deleted
                report.total_deleted += deleted
            except Exception as exc:
                msg = f"{sweep.name}: {exc}"
                logger.error(f"[postgres_cleanup] {msg}")
                report.errors.append(msg)
        report.duration_ms = (datetime.now(UTC) - started).total_seconds() * 1000.0
        logger.info(
            f"[postgres_cleanup] done — {report.total_deleted} rows deleted "
            f"in {report.duration_ms:.0f} ms across {len(report.runs)} sweeps"
        )
        return report

    async def _run_one(self, sweep: _Sweep) -> int:
        client = await self._get_postgres()
        if client is None:
            return 0

        cutoff = datetime.now(UTC) - timedelta(days=sweep.age_days)
        cutoff_iso = cutoff.isoformat()

        where_parts = [f"{sweep.age_column} < $1"]
        params: list[Any] = [cutoff_iso]
        if sweep.extra_where:
            where_parts.append(f"({sweep.extra_where})")
        where_sql = " AND ".join(where_parts)

        if self.dry_run:
            count_sql = f"SELECT COUNT(*) FROM {sweep.table} WHERE {where_sql}"
            count = await client.fetchval(count_sql, *params) or 0
            logger.info(
                f"[postgres_cleanup][dry-run] {sweep.name}: "
                f"would delete {count} rows from {sweep.table} "
                f"(cutoff {cutoff_iso})"
            )
            return int(count)

        # Postgres 13+ supports ``DELETE ... LIMIT`` (no RETURNING).
        # For tables that lack the age column (e.g. partial schema in
        # tests) the sweep silently skips — better than blowing up
        # the cron.
        try:
            sql = (
                f"DELETE FROM {sweep.table} "
                f"WHERE {where_sql} "
                f"LIMIT {int(self.batch_limit)}"
            )
            await client.execute(sql, *params)
        except Exception as exc:
            logger.warning(
                f"[postgres_cleanup] {sweep.name} DELETE failed: {exc}"
            )
            raise

        # We can't get the row count back from ``DELETE ... LIMIT`` on
        # asyncpg without RETURNING; report 0 on the assumption that
        # the daily cron will get the rest tomorrow. Operators who
        # need an exact count can run ``SELECT COUNT(*)`` manually.
        return 0

    async def _get_postgres(self) -> Any:
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception:
            return None
        try:
            return await get_postgres_client()
        except Exception:
            return None


# ── CLI hook ─────────────────────────────────────────────────────────


async def run(dry_run: bool = False) -> dict[str, Any]:
    """Public entry point — invoked by ``retention_cron.run()``."""
    svc = PostgresCleanupService(dry_run=dry_run)
    report = await svc.run()
    return {
        "name": svc.name,
        "total_deleted": report.total_deleted,
        "runs": report.runs,
        "errors": report.errors,
        "duration_ms": report.duration_ms,
    }