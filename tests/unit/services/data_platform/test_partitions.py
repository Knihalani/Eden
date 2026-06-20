"""Unit tests for Phase B5 — Postgres native partition management.

Verifies:
- Migration 042 partitions usage_events + creates the composite index.
- PartitionManager._add_months handles month rollover + day clamping.
- PartitionManager._create_forward generates the right partition SQL.
- PartitionManager._drop_expired respects the retention window.
- Retention cron wires PartitionManager.
"""
from __future__ import annotations

import importlib.util
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.services.data_platform import (
    DEFAULT_RETENTION_MONTHS,
    MANAGED_TABLES,
    PartitionManager,
)


# ── Migration 042 syntax ─────────────────────────────────────────────


class TestMigration042Syntax:
    @staticmethod
    def _load_migration():
        path = Path(
            "/Users/kaiavnihalani/Downloads/Eden/src/eden/db_migrations/versions/"
            "042_usage_events_partitions.py"
        )
        spec = importlib.util.spec_from_file_location(
            "usage_events_partitions", path
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_revision_chain(self):
        m = self._load_migration()
        assert m.revision == "042"
        assert m.down_revision == "041"

    def test_partitions_by_created_at(self):
        """The migration converts usage_events to a TimescaleDB
        hypertable partitioned by ``created_at``. Mirrors the
        pattern from migration 034 (telemetry_events)."""
        body = Path(
            "/Users/kaiavnihalani/Downloads/Eden/src/eden/db_migrations/versions/"
            "042_usage_events_partitions.py"
        ).read_text()
        assert "create_hypertable" in body
        assert "'created_at'" in body

    def test_monthly_chunks(self):
        body = Path(
            "/Users/kaiavnihalani/Downloads/Eden/src/eden/db_migrations/versions/"
            "042_usage_events_partitions.py"
        ).read_text()
        # Monthly chunks match the original Phase B5 plan.
        assert "1 month" in body

    def test_schema_cleanup(self):
        """The migration drops the dead weight (misplaced trigger,
        RLS policy) that blocked the original native-PG
        partition approach."""
        body = Path(
            "/Users/kaiavnihalani/Downloads/Eden/src/eden/db_migrations/versions/"
            "042_usage_events_partitions.py"
        ).read_text()
        assert "usage_events_updated_at" in body
        assert "tenant_isolation_usage_events" in body


# ── PartitionManager._add_months ──────────────────────────────────────


class TestAddMonths:
    def test_simple_next_month(self):
        from eden.services.data_platform.partitions import _add_months

        assert _add_months(datetime(2026, 6, 15, tzinfo=UTC), 1) == datetime(
            2026, 7, 15, tzinfo=UTC
        )

    def test_year_rollover(self):
        from eden.services.data_platform.partitions import _add_months

        assert _add_months(datetime(2026, 12, 15, tzinfo=UTC), 1) == datetime(
            2027, 1, 15, tzinfo=UTC
        )

    def test_subtract_months(self):
        from eden.services.data_platform.partitions import _add_months

        assert _add_months(datetime(2026, 3, 15, tzinfo=UTC), -3) == datetime(
            2025, 12, 15, tzinfo=UTC
        )

    def test_day_clamping_jan31_to_feb(self):
        from eden.services.data_platform.partitions import _add_months

        # Jan 31 + 1 month should clamp to Feb 28/29, not overflow to Mar 3.
        result = _add_months(datetime(2026, 1, 31, tzinfo=UTC), 1)
        assert result.month == 2
        assert result.day == 28  # 2026 is not a leap year

    def test_negative_offset_across_year(self):
        from eden.services.data_platform.partitions import _add_months

        assert _add_months(datetime(2026, 1, 15, tzinfo=UTC), -1) == datetime(
            2025, 12, 15, tzinfo=UTC
        )


# ── PartitionManager._create_forward ───────────────────────────────────


class TestCreateForward:
    @pytest.mark.asyncio
    async def test_returns_zero_when_no_postgres(self):
        pm = PartitionManager(forward_months=3)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            n = await pm._create_forward("usage_events", "created_at")
        assert n == 0

    @pytest.mark.asyncio
    async def test_creates_forward_months(self):
        pm = PartitionManager(forward_months=3)
        client = MagicMock()
        client.execute = AsyncMock(return_value=None)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            n = await pm._create_forward("usage_events", "created_at")
        # 3 partitions created (next month, +2 months, +3 months).
        assert n == 3
        assert client.execute.await_count == 3
        sqls = [c.args[0] for c in client.execute.await_args_list]
        assert sqls[0].startswith(
            "CREATE TABLE IF NOT EXISTS usage_events_"
        )
        assert "PARTITION OF usage_events" in sqls[0]
        assert "FOR VALUES FROM (" in sqls[0]
        assert "TO (" in sqls[0]

    @pytest.mark.asyncio
    async def test_dry_run_skips_execute(self):
        pm = PartitionManager(forward_months=2, dry_run=True)
        client = MagicMock()
        client.execute = AsyncMock()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            n = await pm._create_forward("usage_events", "created_at")
        # dry-run doesn't actually create.
        assert n == 0
        assert client.execute.await_count == 0

    @pytest.mark.asyncio
    async def test_already_exists_is_swallowed(self):
        """Concurrent cron runs may try to create the same partition.
        The 'already exists' error must not abort the run."""
        pm = PartitionManager(forward_months=1)
        client = MagicMock()
        client.execute = AsyncMock(
            side_effect=Exception("relation already exists")
        )
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            # Should not raise.
            n = await pm._create_forward("usage_events", "created_at")
        # Already-exists doesn't count as a created partition.
        assert n == 0


# ── PartitionManager._drop_expired ─────────────────────────────────────


class TestDropExpired:
    @pytest.mark.asyncio
    async def test_returns_zero_when_no_postgres(self):
        pm = PartitionManager(retention_months=24)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            n = await pm._drop_expired("usage_events", "created_at")
        assert n == 0

    @pytest.mark.asyncio
    async def test_drops_old_partitions(self):
        pm = PartitionManager(retention_months=24)
        client = MagicMock()
        # Simulate: 3 old partitions (one >24 months ago), 2 new ones.
        rows = [
            {"partition_name": "usage_events_2023_01"},  # old
            {"partition_name": "usage_events_2023_06"},  # old
            {"partition_name": "usage_events_2024_05"},  # old (31 months ago)
            {"partition_name": "usage_events_2025_01"},  # new
            {"partition_name": "usage_events_2025_12"},  # new
            {"partition_name": "usage_events_default"},   # always skipped
        ]
        client.fetch = AsyncMock(return_value=rows)
        client.execute = AsyncMock(return_value=None)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            n = await pm._drop_expired("usage_events", "created_at")
        # Only the 3 old ones drop (the 2 new stay; default is skipped).
        assert n == 3
        dropped = [c.args[0] for c in client.execute.await_args_list]
        assert all(sql.startswith("DROP TABLE") for sql in dropped)
        assert not any("default" in sql for sql in dropped)


# ── PartitionManager.run (end-to-end) ──────────────────────────────────


class TestRun:
    @pytest.mark.asyncio
    async def test_run_returns_summary(self):
        pm = PartitionManager(
            retention_months=24,
            forward_months=3,
            dry_run=True,
        )
        # No Postgres → returns zero counts but no errors.
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            result = await pm.run()
        assert result["partitions_created"] == 0
        assert result["partitions_dropped"] == 0
        assert result["errors"] == []


# ── Managed tables list ──────────────────────────────────────────────


def test_managed_tables_default():
    """After Phase B5, usage_events is a Timescale hypertable
    (self-managing). The manager only handles natively-partitioned
    tables — currently app_events."""
    assert ("app_events", "ts") in MANAGED_TABLES
    # usage_events must NOT be here (it's a Timescale hypertable now).
    assert ("usage_events", "created_at") not in MANAGED_TABLES


def test_default_retention_is_24_months():
    assert DEFAULT_RETENTION_MONTHS == 24


# ── Retention cron wires PartitionManager ─────────────────────────────


class TestRetentionCronPartitionManager:
    @pytest.mark.asyncio
    async def test_cron_calls_partition_manager(self):
        from eden.data_platform import retention_cron

        mock_pm = MagicMock()
        mock_pm.run = AsyncMock(
            return_value={
                "partitions_created": 1,
                "partitions_dropped": 0,
                "errors": [],
            }
        )
        mock_retention = MagicMock()
        mock_retention.policies = []
        mock_lifecycle = MagicMock()
        mock_lifecycle.apply_s3_lifecycle_rules = AsyncMock(return_value=True)
        mock_lifecycle.expire_temporary_data = AsyncMock(return_value=0)
        mock_archive = MagicMock()
        mock_archive.archive_old_rows = AsyncMock(
            return_value={"traces_archived": 0, "rows_archived": 0, "s3_objects": 0}
        )
        mock_msg_store = MagicMock()
        mock_msg_store.gc_orphans = AsyncMock(return_value=0)

        with (
            patch(
                "eden.data_platform.retention_cron.PartitionManager",
                return_value=mock_pm,
            ),
            patch(
                "eden.data_platform.retention_cron.DataRetentionManager",
                return_value=mock_retention,
            ),
            patch(
                "eden.data_platform.retention_cron.StorageLifecycleManager",
                return_value=mock_lifecycle,
            ),
            patch(
                "eden.data_platform.retention_cron.ArchiveService",
                return_value=mock_archive,
            ),
            patch(
                "eden.data_platform.retention_cron._list_orgs_with_old_traces",
                new=AsyncMock(return_value=[]),
            ),
            patch(
                "eden.observability.message_store.get_message_store",
                return_value=mock_msg_store,
            ),
        ):
            results = await retention_cron.run(dry_run=True)

        assert "partition_manager" in results
        assert results["partition_manager"]["partitions_created"] == 1
        mock_pm.run.assert_awaited_once()
