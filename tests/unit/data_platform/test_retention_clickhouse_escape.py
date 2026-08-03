"""Regression tests for ClickHouse GDPR tenant purge (retention + sink).

``DataRetentionManager._delete_from_clickhouse`` delegates to
``ClickHouseSink.delete_tenant_rows``, which uses ``qualified_table``
names (``eden.agent_performance``, ``eden.telemetry_events_ch``,
``eden.home_kpi_hourly`` by default) — never the stale
``metrics.*`` / ``default.*`` literals.

Tinybird uses ``POST /v0/datasources/{name}/delete`` (Jobs API), not
``/v0/sql`` ALTER DELETE.
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
async def test_delete_tenant_rows_tinybird_uses_datasource_delete_api() -> None:
    """Tinybird path posts to /v0/datasources/{ds}/delete and waits on jobs."""
    sink = ClickHouseSink(
        ClickHouseConfig(
            url="https://api.us-east.tinybird.co",
            tinybird_token="tok",
            database="eden",
        )
    )
    posts: list[tuple[str, dict[str, str]]] = []
    gets: list[str] = []

    class _Resp:
        def __init__(self, status: int, body: str) -> None:
            self.status = status
            self._body = body

        async def text(self) -> str:
            return self._body

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return False

    class _Session:
        def post(self, url, *, data=None, headers=None):  # noqa: ANN001, ARG002
            posts.append((url, dict(data or {})))
            job = "job-" + str(len(posts))
            return _Resp(200, f'{{"job_id": "{job}", "job_url": "https://x/{job}"}}')

        def get(self, url, *, headers=None):  # noqa: ANN001, ARG002
            gets.append(url)
            return _Resp(200, '{"status": "done"}')

    sink._get_session = AsyncMock(return_value=_Session())  # type: ignore[method-assign]
    out = await sink.delete_tenant_rows("tenant-1")

    # Required (2) + optional (4) = 6 posts when all succeed
    assert out == 6
    assert any("/v0/datasources/telemetry_events_ch/delete" in u for u, _ in posts)
    assert any("/v0/datasources/home_kpi_hourly/delete" in u for u, _ in posts)
    assert posts[0][1]["delete_condition"] == "tenant_id = 'tenant-1'"
    assert all("/v0/jobs/" in g for g in gets)
    assert "ALTER TABLE" not in str(posts)


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
async def test_delete_from_clickhouse_tinybird_delegates_to_sink() -> None:
    sink = MagicMock()
    sink.delete_tenant_rows = AsyncMock(return_value=2)

    with (
        patch(
            "eden.data_platform.retention.settings",
            SimpleNamespace(clickhouse_url="https://api.us-east.tinybird.co"),
        ),
        patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            AsyncMock(return_value=sink),
        ),
    ):
        mgr = DataRetentionManager()
        out = await mgr._delete_from_clickhouse("tenant-1")

    assert out == 2
    sink.delete_tenant_rows.assert_awaited_once_with("tenant-1")
