"""OPT-52 — retention_cron cold-archive watermarked candidate selection."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.storage.watermark import advance_watermark, fetch_stale_candidates


class _FakePg:
    """Minimal in-Python stand-in for watermark join/order/limit semantics."""

    def __init__(self, candidate_ids: list[str]) -> None:
        self.candidate_ids = candidate_ids
        self.watermark: dict[str, float] = {}
        self._clock = 0.0

    async def fetch(self, _query: str, limit: int):
        def sort_key(tenant_id: str) -> tuple[int, float]:
            ts = self.watermark.get(tenant_id)
            return (0, 0.0) if ts is None else (1, ts)

        ordered = sorted(self.candidate_ids, key=sort_key)
        return [{"tenant_id": tid} for tid in ordered[:limit]]

    async def execute(self, _query: str, entity_id: str):
        self._clock += 1.0
        self.watermark[entity_id] = self._clock
        return "INSERT 0 1"


@pytest.mark.asyncio
async def test_list_orgs_uses_watermarked_query_with_order_by():
    """fetch_stale_candidates must left-join retention_archive_watermark."""
    from eden.data_platform import retention_cron

    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=[{"tenant_id": "org-1"}])

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=pg),
        ),
        patch(
            "eden.storage.watermark.fetch_stale_candidates",
            wraps=fetch_stale_candidates,
        ) as wrapped,
    ):
        orgs = await retention_cron._list_orgs_with_old_traces(
            MagicMock(), {}
        )

    assert orgs == ["org-1"]
    call_kwargs = wrapped.await_args.kwargs
    assert call_kwargs["watermark_table"] == "retention_archive_watermark"
    assert call_kwargs["watermark_id_column"] == "tenant_id"
    assert "telemetry_events" in call_kwargs["candidate_table"]
    query, limit_arg = pg.fetch.await_args.args
    assert limit_arg == retention_cron._RETENTION_ARCHIVE_BATCH_SIZE
    assert "LEFT JOIN retention_archive_watermark" in query
    assert "ORDER BY w.last_processed_at ASC NULLS FIRST" in query


@pytest.mark.asyncio
async def test_watermark_drains_fifo_across_batches():
    """Orgs excluded by a plain LIMIT surface on later runs after advance."""
    tenants = [f"tenant-{i}" for i in range(6)]
    pg = _FakePg(tenants)

    seen_batches: list[list[str]] = []
    for _ in range(2):
        rows = await fetch_stale_candidates(
            pg,
            candidate_table="(SELECT tenant_id AS id FROM telemetry_events)",
            watermark_table="retention_archive_watermark",
            candidate_id_column="id",
            watermark_id_column="tenant_id",
            id_alias="tenant_id",
            limit=3,
        )
        batch = [r["tenant_id"] for r in rows]
        seen_batches.append(batch)
        for tid in batch:
            await advance_watermark(
                pg,
                watermark_table="retention_archive_watermark",
                entity_id=tid,
                watermark_id_column="tenant_id",
            )

    assert len(set(seen_batches[0])) == 3
    assert len(set(seen_batches[1])) == 3
    assert set(seen_batches[0]).isdisjoint(seen_batches[1])


@pytest.mark.asyncio
async def test_run_advances_watermark_per_org_even_on_archive_failure():
    """advance_watermark fires once per org, including after archive errors."""
    from eden.data_platform import retention_cron

    mock_archive = MagicMock()
    mock_archive.archive_old_rows = AsyncMock(
        side_effect=[RuntimeError("boom"), {"traces_archived": 0}]
    )
    mock_retention = MagicMock()
    mock_retention.policies = []
    mock_retention.run_retention_policy = AsyncMock(
        return_value=MagicMock(errors=[])
    )
    mock_retention.purge_archived_telemetry = AsyncMock(return_value=0)
    mock_lifecycle = MagicMock()
    mock_lifecycle.apply_s3_lifecycle_rules = AsyncMock(return_value=True)
    mock_lifecycle.expire_temporary_data = AsyncMock(return_value=0)
    mock_pg = MagicMock()

    with (
        patch(
            "eden.data_platform.retention_cron.ArchiveService",
            return_value=mock_archive,
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
            "eden.data_platform.retention_cron._list_orgs_with_old_traces",
            new=AsyncMock(return_value=["org_a", "org_b"]),
        ),
        patch(
            "eden.data_platform.retention_cron._load_org_warm_days",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ),
        patch(
            "eden.storage.watermark.advance_watermark",
            new=AsyncMock(),
        ) as mock_advance,
    ):
        await retention_cron.run(dry_run=True)

    assert mock_advance.await_count == 2
    advanced_orgs = [
        call.kwargs["entity_id"] for call in mock_advance.await_args_list
    ]
    assert advanced_orgs == ["org_a", "org_b"]
    for call in mock_advance.await_args_list:
        assert call.kwargs["watermark_table"] == "retention_archive_watermark"
        assert call.kwargs["watermark_id_column"] == "tenant_id"
