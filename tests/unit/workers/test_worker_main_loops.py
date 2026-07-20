"""Wave 8.1 — worker main loops, leader lock, insights watermark.

Focused unit tests for crash supervision, silent-failure logging,
leader lock fail-closed behaviour, and webhook drain singleton use.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest


# ── Leader lock / run_if_leader ─────────────────────────────────────


@pytest.mark.asyncio
async def test_lock_acquire_fail_closed_on_redis_set_error() -> None:
    """Redis SET raising must not crash the worker — refuse lock."""
    from eden.storage.redis import Lock

    client = AsyncMock()
    client.set = AsyncMock(side_effect=ConnectionError("redis down"))

    with patch(
        "eden.storage.redis.get_redis_client",
        new=AsyncMock(return_value=client),
    ):
        lock = Lock("w8-acquire", ttl=30)
        assert await lock.acquire() is False
        assert lock._token is None


@pytest.mark.asyncio
async def test_run_if_leader_survives_acquire_exception() -> None:
    """Acquire raising must not kill the leader loop permanently."""
    from eden.workers.leader import run_if_leader

    stop = asyncio.Event()
    ticks = 0

    async def _work() -> None:
        nonlocal ticks
        ticks += 1
        stop.set()

    acquire_calls = 0

    async def _flaky_acquire(self: Any, token: str | None = None) -> bool:
        nonlocal acquire_calls
        acquire_calls += 1
        if acquire_calls == 1:
            raise RuntimeError("redis blip")
        # Second attempt: grant lock so work runs and stop is set.
        self._token = "tok"
        return True

    with patch("eden.workers.leader.Lock.acquire", _flaky_acquire), patch(
        "eden.workers.leader.Lock.release", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.extend", new=AsyncMock(return_value=True)
    ):
        await asyncio.wait_for(
            run_if_leader("w8-flaky", _work, interval=0.01, stop=stop),
            timeout=2.0,
        )

    assert acquire_calls >= 2
    assert ticks == 1


@pytest.mark.asyncio
async def test_run_if_leader_logs_work_failure_and_continues() -> None:
    """Work exceptions are logged; the loop keeps ticking."""
    from eden.workers.leader import run_if_leader

    stop = asyncio.Event()
    calls = 0

    async def _work() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ValueError("tick boom")
        stop.set()

    with patch(
        "eden.workers.leader.Lock.acquire", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.release", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.extend", new=AsyncMock(return_value=True)
    ):
        await asyncio.wait_for(
            run_if_leader("w8-work-fail", _work, interval=0.01, stop=stop),
            timeout=2.0,
        )

    assert calls == 2


# ── Supervised restart ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_supervise_restarts_after_crash() -> None:
    """Unhandled factory crash → ERROR log + restart after backoff."""
    from eden.workers import main as worker_main

    stop = asyncio.Event()
    attempts = 0

    async def _factory(stop_event: asyncio.Event) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("boom")
        stop_event.set()

    await asyncio.wait_for(
        worker_main._supervise(
            "test-loop", _factory, stop, backoff=0.01
        ),
        timeout=2.0,
    )
    assert attempts == 2
    assert stop.is_set()


# ── Webhook drain uses process singleton ────────────────────────────


def test_worker_webhook_drain_uses_singleton() -> None:
    """Per-tick ``WebhookDeliveryService()`` orphans in-flight tasks."""
    from eden.workers import main as worker_main

    src = inspect.getsource(worker_main)
    assert "get_webhook_delivery_service" in src
    # Leader path must not construct a throwaway instance each tick.
    leader_src = inspect.getsource(worker_main._leader_webhook_drain_loop)
    assert "get_webhook_delivery_service" in leader_src
    assert "WebhookDeliveryService()" not in leader_src


# ── Insights watermark hold on persist failure ──────────────────────


@pytest.mark.asyncio
async def test_insights_holds_watermark_when_persist_fails() -> None:
    """Failed persists must not advance the watermark (retry next tick)."""
    from eden.insights import detector_loop as loop_module

    tenant = "org-w8"
    run_id = uuid4()
    row = {
        "judge_run_id": run_id,
        "judge_name": "hallucination",
        "judge_version": "1",
        "trace_id": "tr_1",
        "span_id": "sp_1",
        "score": 0.1,
        "rationale": "bad",
        "model": "m",
        "scored_at": None,
        "latency_ms": 1,
        "tenant_id": tenant,
    }

    mock_pg = AsyncMock()

    async def _fetch(query: str, *args: Any) -> list[Any]:
        if "DISTINCT j.tenant_id" in query:
            return [{"tenant_id": tenant}]
        return [row]

    mock_pg.fetch = AsyncMock(side_effect=_fetch)
    mock_pg.fetchrow = AsyncMock(return_value=None)
    mock_pg.execute = AsyncMock(return_value="OK")

    service = MagicMock()
    service.persist_insight_to_postgres = AsyncMock(
        side_effect=RuntimeError("db write failed")
    )

    with patch(
        "eden.insights.detector_loop.get_postgres_client",
        AsyncMock(return_value=mock_pg),
    ), patch(
        "eden.insights.insights_service.InsightsService",
        return_value=service,
    ):
        loop = loop_module.InsightsDetectorLoop(batch_size=10)
        result = await loop.tick_once()

    assert result == {tenant: 0}
    watermark_writes = [
        c
        for c in mock_pg.execute.await_args_list
        if "judge_scores_processed" in str(c.args[0])
    ]
    assert watermark_writes == []
