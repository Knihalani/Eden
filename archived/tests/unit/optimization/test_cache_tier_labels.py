"""§11.2 — KB cache tier telemetry helper tests."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.optimization.cache import record_kb_cache_lookup


@pytest.mark.asyncio
async def test_record_kb_cache_lookup_emits_tier_tag():
    """The telemetry event carries ``tier`` as both a tag and a payload
    field so the dashboard can group by hit tier."""
    fake_collector = MagicMock()
    fake_collector.record_cache_lookup = AsyncMock(return_value=True)

    async def _get_collector():
        return fake_collector
    with patch("eden.observability.telemetry_collector.get_telemetry_collector", side_effect=_get_collector):
        ok = await record_kb_cache_lookup(
            tenant_id="t1",
            trace_id="trace-1",
            tier="L1",
            hit=True,
            latency_ms=1.2,
        )
    assert ok is True
    args = fake_collector.record_cache_lookup.call_args.kwargs
    assert args["tier"] == "L1"
    assert args["hit"] is True
    assert args["latency_ms"] == 1.2


@pytest.mark.asyncio
async def test_record_kb_cache_lookup_handles_db_tier():
    """A DB-tier miss should be recorded with tier='DB'."""
    fake_collector = MagicMock()
    fake_collector.record_cache_lookup = AsyncMock(return_value=True)

    async def _get_collector():
        return fake_collector
    with patch("eden.observability.telemetry_collector.get_telemetry_collector", side_effect=_get_collector):
        await record_kb_cache_lookup(
            tenant_id="t1", trace_id="t", tier="DB",
            hit=False, latency_ms=80.0,
        )
    args = fake_collector.record_cache_lookup.call_args.kwargs
    assert args["tier"] == "DB"
    assert args["hit"] is False


@pytest.mark.asyncio
async def test_record_kb_cache_lookup_silent_on_telemetry_failure():
    """If the telemetry collector is down, the helper returns False
    silently (telemetry is best-effort, never blocks the cache path)."""
    async def _broken():
        raise RuntimeError("telemetry down")
    with patch("eden.observability.telemetry_collector.get_telemetry_collector", side_effect=_broken):
        ok = await record_kb_cache_lookup(
            tenant_id="t1", trace_id="t", tier="L1",
            hit=True, latency_ms=1.0,
        )
    assert ok is False
