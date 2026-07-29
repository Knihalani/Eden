"""N11 — subscribe to live session Redis channel (SSE iterator)."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from eden.observability.live.publisher import _LOCAL_BUFFERS, LiveTracePublisher, _local_key
from eden.observability.live.stream import (
    LIVE_FINALIZE_GRACE_S,
    channel_name,
    live_enabled,
)

logger = logging.getLogger(__name__)


def _sse(event: str, data: dict[str, Any], event_id: str | None = None) -> bytes:
    body = json.dumps(data, default=str)
    out = f"event: {event}\ndata: {body}\n"
    if event_id is not None:
        out += f"id: {event_id}\n"
    out += "\n"
    return out.encode("utf-8")


class LiveTraceSubscriber:
    """Yield SSE bytes for a live session channel."""

    def __init__(self) -> None:
        self._publisher = LiveTracePublisher()

    async def stream(
        self,
        org_id: str,
        session_id: str,
        *,
        from_event_id: int = 0,
        # Default matches portal live SSE proxy maxDuration=300 and
        # observability_stream._STREAM_MAX_DURATION_S so the backend
        # closes with stream_duration_exceeded before Vercel hard-kills.
        max_duration_s: float = 300,
    ) -> AsyncIterator[bytes]:
        if not live_enabled():
            yield _sse(
                "error",
                {
                    "code": "feature_disabled",
                    "message": "live_trace_streaming_v1 is off",
                },
            )
            return

        started = time.monotonic()
        events_sent = 0

        # Replay buffer first (Redis list or local).
        buffered = await self._publisher.drain_buffer(org_id, session_id)
        for ev in buffered:
            eid = int(ev.get("event_id") or 0)
            if eid <= from_event_id:
                continue
            yield _sse(str(ev.get("type") or "span_update"), ev, event_id=str(eid))
            events_sent += 1
            if ev.get("type") == "trace_finalized":
                # Keep connection briefly then close.
                await asyncio.sleep(0.05)
                return

        redis = await self._redis()
        if redis is None:
            async for chunk in self._poll_local(
                org_id, session_id, from_event_id=from_event_id, started=started,
                max_duration_s=max_duration_s, events_sent=events_sent,
            ):
                yield chunk
            return

        channel = channel_name(org_id, session_id)
        pubsub = redis.pubsub()
        try:
            await pubsub.subscribe(channel)
            yield _sse("ping", {"session_id": session_id})

            while True:
                if time.monotonic() - started >= max_duration_s:
                    yield _sse(
                        "error",
                        {
                            "code": "stream_duration_exceeded",
                            "message": "Live stream exceeded duration bound",
                        },
                    )
                    return
                try:
                    msg = await asyncio.wait_for(
                        pubsub.get_message(ignore_subscribe_messages=True),
                        timeout=15.0,
                    )
                except TimeoutError:
                    yield _sse("ping", {})
                    continue
                if msg is None:
                    yield _sse("ping", {})
                    continue
                if msg.get("type") != "message":
                    continue
                try:
                    payload = json.loads(msg["data"]) if msg.get("data") else {}
                except (TypeError, ValueError):
                    continue
                eid = payload.get("event_id")
                if eid is not None and int(eid) <= from_event_id:
                    continue
                yield _sse(
                    str(payload.get("type") or "span_update"),
                    payload,
                    event_id=str(eid) if eid is not None else None,
                )
                events_sent += 1
                if payload.get("type") == "trace_finalized":
                    # Grace: one more ping then close (subscriber side).
                    await asyncio.sleep(min(1.0, LIVE_FINALIZE_GRACE_S))
                    return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("live subscribe failed: %s", exc)
            yield _sse(
                "error",
                {"code": "subscribe_failed", "message": str(exc)},
            )
        finally:
            try:
                await pubsub.unsubscribe(channel)
                await pubsub.close()
            except Exception:
                pass

    async def _poll_local(
        self,
        org_id: str,
        session_id: str,
        *,
        from_event_id: int,
        started: float,
        max_duration_s: float,
        events_sent: int,
    ) -> AsyncIterator[bytes]:
        yield _sse("ping", {"transport": "local", "session_id": session_id})
        last = from_event_id
        while True:
            if time.monotonic() - started >= max_duration_s:
                yield _sse(
                    "error",
                    {
                        "code": "stream_duration_exceeded",
                        "message": "Live stream exceeded duration bound",
                    },
                )
                return
            buf = _LOCAL_BUFFERS.get(_local_key(org_id, session_id))
            if buf:
                for ev in buf.since(last):
                    eid = int(ev.get("event_id") or 0)
                    last = max(last, eid)
                    yield _sse(
                        str(ev.get("type") or "span_update"),
                        ev,
                        event_id=str(eid),
                    )
                    events_sent += 1
                    if ev.get("type") == "trace_finalized":
                        return
                if buf.finalized:
                    return
            try:
                await asyncio.sleep(0.25)
            except asyncio.CancelledError:
                raise
            if events_sent == 0 and (time.monotonic() - started) > 0.5:
                yield _sse("ping", {})

    async def _redis(self) -> Any | None:
        try:
            from eden.storage.redis import get_redis_client

            return await get_redis_client()
        except Exception:
            return None
