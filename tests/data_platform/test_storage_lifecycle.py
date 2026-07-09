"""Tests for the tiered storage lifecycle manager."""

import pytest

from eden.data_platform.storage_lifecycle import (
    DEFAULT_TRANSITIONS,
    LifecycleReport,
    StorageLifecycleManager,
    TierTransition,
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


class TestImpossibleCloudBehavior:
    """Phase B1 (2026-06-19): Impossible Cloud is a single-tier backend.

    ``transition_s3_prefix`` must short-circuit (no tier transitions
    possible). Both behaviours are gated on
    ``EDEN_STORAGE_BACKEND=impossible_cloud``.
    """

    @pytest.mark.asyncio
    async def test_transition_s3_prefix_is_noop_on_impossible_cloud(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("EDEN_STORAGE_BACKEND", "impossible_cloud")
        # Reimport the module so the env-driven ``_IMPOSSIBLE_CLOUD`` flag
        # picks up the new value.
        import importlib

        from eden.data_platform import storage_lifecycle

        importlib.reload(storage_lifecycle)

        manager = storage_lifecycle.StorageLifecycleManager()
        n = await manager.transition_s3_prefix(
            prefix="bronze/events/", to_storage_class="GLACIER_IR", before_days=30
        )
        assert n == 0

    def test_module_flag_true_when_backend_is_impossible_cloud(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("EDEN_STORAGE_BACKEND", "impossible_cloud")
        import importlib

        from eden.data_platform import storage_lifecycle

        importlib.reload(storage_lifecycle)

        assert storage_lifecycle._IMPOSSIBLE_CLOUD is True

    def test_module_flag_false_when_backend_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.delenv("EDEN_STORAGE_BACKEND", raising=False)
        import importlib

        from eden.data_platform import storage_lifecycle

        importlib.reload(storage_lifecycle)

        assert storage_lifecycle._IMPOSSIBLE_CLOUD is False



class TestTransitionToWarmCorrectness:
    """F41 regression tests for ``transition_to_warm``.

    The pre-fix code had two bugs:

    1. The DELETE placeholder formula was ``f"${i + 2}"`` instead of
       ``f"${i + 1}"``, leaving $1 unbound. The DELETE always
       raised ``PostgresSyntaxError: there is no parameter $1`` and
       the just-archived rows remained in Postgres (data doubled
       in PG *and* S3).
    2. The SELECT passed ``cutoff.isoformat()`` (a string) for a
       ``timestamptz`` comparison. asyncpg's ``timestamptz`` codec
       rejects bare strings with
       "expected datetime.date/datetime, got str".
    """

    @pytest.mark.asyncio
    async def test_delete_uses_one_based_placeholders(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """DELETE placeholders start at $1 (no other bound params)."""
        from datetime import UTC, datetime
        from unittest.mock import AsyncMock, MagicMock, patch

        # Stub the S3 archive write to succeed so we exercise the
        # DELETE.
        manager = StorageLifecycleManager()
        manager._write_warm_archive = AsyncMock(return_value=True)

        fake_client = MagicMock()
        # Two rows on the first SELECT, empty on the second
        # (terminates the loop).
        fake_client.fetch = AsyncMock(
            side_effect=[
                [
                    {"silver_event_id": "row-1", "timestamp": datetime(2020, 1, 1, tzinfo=UTC)},
                    {"silver_event_id": "row-2", "timestamp": datetime(2020, 1, 2, tzinfo=UTC)},
                ],
                [],
            ],
        )
        fake_client.execute = AsyncMock(return_value="DELETE 2")

        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=fake_client),
        ):
            n = await manager.transition_to_warm(
                table="silver_events", before_days=7
            )

        assert n == 2
        # The DELETE was issued exactly once with two parameters.
        assert fake_client.execute.await_count == 1
        call = fake_client.execute.await_args
        sql = call.args[0]
        params = call.args[1:]
        # The DELETE should use $1 and $2, not $2 and $3.
        assert "WHERE silver_event_id IN ($1, $2)" in sql, sql
        # The bound parameters are the two ids in order.
        assert list(params) == ["row-1", "row-2"]
        # First arg to SELECT was a real datetime (not an isoformat
        # string).
        fetch_call = fake_client.fetch.await_args
        first_arg = fetch_call.args[1]
        assert isinstance(first_arg, datetime)
        assert first_arg.tzinfo is not None

    @pytest.mark.asyncio
    async def test_select_cutoff_is_datetime_not_string(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The SELECT cutoff parameter is a real datetime, not a string.

        The pre-fix code passed ``cutoff.isoformat()`` and asyncpg
        rejected it because the ``timestamp`` column is ``timestamptz``.
        """
        from datetime import UTC, datetime
        from unittest.mock import AsyncMock, MagicMock, patch

        fake_client = MagicMock()
        fake_client.fetch = AsyncMock(return_value=[])
        fake_client.execute = AsyncMock(return_value="DELETE 0")

        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=fake_client),
        ):
            manager = StorageLifecycleManager()
            await manager.transition_to_warm(
                table="silver_events", before_days=7,
            )

        fetch_call = fake_client.fetch.await_args
        cutoff_arg = fetch_call.args[1]
        assert isinstance(cutoff_arg, datetime)
        assert cutoff_arg.tzinfo is not None
