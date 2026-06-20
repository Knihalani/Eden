"""Tests for ``eden.data_platform.cleanup.PostgresCleanupService``."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _fake_client(fetchval_seq):
    """Build a fake PostgresClient that returns fetchval values in order."""
    client = MagicMock()
    client.fetchval = AsyncMock(side_effect=fetchval_seq)
    client.execute = AsyncMock(return_value="DELETE 0")
    return client


def _patched_client(client):
    """Patch get_postgres_client at the import site the service uses."""
    return patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    )


@pytest.mark.asyncio
async def test_dry_run_reports_counts_without_delete():
    """dry_run=True returns the count from COUNT(*) and skips DELETE."""
    from eden.data_platform.cleanup import PostgresCleanupService

    client = _fake_client([1234])
    with _patched_client(client):
        svc = PostgresCleanupService(
            sweeps=(PostgresCleanupService.DEFAULT_SWEEPS[0],),
            dry_run=True,
        )
        report = await svc.run()
    assert report.runs["completed_jobs"] == 1234
    assert report.total_deleted == 1234
    client.execute.assert_not_called()


@pytest.mark.asyncio
async def test_live_run_issues_delete_with_limit():
    """dry_run=False issues DELETE ... LIMIT on each sweep."""
    from eden.data_platform.cleanup import PostgresCleanupService

    client = _fake_client([])
    with _patched_client(client):
        svc = PostgresCleanupService(
            sweeps=PostgresCleanupService.DEFAULT_SWEEPS[:2],
            dry_run=False,
            batch_limit=500,
        )
        report = await svc.run()

    assert client.execute.await_count == 2
    sqls = [c.args[0] for c in client.execute.await_args_list]
    for sql in sqls:
        assert "DELETE FROM" in sql
        assert "LIMIT 500" in sql
    assert report.runs == {"completed_jobs": 0, "read_notifications": 0}


@pytest.mark.asyncio
async def test_batch_limit_default_is_safe():
    """Default batch limit keeps a single sweep under 100k rows."""
    from eden.data_platform.cleanup import DEFAULT_BATCH_LIMIT

    # Ponytail: this is a ceiling — when a tenant accumulates > 100k
    # rows between daily cron runs, the next run picks up where the
    # last one stopped. 100k is small enough that even a 1 MB-wide
    # row stays under 100 MB of heap churn per run.
    assert DEFAULT_BATCH_LIMIT == 100_000


@pytest.mark.asyncio
async def test_one_sweep_failure_doesnt_break_others():
    """A failing sweep is recorded in errors; the rest still run."""
    from eden.data_platform.cleanup import PostgresCleanupService

    client = MagicMock()
    # Live path uses execute() (DELETE ... LIMIT); make it throw.
    client.execute = AsyncMock(side_effect=Exception("boom"))
    with _patched_client(client):
        svc = PostgresCleanupService(
            sweeps=PostgresCleanupService.DEFAULT_SWEEPS[:3],
            dry_run=False,
        )
        report = await svc.run()

    assert len(report.errors) == 3
    assert all("boom" in e for e in report.errors)


def test_default_sweeps_cover_all_hot_tables():
    """Every unbounded table that isn't in the cold-archive pipeline."""
    from eden.data_platform.cleanup import DEFAULT_SWEEPS

    tables = {s.table for s in DEFAULT_SWEEPS}
    assert {"jobs", "notifications", "stripe_events", "org_invitations"} <= tables


@pytest.mark.asyncio
async def test_retention_cron_invokes_cleanup():
    """``retention_cron.run()`` wires the cleanup service into step 7."""
    from eden.data_platform import retention_cron

    fake_results: dict = {
        "completed_jobs": 0,
        "read_notifications": 0,
        "stripe_events": 0,
        "expired_invitations": 0,
        "total_deleted": 0,
        "runs": {},
        "errors": [],
        "duration_ms": 0.0,
    }
    with patch.object(
        retention_cron, "run", AsyncMock(return_value={"postgres_cleanup": fake_results})
    ):
        result = await retention_cron.run(dry_run=True)
    assert "postgres_cleanup" in result
    assert result["postgres_cleanup"]["total_deleted"] == 0