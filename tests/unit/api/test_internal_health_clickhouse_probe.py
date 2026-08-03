"""Phase 0 observability overhaul — ``internal_health._probe_clickhouse``.

Prior to this fix, the healthy branch unconditionally imported
``eden.columnar._common._get_ch_client``, which never existed anywhere
in this codebase. Every real call to ``/v1/internal/health`` therefore
raised ``ImportError`` inside the probe's own ``try`` block and
reported the ``clickhouse`` component ``unhealthy`` regardless of
whether Tinybird (the only ClickHouse substrate) was actually up.

These tests exercise ``_probe_clickhouse`` directly (not through the
HTTP route, which the existing ``tests/integration/test_internal_health.py``
suite already covers by mocking the whole ``PROBES`` dict) so the
probe's own substrate-detection logic is pinned.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.api.routes.internal_health import _probe_clickhouse


def _fake_sink(*, is_tinybird: bool, health_result: str) -> MagicMock:
    sink = MagicMock()
    sink.config = MagicMock()
    sink.config.is_tinybird = is_tinybird
    sink.config.database = "eden"
    sink.health_check = AsyncMock(return_value=health_result)
    return sink


@pytest.mark.asyncio
async def test_probe_clickhouse_no_longer_imports_nonexistent_get_ch_client() -> None:
    """Regression: the old code path raised ImportError on every call."""
    import eden.columnar._common as columnar_common

    assert not hasattr(columnar_common, "_get_ch_client"), (
        "eden.columnar._common._get_ch_client does not exist — "
        "_probe_clickhouse must not import it"
    )


@pytest.mark.asyncio
async def test_probe_clickhouse_healthy_tinybird() -> None:
    sink = _fake_sink(is_tinybird=True, health_result="connected")
    with patch(
        "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
        new=AsyncMock(return_value=sink),
    ):
        result = await _probe_clickhouse()
    assert result["status"] == "healthy"
    assert result["substrate"] == "tinybird"
    assert "probe_ms" in result
    # Tinybird has no queryable system.parts over /v0/sql.
    assert result["partition_count"] is None


@pytest.mark.asyncio
async def test_probe_clickhouse_degraded_when_tinybird_unreachable() -> None:
    sink = _fake_sink(is_tinybird=True, health_result="error: tinybird token missing")
    with patch(
        "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
        new=AsyncMock(return_value=sink),
    ):
        result = await _probe_clickhouse()
    assert result["status"] == "degraded"
    assert result["substrate"] == "tinybird"
    assert "postgres_fallback" in result["note"]
    assert result["detail"] == "error: tinybird token missing"


@pytest.mark.asyncio
async def test_probe_clickhouse_healthy_self_hosted_queries_partition_count() -> None:
    sink = _fake_sink(is_tinybird=False, health_result="connected")
    sink._execute = AsyncMock(return_value="n\n42\n")
    sink._parse_tsv = MagicMock(return_value=[{"n": "42"}])
    with patch(
        "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
        new=AsyncMock(return_value=sink),
    ):
        result = await _probe_clickhouse()
    assert result["status"] == "healthy"
    assert result["substrate"] == "clickhouse"
    assert result["partition_count"] == 42


@pytest.mark.asyncio
async def test_probe_clickhouse_self_hosted_partition_probe_failure_is_soft() -> None:
    """A failed system.parts probe degrades detail only, not the whole status —
    health_check() already confirmed the substrate itself answered."""
    sink = _fake_sink(is_tinybird=False, health_result="connected")
    sink._execute = AsyncMock(side_effect=RuntimeError("system.parts denied"))
    with patch(
        "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
        new=AsyncMock(return_value=sink),
    ):
        result = await _probe_clickhouse()
    assert result["status"] == "healthy"
    assert result["partition_count"] is None


@pytest.mark.asyncio
async def test_probe_clickhouse_unhealthy_on_unexpected_exception() -> None:
    with patch(
        "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
        new=AsyncMock(side_effect=RuntimeError("boom")),
    ):
        result = await _probe_clickhouse()
    assert result["status"] == "unhealthy"
    assert "boom" in result["error"]
