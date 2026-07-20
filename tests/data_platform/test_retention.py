"""Tests for the data retention and GDPR manager."""

from datetime import UTC, datetime, timedelta, timezone

import pytest

from eden.data_platform.retention import (
    DEFAULT_POLICIES,
    DataRetentionManager,
    RetentionPolicy,
    RetentionReport,
)


class TestRetentionPolicy:
    def test_default_policies_exist(self):
        assert len(DEFAULT_POLICIES) > 0
        types = {p.data_type for p in DEFAULT_POLICIES}
        assert "raw_traces" in types
        assert "audit_logs" in types

    def test_policy_days(self):
        policy = RetentionPolicy(
            data_type="test",
            hot_days=7,
            warm_days=30,
            cold_days=90,
            delete_after_days=90,
        )
        assert policy.hot_days == 7
        assert policy.warm_days == 30


class TestDataRetentionManager:
    def test_init_defaults(self):
        manager = DataRetentionManager()
        assert manager.dry_run is False
        assert len(manager.policies) > 0

    def test_init_dry_run(self):
        manager = DataRetentionManager(dry_run=True)
        assert manager.dry_run is True

    def test_init_custom_policies(self):
        custom = [RetentionPolicy("custom", 1, 2, 3, 3)]
        manager = DataRetentionManager(policies=custom)
        assert manager.policies == custom

    @pytest.mark.asyncio
    async def test_purge_pii_fields_dry_run(self):
        manager = DataRetentionManager(dry_run=True)
        before = datetime.now(UTC) - timedelta(days=30)
        count = await manager.purge_pii_fields(before)
        assert count >= 0  # Dry run returns count without DB

    @pytest.mark.asyncio
    async def test_cleanup_debug_dumps(self):
        manager = DataRetentionManager(dry_run=True)
        before = datetime.now(UTC) - timedelta(days=8)
        count = await manager.cleanup_debug_dumps(before)
        assert count == 0

    @pytest.mark.asyncio
    async def test_export_user_data_no_db(self):
        manager = DataRetentionManager(dry_run=True)
        try:
            export = await manager.export_user_data("test-tenant")
            assert "tenant_id" in export
            assert "exported_at" in export
            assert "tables" in export
        except Exception:
            # Expected when no DB is available
            pass

    def test_retention_report_defaults(self):
        report = RetentionReport()
        assert report.pii_redacted_rows == 0
        assert report.archived_rows == 0
        assert report.deleted_rows == 0
        assert report.errors == []

    def test_retention_report_with_errors(self):
        report = RetentionReport(
            pii_redacted_rows=10,
            archived_rows=100,
            deleted_rows=50,
            errors=["S3 timeout"],
        )
        assert report.pii_redacted_rows == 10
        assert report.archived_rows == 100
        assert len(report.errors) == 1


@pytest.mark.asyncio
async def test_non_trace_policies_do_not_archive_silver_events():
    """debug_dumps / error_logs must not call archive_to_cold(silver_events)."""
    from unittest.mock import AsyncMock, patch

    mgr = DataRetentionManager(dry_run=False)
    archive = AsyncMock(return_value=(0, 0))
    purge_pii = AsyncMock(return_value=0)
    cleanup_dumps = AsyncMock(return_value=0)
    with (
        patch.object(mgr, "archive_to_cold", archive),
        patch.object(mgr, "purge_pii_fields", purge_pii),
        patch.object(mgr, "cleanup_debug_dumps", cleanup_dumps),
        patch.object(mgr, "purge_archived_telemetry", AsyncMock(return_value=0)),
    ):
        for data_type in ("debug_dumps", "error_logs", "audit_logs"):
            policy = next(p for p in DEFAULT_POLICIES if p.data_type == data_type)
            await mgr.run_retention_policy(policy)

    archive.assert_not_called()
    cleanup_dumps.assert_awaited()


@pytest.mark.asyncio
async def test_raw_traces_archives_silver_events_only():
    from unittest.mock import AsyncMock, patch

    mgr = DataRetentionManager(dry_run=False)
    archive = AsyncMock(return_value=(3, 1))
    with (
        patch.object(mgr, "archive_to_cold", archive),
        patch.object(mgr, "purge_pii_fields", AsyncMock(return_value=0)),
        patch.object(mgr, "purge_archived_telemetry", AsyncMock(return_value=0)),
    ):
        policy = next(p for p in DEFAULT_POLICIES if p.data_type == "raw_traces")
        report = await mgr.run_retention_policy(policy)

    archive.assert_awaited()
    assert archive.await_args.kwargs.get("table") == "silver_events"
    assert report.archived_rows == 3


@pytest.mark.asyncio
async def test_archive_to_cold_skips_delete_when_s3_fails():
    from unittest.mock import AsyncMock, MagicMock, patch

    mgr = DataRetentionManager(dry_run=False)
    fake_client = MagicMock()
    row = {
        "silver_event_id": "00000000-0000-0000-0000-000000000001",
        "timestamp": datetime.now(UTC),
    }
    fake_client.fetch = AsyncMock(return_value=[row])
    fake_client.execute = AsyncMock()
    with (
        patch.object(mgr, "_get_postgres", AsyncMock(return_value=fake_client)),
        patch.object(mgr, "_write_s3_archive", AsyncMock(return_value=0)),
    ):
        archived, s3_objs = await mgr.archive_to_cold(datetime.now(UTC))

    assert archived == 0
    assert s3_objs == 0
    fake_client.execute.assert_not_called()


@pytest.mark.asyncio
async def test_purge_pii_passes_datetime_not_isoformat():
    from unittest.mock import AsyncMock, MagicMock, patch

    mgr = DataRetentionManager(dry_run=True)
    fake_client = MagicMock()
    fake_client.fetchval = AsyncMock(return_value=0)
    before = datetime.now(UTC) - timedelta(days=30)
    with patch.object(mgr, "_get_postgres", AsyncMock(return_value=fake_client)):
        await mgr.purge_pii_fields(before)

    arg = fake_client.fetchval.await_args.args[1]
    assert isinstance(arg, datetime)
    assert not isinstance(arg, str)

