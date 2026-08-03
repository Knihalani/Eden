"""Regression tests for ClickHouse GDPR tenant purge (retention + sink).

``DataRetentionManager._delete_from_clickhouse`` delegates to
``ClickHouseSink.delete_tenant_rows``, which uses ``qualified_table``
names (``eden.agent_performance``, ``eden.telemetry_events_ch``,
``eden.home_kpi_hourly`` by default) — never the stale
``metrics.*`` / ``default.*`` literals.

Tinybird hosts must raise incomplete erasure rather than return 0.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink
from eden.data_platform.retention import DataRetentionManager


@pytest.mark.asyncio
async def test_delete_tenant_rows_uses_qualified_table_names() -> None:
    """Self-hosted DELETE targets ``{database}.table``, not metrics/default."""
    sink = ClickHouseSink(
        ClickHouseConfig(url="http://clickhouse:8123", database="eden")
    )
    executed: list[str] = []

    async def _exec(query: str, params=None):  # noqa: ANN001, ARG001
        executed.append(query)
        return ""

    sink._execute = _exec  # type: ignore[method-assign]
    out = await sink.delete_tenant_rows("evil'; DROP TABLE x; --")

    assert out == 3
    joined = "\n".join(executed)
    assert "ALTER TABLE eden.agent_performance" in joined
    assert "ALTER TABLE eden.telemetry_events_ch" in joined
    assert "ALTER TABLE eden.home_kpi_hourly" in joined
    assert "metrics.agent_performance" not in joined
    assert "default.telemetry_events_ch" not in joined
    assert "tenant_id = 'evil''; DROP TABLE x; --'" in joined


@pytest.mark.asyncio
async def test_delete_tenant_rows_tinybird_raises() -> None:
    sink = ClickHouseSink(
        ClickHouseConfig(url="https://api.us-east.tinybird.co", database="eden")
    )
    with pytest.raises(RuntimeError, match="incomplete|Tinybird"):
        await sink.delete_tenant_rows("tenant-1")


@pytest.mark.asyncio
async def test_delete_from_clickhouse_delegates_to_sink() -> None:
    sink = MagicMock()
    sink.delete_tenant_rows = AsyncMock(return_value=3)

    with (
        patch(
            "eden.data_platform.retention.settings",
            SimpleNamespace(clickhouse_url="http://clickhouse:8123/"),
        ),
        patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            AsyncMock(return_value=sink),
        ),
    ):
        mgr = DataRetentionManager()
        out = await mgr._delete_from_clickhouse("00000000-0000-0000-0000-000000000001")

    assert out == 3
    sink.delete_tenant_rows.assert_awaited_once_with(
        "00000000-0000-0000-0000-000000000001"
    )


@pytest.mark.asyncio
async def test_delete_from_clickhouse_returns_zero_when_unconfigured() -> None:
    mgr = DataRetentionManager()
    with patch(
        "eden.data_platform.retention.settings",
        SimpleNamespace(clickhouse_url=""),
    ):
        out = await mgr._delete_from_clickhouse("anything")
    assert out == 0


@pytest.mark.asyncio
async def test_delete_from_clickhouse_tinybird_raises_incomplete() -> None:
    mgr = DataRetentionManager()
    with patch(
        "eden.data_platform.retention.settings",
        SimpleNamespace(clickhouse_url="https://api.us-east.tinybird.co"),
    ):
        with pytest.raises(RuntimeError, match="incomplete|Tinybird"):
            await mgr._delete_from_clickhouse("tenant-1")
