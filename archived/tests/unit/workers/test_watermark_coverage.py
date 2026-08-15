"""OPT-28 — watermark batch coverage metrics."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from eden.workers import leader as leader_mod


@pytest.fixture(autouse=True)
def _reset_coverage() -> None:
    leader_mod.reset_leader_failure_counts()
    yield
    leader_mod.reset_leader_failure_counts()


@pytest.mark.asyncio
async def test_refresh_watermark_coverage_sets_ratio_and_snapshot() -> None:
    pg = AsyncMock()
    pg.fetchval = AsyncMock(side_effect=[100.0, 25.0, 10.0, 5.0, 4.0, 2.0, 50.0, 40.0])

    out = await leader_mod.refresh_watermark_coverage(pg, window_days=7)

    assert out["auto_curator"]["candidates_total"] == 100.0
    assert out["auto_curator"]["processed_recent"] == 25.0
    assert out["auto_curator"]["ratio"] == 0.25
    snap = leader_mod.watermark_coverage_snapshot()
    assert snap["auto_curator"]["ratio"] == 0.25


def test_record_watermark_batch_tracks_last_tick() -> None:
    leader_mod.record_watermark_batch(
        "auto_curator", batch_size=50, candidate_total=200
    )
    snap = leader_mod.watermark_coverage_snapshot()["auto_curator"]
    assert snap["last_batch_size"] == 50.0
    assert snap["last_candidate_total"] == 200.0
