"""Wave 9.4 — mid-stream SSE errors must emit a terminal event:error.

Pre-fix: unexpected exceptions in ``_event_stream`` were logged and
the generator exited silently, so the portal treated the close as a
transient disconnect and kept reconnecting.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_midstream_exception_emits_stream_interrupted() -> None:
    from eden.api.routes import observability_stream

    pubsub = AsyncMock()
    pubsub.subscribe = AsyncMock()
    pubsub.unsubscribe = AsyncMock()
    pubsub.close = AsyncMock()
    # First get_message raises — after the initial ping was yielded.
    pubsub.get_message = AsyncMock(side_effect=RuntimeError("redis blip"))

    fake_redis = MagicMock()
    fake_redis.pubsub.return_value = pubsub

    with patch.object(
        observability_stream,
        "get_redis_client",
        new=AsyncMock(return_value=fake_redis),
    ):
        out: list[bytes] = []
        async for chunk in observability_stream._event_stream("org_test", None):
            out.append(chunk)

    assert len(out) >= 2, f"expected ping + error, got {out!r}"
    assert out[0].startswith(b"event: ping\n")
    error_chunks = [c for c in out if c.startswith(b"event: error\n")]
    assert len(error_chunks) == 1
    body = error_chunks[0].decode("utf-8")
    payload = json.loads(body.split("data: ", 1)[1].split("\n")[0])
    assert payload["code"] == "stream_interrupted"
    pubsub.unsubscribe.assert_awaited()
    pubsub.close.assert_awaited()
