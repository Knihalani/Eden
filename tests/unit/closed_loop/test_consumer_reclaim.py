"""M2 (D4) — consumer no longer dies on Redis-down; PEL reclaim; honest acks."""

from __future__ import annotations

import asyncio
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import eden.closed_loop.event_bus as eb


def _fields(**overrides) -> dict[str, str]:
    base = {
        "type": "verify_passed",
        "org_id": "org-1",
        "issue_id": "00000000-0000-0000-0000-000000000001",
        "ref": "ref-1",
    }
    base.update(overrides)
    return base


def _consumer(orch: MagicMock | None = None) -> eb.ClosedLoopConsumer:
    if orch is None:
        orch = MagicMock()
        orch.on_event = AsyncMock()
    return eb.ClosedLoopConsumer(orchestrator=orch)


# ── startup: retry, don't die ───────────────────────────────────────


@pytest.mark.asyncio
async def test_no_redis_at_start_retries_instead_of_returning():
    consumer = _consumer()
    stop = asyncio.Event()
    get_client = AsyncMock(return_value=None)

    with patch("eden.storage.redis.get_redis_stream_client", get_client):
        task = asyncio.create_task(consumer.run(stop))
        await asyncio.sleep(0.05)
        # Old behaviour returned immediately; now it must still be alive,
        # waiting out the backoff before retrying.
        assert not task.done()
        assert get_client.await_count >= 1
        stop.set()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_start_drains_outbox_once_group_ensured():
    consumer = _consumer()
    stop = asyncio.Event()
    redis = MagicMock()
    redis.xgroup_create = AsyncMock()

    async def _read_batch_stop(_redis):
        stop.set()
        return []

    with (
        patch(
            "eden.storage.redis.get_redis_stream_client",
            AsyncMock(return_value=redis),
        ),
        patch.object(eb, "drain_outbox", AsyncMock(return_value=0)) as drain,
        patch.object(consumer, "_read_batch", _read_batch_stop),
    ):
        await asyncio.wait_for(consumer.run(stop), timeout=2.0)

    redis.xgroup_create.assert_awaited_once()
    drain.assert_awaited_once()


# ── PEL reclaim via XAUTOCLAIM ──────────────────────────────────────


@pytest.mark.asyncio
async def test_read_batch_processes_reclaimed_entries():
    consumer = _consumer()
    consumer._last_autoclaim_mono = -1e9  # force the autoclaim branch
    redis = MagicMock()
    redis.xautoclaim = AsyncMock(
        return_value=("0-0", [("7-0", _fields(ref="reclaimed"))], [])
    )
    redis.xreadgroup = AsyncMock(return_value=[])

    out = await consumer._read_batch(redis)

    assert ("7-0", _fields(ref="reclaimed")) in out
    kwargs = redis.xautoclaim.await_args.kwargs
    assert kwargs["min_idle_time"] == eb._PENDING_IDLE_MS
    assert redis.xautoclaim.await_args.args[0] == eb.LOOP_STREAM


@pytest.mark.asyncio
async def test_read_batch_rate_limits_autoclaim():
    consumer = _consumer()
    consumer._last_autoclaim_mono = -1e9
    redis = MagicMock()
    redis.xautoclaim = AsyncMock(return_value=("0-0", [], []))
    redis.xreadgroup = AsyncMock(return_value=[])

    await consumer._read_batch(redis)
    await consumer._read_batch(redis)  # immediately after — inside interval

    assert redis.xautoclaim.await_count == 1
    assert redis.xreadgroup.await_count == 2


@pytest.mark.asyncio
async def test_read_batch_survives_missing_xautoclaim():
    """Older Redis without XAUTOCLAIM must fall through to XREADGROUP."""
    consumer = _consumer()
    consumer._last_autoclaim_mono = -1e9
    redis = MagicMock()
    redis.xautoclaim = AsyncMock(side_effect=Exception("ERR unknown command"))
    redis.xreadgroup = AsyncMock(
        return_value=[(eb.LOOP_STREAM, [("1-0", _fields())])]
    )

    out = await consumer._read_batch(redis)

    assert out == [("1-0", _fields())]


# ── honest acks: no ack on failure, dead-letter after max deliveries ─


def _redis_for_handle(fail_count: int) -> MagicMock:
    redis = MagicMock()
    redis.set = AsyncMock(return_value=True)  # idempotency key fresh
    redis.incr = AsyncMock(return_value=fail_count)
    redis.expire = AsyncMock()
    redis.xack = AsyncMock()
    redis.delete = AsyncMock()
    return redis


@pytest.mark.asyncio
async def test_handler_exception_leaves_entry_unacked_first_time():
    orch = MagicMock()
    orch.on_event = AsyncMock(side_effect=RuntimeError("handler boom"))
    consumer = _consumer(orch)
    redis = _redis_for_handle(fail_count=1)

    await consumer._handle(redis, "1-0", _fields())

    orch.on_event.assert_awaited_once()
    redis.xack.assert_not_awaited()
    redis.incr.assert_awaited_once_with("loop:fail:1-0")


@pytest.mark.asyncio
async def test_dead_letter_ack_after_max_deliveries(caplog):
    orch = MagicMock()
    orch.on_event = AsyncMock(side_effect=RuntimeError("handler boom"))
    consumer = _consumer(orch)
    redis = _redis_for_handle(fail_count=eb._MAX_DELIVERIES)

    with caplog.at_level(logging.ERROR, logger="eden.closed_loop.event_bus"):
        await consumer._handle(redis, "1-0", _fields())

    redis.xack.assert_awaited_once_with(eb.LOOP_STREAM, eb._GROUP, "1-0")
    redis.delete.assert_awaited_once_with("loop:fail:1-0")
    assert any(
        r.levelno == logging.ERROR and "dead-letter" in r.getMessage()
        for r in caplog.records
    )


@pytest.mark.asyncio
async def test_successful_handle_acks():
    orch = MagicMock()
    orch.on_event = AsyncMock()
    consumer = _consumer(orch)
    redis = _redis_for_handle(fail_count=1)

    await consumer._handle(redis, "1-0", _fields())

    orch.on_event.assert_awaited_once()
    redis.xack.assert_awaited_once()
    redis.incr.assert_not_awaited()
