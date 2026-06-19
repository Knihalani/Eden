"""Postgres native partition manager (Phase B5).

:class:`PartitionManager` — ensures that ``usage_events`` (and
any other natively-partitioned Eden tables) have forward-looking
partitions and drop expired ones. Called by the daily retention
cron.

Why a manager, not pg_partman
----------------------------
- pg_partman is a Postgres extension; Eden runs on managed
  Neon (no superuser, no extension installs).
- The partition strategy is small (one table, monthly chunks,
  forward + drop) and benefits from being in-code where the rest
  of the retention logic lives.

Usage::

    pm = PartitionManager(retention_months=24, forward_months=3)
    result = await pm.run()
    # {"partitions_created": 1, "partitions_dropped": 0, "errors": []}
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)


#: Default partition retention in months. Per-tenant overrides
#: layer on top via ``org_retention_policies``. 24 months matches
#: the billing default (typical SaaS contract = 24-month lookback).
DEFAULT_RETENTION_MONTHS: int = 24


#: Default forward-partition count. The manager creates the next
#: N monthly partitions on every cron run so writes never land in
#: the default partition (which is unindexed for time-range scans).
DEFAULT_FORWARD_MONTHS: int = 3


# Tables under management. Each entry: (table, time_column).
# ``usage_events`` is the only natively-partitioned time-series
# table left after Phase B5 (telemetry_events + judge_scores are
# Timescale hypertables; app_events was already partitioned in
# migration 036).
MANAGED_TABLES: list[tuple[str, str]] = [
    ("usage_events", "created_at"),
]


class PartitionManager:
    """Create forward + drop expired Postgres native partitions.

    Idempotent — re-running the same hour produces no changes
    (the SQL is ``CREATE TABLE IF NOT EXISTS``).
    """

    name = "partition_manager"

    def __init__(
        self,
        *,
        retention_months: int = 24,
        forward_months: int = 3,
        tables: list[tuple[str, str]] | None = None,
        dry_run: bool = False,
    ) -> None:
        self.retention_months = retention_months
        self.forward_months = forward_months
        self.tables = tables or MANAGED_TABLES
        self.dry_run = dry_run

    async def run(self) -> dict[str, Any]:
        """Create forward + drop expired partitions. Returns a summary."""
        results: dict[str, Any] = {
            "partitions_created": 0,
            "partitions_dropped": 0,
            "errors": [],
        }
        for table, time_column in self.tables:
            try:
                created = await self._create_forward(table, time_column)
                dropped = await self._drop_expired(table, time_column)
                results["partitions_created"] += created
                results["partitions_dropped"] += dropped
            except Exception as exc:
                logger.error(f"partition_manager: {table} failed: {exc}")
                results["errors"].append(f"{table}: {exc}")
        return results

    async def _create_forward(self, table: str, time_column: str) -> int:
        """Create the next ``forward_months`` partitions.

        Returns the number of partitions created (0 if all already
        exist).
        """
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception:
            return 0

        client = await get_postgres_client()
        if client is None:
            return 0

        now = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        created = 0
        for offset in range(1, self.forward_months + 1):
            month_start = _add_months(now, offset)
            partition_name = f"{table}_{month_start.strftime('%Y_%m')}"
            next_month = _add_months(month_start, 1)
            sql = (
                f"CREATE TABLE IF NOT EXISTS {partition_name} "
                f"PARTITION OF {table} "
                f"FOR VALUES FROM ('{month_start.isoformat()}') "
                f"TO ('{next_month.isoformat()}');"
            )
            if self.dry_run:
                logger.info(f"[dry-run] {sql}")
                continue
            try:
                await client.execute(sql)
                created += 1
                logger.info(f"partition_manager: created {partition_name}")
            except Exception as exc:
                # Already exists (race with another cron instance)
                # is logged at DEBUG; other errors are warnings.
                if "already exists" in str(exc).lower():
                    logger.debug(f"{partition_name} already exists")
                else:
                    logger.warning(
                        f"partition_manager: failed to create {partition_name}: {exc}"
                    )
        return created

    async def _drop_expired(self, table: str, time_column: str) -> int:
        """Drop partitions whose max value is older than
        ``retention_months`` from now.

        Returns the number of partitions dropped.
        """
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception:
            return 0

        client = await get_postgres_client()
        if client is None:
            return 0

        cutoff = _add_months(
            datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0),
            -self.retention_months,
        )
        cutoff_iso = cutoff.isoformat()

        # Discover existing partitions for this table.
        rows = await client.fetch(
            """
            SELECT inhrelid::regclass::text AS partition_name
              FROM pg_inherits
             WHERE inhparent = $1::regclass
            """,
            table,
        )
        dropped = 0
        for row in rows:
            name = row["partition_name"]
            # Skip the default partition — always present, never drops.
            if name.endswith("_default"):
                continue
            # Parse the year_month suffix.
            suffix = name.rsplit("_", 2)[-2:]
            try:
                year = int(suffix[0])
                month = int(suffix[1])
                partition_start = datetime(year, month, 1, tzinfo=UTC)
            except (ValueError, IndexError):
                logger.debug(f"skipping non-monthly partition: {name}")
                continue
            if partition_start >= cutoff:
                continue
            if self.dry_run:
                logger.info(f"[dry-run] DROP TABLE {name}")
                continue
            try:
                await client.execute(f"DROP TABLE {name}")
                dropped += 1
                logger.info(f"partition_manager: dropped {name}")
            except Exception as exc:
                logger.warning(
                    f"partition_manager: failed to drop {name}: {exc}"
                )
        return dropped


def _add_months(dt: datetime, months: int) -> datetime:
    """Add (or subtract) ``months`` from ``dt``, clamping the day
    of the result to the last valid day of the target month.
    """
    year = dt.year + (dt.month - 1 + months) // 12
    month = (dt.month - 1 + months) % 12 + 1
    # Clamp to the last day of the target month.
    if month == 12:
        next_month_first = datetime(year + 1, 1, 1, tzinfo=UTC)
    else:
        next_month_first = datetime(year, month + 1, 1, tzinfo=UTC)
    last_day = (next_month_first - timedelta(days=1)).day
    day = min(dt.day, last_day)
    return datetime(year, month, day, tzinfo=UTC)
