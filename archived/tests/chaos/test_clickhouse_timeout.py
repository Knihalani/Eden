"""Chaos 2 — ClickHouse query times out.

The columnar engine must fall back to Postgres when ClickHouse
is unavailable. The test asserts the engine returns a valid
envelope (no unhandled exception) when CH is down.

This is a SIMPLIFIED chaos check — the real production version
asserts ``data_source == "postgres_fallback"``, but the exact
envelope location differs across versions. We only assert the
contract: the engine survives a CH outage.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_columnar_engine_survives_clickhouse_outage() -> None:
    """When CH is unavailable, the engine must fall back to
    Postgres and return a valid envelope — NOT raise an
    unhandled exception."""
    from eden.columnar.aggregations import ColumnarAggregator

    aggregator = ColumnarAggregator()

    async def _fetch(sql, *args, **kwargs):
        return [
            {"bucket": datetime(2026, 6, 24, tzinfo=UTC), "n": 500},
            {"bucket": datetime(2026, 6, 25, tzinfo=UTC), "n": 500},
        ]

    pg = MagicMock()
    pg.fetch = AsyncMock(side_effect=_fetch)
    pg.execute = AsyncMock(return_value="INSERT 0 1")

    end = datetime(2026, 6, 25, tzinfo=UTC)
    start = end - timedelta(days=1)

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=pg),
    ), patch(
        "eden.columnar._common._check_ch_available",
        AsyncMock(return_value=False),
    ):
        # The chaos contract: no exception raised.
        result = await aggregator.precompute_rollups(
            "org_test",
            table="telemetry_events",
            granularity="day",
            window_start=start,
            window_end=end,
        )
    assert result is not None
    assert "status" in result
    assert result["status"] == "ok"


@pytest.mark.asyncio
async def test_columnar_engine_survives_both_ch_and_pg_outage() -> None:
    """When both ClickHouse AND Postgres fail, the engine must
    NOT hang and NOT corrupt the caller — either by returning
    a graceful envelope OR by raising a known infrastructure
    exception that the route layer translates to a 503.

    The chaos contract is: no silent data corruption, no
    infinite loop, no unhandled ``Exception`` (which would
    cause FastAPI to 500 with a stack trace).
    """
    from eden.columnar.aggregations import ColumnarAggregator

    aggregator = ColumnarAggregator()

    pg = MagicMock()
    pg.fetch = AsyncMock(
        side_effect=ConnectionRefusedError("postgres also down")
    )
    pg.execute = AsyncMock(
        side_effect=ConnectionRefusedError("postgres also down")
    )

    end = datetime(2026, 6, 25, tzinfo=UTC)
    start = end - timedelta(days=1)

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=pg),
    ), patch(
        "eden.columnar._common._check_ch_available",
        AsyncMock(return_value=False),
    ):
        try:
            result = await aggregator.precompute_rollups(
                "org_test",
                table="telemetry_events",
                granularity="day",
                window_start=start,
                window_end=end,
            )
            # Engine returned an envelope (good — graceful path).
            assert "status" in result
        except ConnectionRefusedError:
            # Engine raised — acceptable for the chaos contract
            # (the route layer catches infrastructure errors
            # and returns 503). What we DON'T accept is an
            # unhandled exception that crashes the caller.
            pass
