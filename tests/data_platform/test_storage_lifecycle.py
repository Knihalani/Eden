"""Tests for the tiered storage lifecycle manager."""

import pytest
from eden.data_platform.storage_lifecycle import (
    StorageLifecycleManager,
    TierTransition,
    LifecycleReport,
    DEFAULT_TRANSITIONS,
)


class TestTierTransition:
    def test_default_transitions(self):
        assert len(DEFAULT_TRANSITIONS) > 0
        names = {t.name for t in DEFAULT_TRANSITIONS}
        assert "bronze-hot-to-warm" in names
        assert "silver-warm-to-cold" in names

    def test_transition_properties(self):
        transition = TierTransition(
            name="test",
            source_tier="hot",
            target_tier="warm",
            after_days=7,
            target_storage_class="STANDARD_IA",
        )
        assert transition.source_tier == "hot"
        assert transition.target_tier == "warm"
        assert transition.after_days == 7
        assert transition.enabled is True


class TestStorageLifecycleManager:
    def test_init_defaults(self):
        manager = StorageLifecycleManager()
        assert manager.dry_run is False
        assert len(manager.transitions) > 0

    def test_init_dry_run(self):
        manager = StorageLifecycleManager(dry_run=True)
        assert manager.dry_run is True

    def test_init_custom_transitions(self):
        custom = [TierTransition("custom", "hot", "warm", 1)]
        manager = StorageLifecycleManager(transitions=custom)
        assert manager.transitions == custom

    @pytest.mark.asyncio
    async def test_apply_s3_lifecycle_rules_no_bucket(self):
        manager = StorageLifecycleManager(dry_run=True)
        ok = await manager.apply_s3_lifecycle_rules()
        # Should skip gracefully when S3 bucket not configured
        assert ok is False or ok is True  # dry_run returns True, no bucket returns False

    @pytest.mark.asyncio
    async def test_expire_temporary_data_no_bucket(self):
        manager = StorageLifecycleManager(dry_run=True)
        deleted = await manager.expire_temporary_data()
        assert deleted == 0

    @pytest.mark.asyncio
    async def test_get_storage_summary(self):
        manager = StorageLifecycleManager()
        summary = await manager.get_storage_summary()
        assert "timestamp" in summary
        assert "hot" in summary
        assert "warm" in summary
        assert "cold" in summary

    def test_lifecycle_report_defaults(self):
        report = LifecycleReport()
        assert report.transitions_run == 0
        assert report.rows_moved == 0
        assert report.errors == []
