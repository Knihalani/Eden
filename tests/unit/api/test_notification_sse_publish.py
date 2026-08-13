"""OOM-W2-3 P3/P4/P9 — notification inserts publish ``notification:new``
on the observability SSE stream.

The SSE stream is the sole real-time channel between the backend and the
portal.  When a notification row is inserted (budget alert, unified alert
dispatch, etc.) the insert site calls ``publish_notification_event`` so
open portal tabs can refresh their notification list immediately instead
of waiting for the 5-minute fallback poll.

These tests verify that the two main insert sites inside
``src/eden/services/`` and ``src/eden/alerts/`` call the publisher, and
that the publisher wraps ``publish_trace_event`` with the correct
``_sse_event_type`` field.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── publish_notification_event wraps publish_trace_event ─────────────

@pytest.mark.asyncio
async def test_publish_notification_event_sets_sse_event_type() -> None:
    """publish_notification_event must call publish_trace_event with
    ``_sse_event_type: notification:new`` injected into the payload."""
    from eden.api.routes import observability_stream

    captured: list[tuple[str, dict]] = []

    async def fake_publish(org_id: str, payload: dict) -> None:  # type: ignore[type-arg]
        captured.append((org_id, payload))

    with patch.object(
        observability_stream,
        "publish_trace_event",
        new=AsyncMock(side_effect=fake_publish),
    ):
        await observability_stream.publish_notification_event(
            "org_abc",
            {"type": "budget_alert", "threshold_pct": 80},
        )

    assert len(captured) == 1
    org, payload = captured[0]
    assert org == "org_abc"
    assert payload["_sse_event_type"] == "notification:new"
    assert payload["type"] == "budget_alert"
    assert payload["threshold_pct"] == 80


# ── budget_service._notify_budget_alert publishes notification:new ────

@pytest.mark.asyncio
async def test_budget_alert_publishes_notification_new() -> None:
    """_notify_budget_alert must call publish_notification_event after
    the DB INSERT so the portal receives a real-time push."""
    from eden.api.routes import observability_stream
    from eden.services import budget_service

    published: list[tuple[str, dict]] = []

    async def fake_publish_notif(org_id: str, payload: dict) -> None:  # type: ignore[type-arg]
        published.append((org_id, payload))

    # Stub the DB client so the INSERT doesn't need a real Postgres.
    fake_client = AsyncMock()
    fake_client.execute = AsyncMock()

    with (
        patch.object(
            budget_service,
            "get_postgres_client",
            new=AsyncMock(return_value=fake_client),
            create=True,
        ),
        patch.object(
            observability_stream,
            "publish_notification_event",
            new=AsyncMock(side_effect=fake_publish_notif),
        ),
    ):
        await budget_service._notify_budget_alert(
            "org_xyz", threshold_pct=80, used=80.0, hard=100.0
        )

    assert len(published) == 1, "publish_notification_event was not called"
    org, payload = published[0]
    assert org == "org_xyz"
    assert payload.get("type") == "budget_alert"


# ── SSE stream emits notification:new for the right event type ────────

@pytest.mark.asyncio
async def test_event_stream_routes_notification_new_event_type() -> None:
    """_event_stream must emit ``event: notification:new`` when the
    Redis message payload contains ``_sse_event_type: notification:new``,
    and must strip the field from the forwarded JSON data.
    """
    from eden.api.routes import observability_stream

    notif_payload = {
        "_sse_event_type": "notification:new",
        "type": "budget_alert",
        "threshold_pct": 100,
    }
    raw_msg = json.dumps(notif_payload)

    pubsub = AsyncMock()
    pubsub.subscribe = AsyncMock()
    pubsub.unsubscribe = AsyncMock()
    pubsub.close = AsyncMock()
    # First call returns the notification message; second call raises so
    # the stream exits via the interrupted-error path (not important here).
    pubsub.get_message = AsyncMock(
        side_effect=[
            {"type": "message", "data": raw_msg.encode()},
            RuntimeError("done"),
        ]
    )

    # redis.pubsub() is a synchronous call that returns the pubsub object,
    # so fake_redis must be a MagicMock (not AsyncMock).  redis.get is
    # awaited, so we attach an AsyncMock for that attribute.
    fake_redis = MagicMock()
    fake_redis.pubsub.return_value = pubsub
    fake_redis.get = AsyncMock(return_value=None)

    with patch.object(
        observability_stream,
        "get_redis_client",
        new=AsyncMock(return_value=fake_redis),
    ):
        out: list[bytes] = []
        async for chunk in observability_stream._event_stream("org_notif", None):
            out.append(chunk)

    notif_chunks = [c for c in out if c.startswith(b"event: notification:new\n")]
    assert notif_chunks, f"expected notification:new chunk; got: {[c[:80] for c in out]}"

    # The _sse_event_type field must not leak to the client.
    data_line = notif_chunks[0].decode("utf-8")
    data_json = json.loads(data_line.split("data: ", 1)[1].split("\n")[0])
    assert "_sse_event_type" not in data_json
    assert data_json["type"] == "budget_alert"
