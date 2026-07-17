"""N10 — deep search → signal pipeline tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.search import deep_to_signal as n10


@pytest.mark.asyncio
async def test_preview_includes_cost_estimate() -> None:
    with patch(
        "eden.signals.backfill.count_traces_in_window", AsyncMock(return_value=50)
    ):
        data = await n10.preview_save_as_signal(
            "org",
            search_query="user frustrated",
            trace_ids=["t1", "t2"],
            backfill_days=7,
        )
    assert data["trace_count"] == 2
    assert data["backfill_trace_estimate"] == 50
    assert data["estimated_backfill_cost_usd"] == 0.5


@pytest.mark.asyncio
async def test_save_requires_query_and_traces() -> None:
    with pytest.raises(ValueError, match="search_query"):
        await n10.save_search_as_signal("org", search_query="", trace_ids=["t1"])
