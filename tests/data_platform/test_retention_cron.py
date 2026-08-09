"""Unit tests for the daily retention cron.

Phase B1 of the Eden app/storage plan (2026-06-19). Verifies the
orchestration: retention policies run, lifecycle rules apply,
temporary-data sweep runs. Mocked at the manager boundary so no
live Postgres / S3 needed.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.data_platform.retention_cron import run


class TestRetentionCronRun:
    @pytest.mark.asyncio
    async def test_run_dry_run_returns_dict(self):
        results = await run(dry_run=True)
        assert isinstance(results, dict)
        # Each default policy name is present
        expected_policies = {
            "raw_traces",
            "user_feedback",
            "agent_audit_ledger",
            "debug_dumps",
            "quarantine_events",
            "checkpoint_blobs",
            "trace_replay_sessions",
            "replay_sessions",
        }
        assert expected_policies.issubset(results.keys())
        # Lifecycle rules and sweep
        assert "lifecycle_rules_applied" in results
        assert "expired_objects" in results

    @pytest.mark.asyncio
    async def test_run_no_dry_run_no_exceptions(self):
        """Default execution path runs cleanly with mocks."""
        with (
            patch(
                "eden.data_platform.retention.DataRetentionManager.run_retention_policy",
                new=AsyncMock(return_value=MagicMock(errors=[])),
            ),
            patch(
                "eden.data_platform.storage_lifecycle.StorageLifecycleManager.apply_s3_lifecycle_rules",
                new=AsyncMock(return_value=True),
            ),
            patch(
                "eden.data_platform.storage_lifecycle.StorageLifecycleManager.expire_temporary_data",
                new=AsyncMock(return_value=0),
            ),
        ):
            results = await run(dry_run=False)
        assert results["lifecycle_rules_applied"] is True
        assert results["expired_objects"] == 0

    @pytest.mark.asyncio
    async def test_run_swallows_per_policy_errors(self):
        """A failing policy does not abort the whole run."""
        from eden.data_platform.retention import RetentionReport

        with (
            patch(
                "eden.data_platform.retention.DataRetentionManager.run_retention_policy",
                new=AsyncMock(side_effect=RuntimeError("boom")),
            ),
            patch(
                "eden.data_platform.storage_lifecycle.StorageLifecycleManager.apply_s3_lifecycle_rules",
                new=AsyncMock(return_value=True),
            ),
            patch(
                "eden.data_platform.storage_lifecycle.StorageLifecycleManager.expire_temporary_data",
                new=AsyncMock(return_value=0),
            ),
        ):
            results = await run(dry_run=False)
        # Every policy should have an error recorded, not raise
        for key in (
            "raw_traces",
            "user_feedback",
            "agent_audit_ledger",
            "debug_dumps",
            "quarantine_events",
            "checkpoint_blobs",
        ):
            assert "errors" in results[key]
            assert "boom" in results[key]["errors"][0]
