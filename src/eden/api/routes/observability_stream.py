"""SSE endpoint for live trace tail.

Phase 7.2 (C3): ``GET /orgs/{org_id}/observability/stream`` is a
server-sent-events stream that pushes new trace events as they arrive.
The portal's ``use-observability-stream`` hook subscribes and appends
them to the trace list in real time.

Wire shape:
    GET /orgs/{org_id}/observability/stream?last_event_id=...

    Each event: ``event: trace\ndata: {<json>}\nid: <seq>\n\n``
    Keep-alive: ``event: ping\ndata: {}\n\n`` every 15s

The stream is fed from a per-tenant Redis pub/sub channel. The
TelemetryCollector publishes to that channel after every successful
``_route_postgres`` write. Last-Event-ID resume is supported — when
the client reconnects, the backend replays any missed events.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import StreamingResponse

from eden.api.deps import get_current_user, require_org_member
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/observability", tags=["observability"])


@router.get("/stream")
async def stream_traces(
    org_id: str = Path(..., description="Organization ID"),
    last_event_id: str | None = Query(
        None,
        description="Last-Event-ID for resume",
    ),
    # Audit 2026-06-22 B1.13 — require org membership; prevents cross-org SSE subscribe.
    member: dict = Depends(require_org_member),
) -> StreamingResponse:
    """Stream new trace events as SSE.

    Each SSE message is a JSON object with the same shape as the
    list endpoint. The ``id`` field is monotonic within a tenant's
    stream so the client can resume via Last-Event-ID.
    """
    # Use member.org_id (validated) instead of raw path param.
    return StreamingResponse(
        _event_stream(member["org_id"], last_event_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _event_stream(
    org_id: str,
    last_event_id: str | None,
) -> AsyncIterator[bytes]:
    """Generator: yield SSE messages from the per-tenant channel."""
    redis = await get_redis_client()
    if not redis:
        # No Redis available — emit a single keep-alive then close
        # so the client at least knows we're alive.
        yield _format_sse("ping", "{}")
        await asyncio.sleep(15)
        yield _format_sse("ping", "{}")
        return

    channel = f"observability:stream:{org_id}"
    pubsub = redis.pubsub()
    try:
        await pubsub.subscribe(channel)
        # Send a keep-alive immediately so the browser's
        # EventSource transitions to OPEN.
        yield _format_sse("ping", "{}")

        # Track the last event id we sent so reconnecting clients
        # can resume. We use a counter per stream.
        seq = 0
        if last_event_id:
            try:
                seq = int(last_event_id)
            except (TypeError, ValueError):
                seq = 0

        # Initial backfill: if the client sent last_event_id, replay
        # events newer than that from a short-lived list.
        if last_event_id is not None:
            backfilled = await _replay_since(org_id, last_event_id)
            for ev in backfilled:
                seq += 1
                yield _format_sse(
                    "trace", json.dumps(ev, default=str), event_id=str(seq)
                )

        while True:
            try:
                msg = await asyncio.wait_for(
                    pubsub.get_message(ignore_subscribe_messages=True),
                    timeout=15.0,
                )
            except TimeoutError:
                # 15s keep-alive ping — keeps the connection open
                # through proxies that idle-close.
                yield _format_sse("ping", "{}")
                continue

            if msg is None:
                # No data on the channel — keep-alive.
                yield _format_sse("ping", "{}")
                continue
            if msg.get("type") != "message":
                continue
            try:
                payload = json.loads(msg["data"]) if msg.get("data") else {}
            except (TypeError, ValueError):
                continue
            seq += 1
            yield _format_sse(
                "trace", json.dumps(payload, default=str), event_id=str(seq)
            )
    except asyncio.CancelledError:
        # Client disconnected.
        raise
    except Exception as exc:
        logger.debug(f"observability stream error for {org_id}: {exc}")
    finally:
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.close()
        except Exception:
            pass


def _format_sse(
    event: str,
    data: str,
    event_id: str | None = None,
) -> bytes:
    """Format one SSE message."""
    out = f"event: {event}\ndata: {data}\n"
    if event_id is not None:
        out += f"id: {event_id}\n"
    out += "\n"
    return out.encode("utf-8")


async def _replay_since(org_id: str, last_event_id: str) -> list[dict]:
    """Replay missed events from a small Redis list. The list is
    updated by the collector's publish step; it stores the last 1000
    events per tenant with their sequence number."""
    redis = await get_redis_client()
    if not redis:
        return []
    list_key = f"observability:replay:{org_id}"
    try:
        # The list stores ``(seq, payload_json)`` tuples. We fetch
        # all and filter to seq > last_event_id. The list is bounded
        # at 1000 so this stays cheap.
        raw = await redis.lrange(list_key, 0, -1)
    except Exception as exc:
        logger.debug(f"replay lrange failed: {exc}")
        return []
    out: list[dict] = []
    try:
        last_seq = int(last_event_id)
    except (TypeError, ValueError):
        return []
    for item in raw:
        try:
            seq, payload = item.split("|", 1)
            if int(seq) > last_seq:
                out.append(json.loads(payload))
        except (ValueError, json.JSONDecodeError):
            continue
    return out


# ── Helper for the collector to publish to the stream ────────────────


async def publish_trace_event(org_id: str, payload: dict[str, Any]) -> None:
    """Publish a new trace event to the per-tenant SSE channel.

    Called by ``TelemetryCollector._route_postgres`` (or anywhere
    that wants to push a trace summary to live-tail subscribers).
    The payload should match the shape of the trace list endpoint
    (``trace_id, realm, agent_id, started_at, outcome, span_count,
    duration_ms, streaming_metrics``).
    """
    redis = await get_redis_client()
    if not redis:
        return
    channel = f"observability:stream:{org_id}"
    list_key = f"observability:replay:{org_id}"
    try:
        # Monotonic per-tenant sequence (Redis INCR for atomicity).
        seq = await redis.incr(f"observability:seq:{org_id}")
        body = json.dumps(payload, default=str)
        await redis.publish(channel, body)
        # Push onto the bounded replay list. Trim from the left to
        # keep at most 1000 entries.
        await redis.lpush(list_key, f"{seq}|{body}")
        await redis.ltrim(list_key, 0, 999)
    except Exception as exc:
        logger.debug(f"publish_trace_event failed: {exc}")
