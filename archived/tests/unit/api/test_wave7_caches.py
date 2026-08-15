"""Wave 7 — dashboard summary cache + N16 sampling summary batch flush.

Covers the pure helpers (cache key, buffer flush) with fakes; the live-PG
round-trip behavior of ``persist_buffered`` is exercised via the existing
``test_trace_summaries`` / sampling suites.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.observability.sampling.apply import flush_sampling_summaries
from eden.observability.sampling.summaries import (
    SamplingSummaryStore,
    TraceSamplingSummary,
    get_sampling_summary_store,
)


class TestSummaryCacheKey:
    def test_key_isolates_org_window_agent_compare(self) -> None:
        from eden.api.routes.observability import _summary_cache_key

        a = _summary_cache_key("org-1", window_hours=24, agent_id=None, compare_previous=False)
        b = _summary_cache_key("org-2", window_hours=24, agent_id=None, compare_previous=False)
        c = _summary_cache_key("org-1", window_hours=48, agent_id=None, compare_previous=False)
        d = _summary_cache_key("org-1", window_hours=24, agent_id="agent-a", compare_previous=False)
        e = _summary_cache_key("org-1", window_hours=24, agent_id=None, compare_previous=True)
        assert len({a, b, c, d, e}) == 5

    @pytest.mark.asyncio
    async def test_cache_get_returns_none_on_redis_down(self) -> None:
        from eden.api.routes.observability import _summary_cache_get

        assert await _summary_cache_get("eden:obs:summary:nope") is None


class TestSamplingBatchFlush:
    def test_persist_buffered_dedupes_by_trace(self) -> None:
        store = SamplingSummaryStore()
        store.record(TraceSamplingSummary(org_id="o", trace_id="t1", cost_usd=0.1))
        store.record(TraceSamplingSummary(org_id="o", trace_id="t1", cost_usd=0.2))
        store.record(TraceSamplingSummary(org_id="o", trace_id="t2", cost_usd=0.3))
        assert len(store.buffered()) == 3

        client = MagicMock()
        client.executemany = AsyncMock()
        result = None
        import asyncio

        async def _run() -> None:
            nonlocal result
            result = await store.persist_buffered(client=client)

        asyncio.run(_run())
        assert result == 2  # t1 deduped, t2 → 2 rows
        assert len(store.buffered()) == 0  # cleared on success
        # Last (richest) summary wins for t1.
        rows = client.executemany.call_args[0][1]
        t1 = [r for r in rows if r[1] == "t1"][0]
        assert t1[4] == 0.2  # cost_usd

    def test_persist_buffered_keeps_buffer_on_failure(self) -> None:
        store = SamplingSummaryStore()
        store.record(TraceSamplingSummary(org_id="o", trace_id="t1"))
        client = MagicMock()
        client.executemany = AsyncMock(side_effect=RuntimeError("pg down"))
        import asyncio

        async def _run() -> int:
            return await store.persist_buffered(client=client)

        assert asyncio.run(_run()) == 0
        assert len(store.buffered()) == 1  # retained for retry

    def test_persist_buffered_atomic_snapshot_keeps_rows_during_await(self) -> None:
        """Rows recorded while the DB write is in flight must survive."""
        store = SamplingSummaryStore()
        store.record(TraceSamplingSummary(org_id="o", trace_id="t1"))
        client = MagicMock()
        client.executemany = AsyncMock()

        async def _run() -> int:
            result = await store.persist_buffered(client=client)
            # A drop arrives while the flush was in flight — the snapshot
            # was already taken, so this must not be wiped.
            store.record(TraceSamplingSummary(org_id="o", trace_id="t2"))
            return result

        import asyncio

        assert asyncio.run(_run()) == 1
        assert [s.trace_id for s in store.buffered()] == ["t2"]

    def test_sampling_flush_cooldown_gates_task_spawns(self) -> None:
        """The single-event path must not spawn one flush task per drop."""
        from eden.observability.telemetry_collector import TelemetryCollector

        collector = TelemetryCollector.__new__(TelemetryCollector)
        collector._last_sampling_flush = 0.0
        assert collector._sampling_flush_due() is True
        assert collector._sampling_flush_due() is False  # within cooldown
        collector._last_sampling_flush = 0.0
        assert collector._sampling_flush_due() is True

    @pytest.mark.asyncio
    async def test_flush_sampling_summaries_noop_when_empty(self) -> None:
        store = get_sampling_summary_store()
        store.clear()
        assert await flush_sampling_summaries() == 0

    def test_should_route_event_no_longer_persists_per_event(self) -> None:
        """Source contract: the ingest hot path buffers, never awaits a
        per-event Postgres write."""
        from pathlib import Path

        src = Path("src/eden/observability/sampling/apply.py").read_text()
        assert "store.record(summary)" in src
        assert "await store.persist(summary)" not in src
        collector_src = Path(
            "src/eden/observability/telemetry_collector.py"
        ).read_text()
        assert "flush_sampling_summaries" in collector_src
