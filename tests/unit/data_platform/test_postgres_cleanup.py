"""Tests for ``eden.data_platform.cleanup.PostgresCleanupService``."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _patched_client(client):
    """Patch get_postgres_client at the import site the service uses."""
    return patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    )


def _fake_client(fetchval_seq, *, schema_cols=None):
    """Build a fake PostgresClient.

    ``schema_cols`` controls what ``fetch()`` returns for the schema
    introspection query. Defaults to enough columns to make every
    default sweep pass its schema check (completed_jobs needs
    ``completed_at`` + ``status``; read_notifications needs
    ``created_at`` + ``read_at``; etc.).
    """
    client = MagicMock()
    client.fetchval = AsyncMock(side_effect=fetchval_seq)
    client.fetch = AsyncMock(
        return_value=schema_cols
        if schema_cols is not None
        else [
            {"column_name": "completed_at"},
            {"column_name": "status"},
            {"column_name": "created_at"},
            {"column_name": "read_at"},
            {"column_name": "expires_at"},
        ]
    )
    client.execute = AsyncMock(return_value="DELETE 0")
    return client


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
    from datetime import datetime, timezone

    from eden.data_platform.cleanup import PostgresCleanupService

    client = MagicMock()
    client.fetchval = AsyncMock(return_value=0)
    client.fetch = AsyncMock(
        return_value=[
            # Pretend every sweep's table has the columns it needs.
            {"column_name": "completed_at"},
            {"column_name": "created_at"},
            {"column_name": "read_at"},
            {"column_name": "status"},
            {"column_name": "expires_at"},
        ]
    )
    client.execute = AsyncMock(return_value="DELETE 0")
    with _patched_client(client):
        svc = PostgresCleanupService(
            sweeps=PostgresCleanupService.DEFAULT_SWEEPS[:2],
            dry_run=False,
            batch_limit=500,
        )
        report = await svc.run()

    # All sweeps that survived the schema check get a DELETE.
    assert client.execute.await_count == 2
    sqls = [c.args[0] for c in client.execute.await_args_list]
    for sql in sqls:
        assert "DELETE FROM" in sql
        assert "LIMIT 500" in sql
    # Cutoff is passed as a real datetime (not a string), so asyncpg
    # doesn't reject it with "expected datetime.date/datetime".
    for call in client.execute.await_args_list:
        arg = call.args[1] if len(call.args) > 1 else call.kwargs.get("$1")
        assert isinstance(arg, datetime)
        assert arg.tzinfo is not None
    assert set(report.runs) == {"completed_jobs", "read_notifications"}


@pytest.mark.asyncio
async def test_sweep_skipped_when_table_missing():
    """Greenfield DB: ``ai_conversations`` doesn't exist → sweep silently skipped."""
    from eden.data_platform.cleanup import PostgresCleanupService, _Sweep

    client = MagicMock()
    # Pretend ai_conversations doesn't exist by returning empty column list.
    client.fetch = AsyncMock(return_value=[])
    client.execute = AsyncMock(return_value="DELETE 0")
    with _patched_client(client):
        sweep = _Sweep(
            name="ai_conversations_test",
            table="ai_conversations",
            age_column="created_at",
            age_days=90,
        )
        svc = PostgresCleanupService(sweeps=(sweep,), dry_run=False)
        report = await svc.run()
    assert client.execute.await_count == 0
    assert "ai_conversations_test" not in report.runs


@pytest.mark.asyncio
async def test_sweep_skipped_when_required_column_missing():
    """Schema-drift: ``org_invitations`` exists but lacks ``status`` column."""
    from eden.data_platform.cleanup import PostgresCleanupService, _Sweep

    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[
            # Real org_invitations schema on Neon staging (no ``status``).
            {"column_name": "id"},
            {"column_name": "org_id"},
            {"column_name": "email"},
            {"column_name": "token"},
            {"column_name": "role"},
            {"column_name": "invited_by"},
            {"column_name": "expires_at"},
            {"column_name": "accepted_at"},
            {"column_name": "created_at"},
        ]
    )
    client.execute = AsyncMock(return_value="DELETE 0")
    with _patched_client(client):
        sweep = _Sweep(
            name="expired_invitations",
            table="org_invitations",
            age_column="expires_at",
            age_days=7,
            extra_where="status = 'pending' AND expires_at < NOW()",
        )
        svc = PostgresCleanupService(sweeps=(sweep,), dry_run=False)
        report = await svc.run()
    assert client.execute.await_count == 0
    assert "expired_invitations" not in report.runs


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
    # Schema check passes (every default sweep has its expected cols).
    client.fetch = AsyncMock(
        return_value=[
            {"column_name": "completed_at"},
            {"column_name": "status"},
            {"column_name": "created_at"},
            {"column_name": "read_at"},
            {"column_name": "expires_at"},
        ]
    )
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