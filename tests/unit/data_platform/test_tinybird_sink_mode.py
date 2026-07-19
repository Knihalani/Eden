"""Tinybird mode detection + Events API insert path for ClickHouseSink."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink


def test_is_tinybird_detects_host() -> None:
    cfg = ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="t")
    assert cfg.is_tinybird is True
    assert ClickHouseConfig(url="http://localhost:8123").is_tinybird is False


@pytest.mark.asyncio
async def test_init_schema_skips_ddl_on_tinybird() -> None:
    sink = ClickHouseSink(
        ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="t")
    )
    with patch.object(sink, "_execute", new_callable=AsyncMock) as exe:
        await sink.init_schema()
        exe.assert_not_called()
    assert sink._initialized is True


@pytest.mark.asyncio
async def test_insert_json_uses_events_api() -> None:
    sink = ClickHouseSink(
        ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="tok")
    )
    sink._initialized = True

    resp = MagicMock()
    resp.status = 202
    resp.text = AsyncMock(return_value="ok")
    resp.__aenter__ = AsyncMock(return_value=resp)
    resp.__aexit__ = AsyncMock(return_value=False)

    session = MagicMock()
    session.post = MagicMock(return_value=resp)

    with patch.object(sink, "_get_session", AsyncMock(return_value=session)):
        await sink._insert_json("telemetry_events_ch", [{"event_id": "1"}])

    session.post.assert_called_once()
    args, kwargs = session.post.call_args
    assert args[0].endswith("/v0/events")
    assert kwargs["params"]["name"] == "telemetry_events_ch"
    assert kwargs["headers"]["Authorization"] == "Bearer tok"
