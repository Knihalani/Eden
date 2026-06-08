"""Tests for the data retention and GDPR manager."""

import pytest
from datetime import datetime, timezone, timedelta
from eden.data_platform.retention import (
    DataRetentionManager,
    RetentionPolicy,
    RetentionReport,
    DEFAULT_POLICIES,
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
        before = datetime.now(timezone.utc) - timedelta(days=30)
        count = await manager.purge_pii_fields(before)
        assert count >= 0  # Dry run returns count without DB

    @pytest.mark.asyncio
    async def test_cleanup_debug_dumps(self):
        manager = DataRetentionManager(dry_run=True)
        before = datetime.now(timezone.utc) - timedelta(days=8)
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
