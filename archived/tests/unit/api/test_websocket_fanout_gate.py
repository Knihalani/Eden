"""Phase 3 (ingest hot-path batching) — WebSocket cross-pod fanout gate.

``broadcast_to_job_websockets`` used to unconditionally PUBLISH to the
Redis ``eden:ws:fanout`` channel even when nobody could possibly be
listening (e.g. a single-pod deployment, or a lull with no fanout
listener up). This mirrors ``observability_stream.publish_trace_event``'s
NUMSUB gate (K24): skip the PUBLISH round trip when the channel has no
subscriber besides this pod itself, while always still delivering to any
WebSocket connected on this pod.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.api.routes import websocket as ws_routes
from eden.observability import ingest_hot_path_metrics as metrics


@pytest.fixture(autouse=True)
def _reset_state():
    ws_routes._job_connections.clear()
    ws_routes._WS_NUMSUB_CACHE.clear()
    metrics.reset_for_tests()
    yield
    ws_routes._job_connections.clear()
    ws_routes._WS_NUMSUB_CACHE.clear()
    metrics.reset_for_tests()


def _redis_with_numsub(count: int) -> MagicMock:
    redis = MagicMock()
    redis.pubsub_numsub = AsyncMock(return_value=[(ws_routes._WS_FANOUT_CHANNEL, count)])
    redis.publish = AsyncMock()
    return redis


@pytest.mark.asyncio
async def test_publish_skipped_when_only_this_pod_subscribed():
    """NUMSUB == 1 (this pod's own listener) must skip the PUBLISH."""
    redis = _redis_with_numsub(1)
    with patch.object(ws_routes, "get_redis_client", new=AsyncMock(return_value=redis)):
        await ws_routes.broadcast_to_job_websockets("job-1", {"type": "status"})

    redis.publish.assert_not_awaited()
    assert metrics.get_ingest_hot_path_metrics()["eden_ws_fanout_publish_skipped"] == 1.0


@pytest.mark.asyncio
async def test_publish_skipped_when_no_subscriber_at_all():
    """NUMSUB == 0 must also skip — even more clearly nobody is listening."""
    redis = _redis_with_numsub(0)
    with patch.object(ws_routes, "get_redis_client", new=AsyncMock(return_value=redis)):
        await ws_routes.broadcast_to_job_websockets("job-1", {"type": "status"})

    redis.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_publish_happens_when_another_pod_is_subscribed():
    """NUMSUB > 1 means some other pod might care — PUBLISH must still fire."""
    redis = _redis_with_numsub(2)
    with patch.object(ws_routes, "get_redis_client", new=AsyncMock(return_value=redis)):
        await ws_routes.broadcast_to_job_websockets("job-1", {"type": "status"})

    redis.publish.assert_awaited_once()
    args = redis.publish.await_args.args
    assert args[0] == ws_routes._WS_FANOUT_CHANNEL
    assert metrics.get_ingest_hot_path_metrics()["eden_ws_fanout_publish_skipped"] == 0.0


@pytest.mark.asyncio
async def test_local_delivery_happens_regardless_of_gate():
    """A connection on this pod must always get the message, whether or
    not the cross-pod PUBLISH is skipped."""
    fake_ws = MagicMock()
    fake_ws.send_json = AsyncMock()
    ws_routes._job_connections["job-1"] = {fake_ws}

    redis = _redis_with_numsub(1)  # gate says "skip publish"
    with patch.object(ws_routes, "get_redis_client", new=AsyncMock(return_value=redis)):
        await ws_routes.broadcast_to_job_websockets("job-1", {"type": "status"})

    fake_ws.send_json.assert_awaited_once_with({"type": "status"})
    redis.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_numsub_result_is_cached_within_ttl():
    """A burst of broadcasts must not pay one NUMSUB round trip each."""
    redis = _redis_with_numsub(2)
    with patch.object(ws_routes, "get_redis_client", new=AsyncMock(return_value=redis)):
        await ws_routes.broadcast_to_job_websockets("job-1", {"type": "a"})
        await ws_routes.broadcast_to_job_websockets("job-1", {"type": "b"})
        await ws_routes.broadcast_to_job_websockets("job-2", {"type": "c"})

    redis.pubsub_numsub.assert_awaited_once()
    assert redis.publish.await_count == 3


@pytest.mark.asyncio
async def test_numsub_failure_fails_open_and_still_publishes():
    """A NUMSUB error (unsupported backend / test double) must not
    silently drop cross-pod delivery — fail open and publish."""
    redis = MagicMock()
    redis.pubsub_numsub = AsyncMock(side_effect=RuntimeError("NUMSUB unsupported"))
    redis.publish = AsyncMock()

    with patch.object(ws_routes, "get_redis_client", new=AsyncMock(return_value=redis)):
        await ws_routes.broadcast_to_job_websockets("job-1", {"type": "status"})

    redis.publish.assert_awaited_once()


@pytest.mark.asyncio
async def test_no_redis_client_is_a_local_only_noop():
    with patch.object(ws_routes, "get_redis_client", new=AsyncMock(return_value=None)):
        # Must not raise.
        await ws_routes.broadcast_to_job_websockets("job-1", {"type": "status"})


@pytest.mark.asyncio
async def test_redis_unavailable_is_a_local_only_noop():
    with patch.object(
        ws_routes, "get_redis_client", new=AsyncMock(side_effect=RuntimeError("down")),
    ):
        # Must not raise.
        await ws_routes.broadcast_to_job_websockets("job-1", {"type": "status"})
