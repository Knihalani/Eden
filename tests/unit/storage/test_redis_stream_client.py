"""Redis stream client + Upstash-safe block helpers."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from eden.storage import redis as redis_mod


def test_redis_stream_block_ms_default():
    with patch.object(redis_mod, "_get_settings", return_value=MagicMock(
        redis_stream_block_ms=300_000,
    )):
        assert redis_mod.redis_stream_block_ms() == 300_000


def test_redis_stream_block_ms_floor():
    with patch.object(redis_mod, "_get_settings", return_value=MagicMock(
        redis_stream_block_ms=100,
    )):
        assert redis_mod.redis_stream_block_ms() == 1_000


def test_autoclaim_interval_floor():
    with patch.object(redis_mod, "_get_settings", return_value=MagicMock(
        redis_stream_autoclaim_interval_s=5,
    )):
        assert redis_mod.redis_stream_autoclaim_interval_s() == 30


def test_event_bus_uses_stream_client_helper():
    import inspect

    from eden.closed_loop import event_bus

    src = inspect.getsource(event_bus.ClosedLoopConsumer.run)
    assert "get_redis_stream_client" in src
    assert "block_ms" in src


def test_trace_finalized_uses_stream_client_and_throttled_autoclaim():
    import inspect

    from eden.workers import trace_finalized_consumer as mod

    run_src = inspect.getsource(mod.TraceFinalizedConsumer.run)
    read_src = inspect.getsource(mod.TraceFinalizedConsumer._read_batch)
    assert "get_redis_stream_client" in run_src
    assert "_autoclaim_interval_s" in read_src
    assert "_last_autoclaim_mono" in read_src
