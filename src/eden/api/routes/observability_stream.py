"""SSE endpoint for live trace tail.

Phase 7.2 (C3): ``GET /orgs/{org_id}/observability/sse/stream`` is a
server-sent-events stream that pushes new trace events as they arrive.
The portal's ``use-observability-stream`` hook subscribes and appends
them to the trace list in real time.

Wire shape:
    GET /orgs/{org_id}/observability/sse/stream?last_event_id=...

    Each event: ``event: trace\ndata: {<json>}\nid: <seq>\n\n``
    Keep-alive: ``event: ping\ndata: {}\n\n`` every 15s

The stream is fed from a per-tenant Redis pub/sub channel. The
TelemetryCollector publishes to that channel after every successful
``_route_postgres`` write. Last-Event-ID resume is supported — when
the client reconnects, the backend replays any missed events.

Phase 2 audit (2026-06-23) — renamed the prefix from
``/orgs/{org_id}/observability`` to ``/orgs/{org_id}/observability/sse``.
The main observability router in ``observability.py`` already uses the
shorter prefix; co-mounting both routers under the same prefix was
prone to silent route shadowing (e.g. any future ``/summary`` SSE
endpoint would 404 the observability summary list). The
``/observability/sse/`` subtree is now exclusively for streaming.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import StreamingResponse

from eden.api.deps import require_org_member
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/observability/sse", tags=["observability"])


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
        # Audit 2026-07-03 B-21 — Redis-down used to emit two
        # ``event: ping`` keep-alives then silently close, which
        # the Braintrust dashboard interpreted as "stream
        # active, just quiet". The portal then polled forever.
        # Now emit a single ``event: error`` with
        # ``code=redis_unavailable`` so the client can fail open
        # to the REST fallback immediately.
        yield _format_sse(
            "error",
            json.dumps(
                {
                    "code": "redis_unavailable",
                    "message": (
                        "Realtime channel is offline; falling back "
                        "to REST polling."
                    ),
                }
            ),
        )
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

        # Audit 2026-07-03 B-22 — bound the last_event_id gap. A
        # reconnecting client that woke up > ``_MAX_REPLAY_GAP``
        # behind the server's current seq would otherwise try to
        # backfill a multi-hour window and DDoS the ZSET replay
        # path. Refuse with ``event: error`` / ``code=last_event_id_too_old``
        # so the client falls back to a fresh REST query.
        if last_event_id is not None:
            try:
                raw_seq = await redis.get(
                    f"observability:replay:seq:{org_id}"
                )
                current_seq = int(raw_seq) if raw_seq is not None else seq
            except (TypeError, ValueError):
                current_seq = seq
            try:
                last_seq = int(last_event_id)
            except (TypeError, ValueError):
                last_seq = seq
            if current_seq - last_seq > _MAX_REPLAY_GAP:
                yield _format_sse(
                    "error",
                    json.dumps(
                        {
                            "code": "last_event_id_too_old",
                            "message": (
                                f"Stream replay gap exceeds the "
                                f"{_MAX_REPLAY_GAP}-event bound; "
                                f"resync from a fresh REST query."
                            ),
                            "current_seq": current_seq,
                            "last_event_id": last_seq,
                        }
                    ),
                )
                return

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


# Audit 2026-07-03 B-22 — bound on how far a reconnecting client
# can backfill. Matches the ZSET replay window written by the
# collector (``observability:replay:{org}`` ZSET, capped at the
# last 1000 events); anything older than that isn't in the buffer
# anyway, so refusing up-front is the safe default.
_MAX_REPLAY_GAP = 1000


async def _replay_since(org_id: str, last_event_id: str) -> list[dict]:
    """Replay missed events from a small Redis sorted set. The set is
    updated by the collector's publish step; it stores the last 1000
    events per tenant with their sequence number as score.

    Audit 2026-07-02 P-18 — switched from LIST/LRANGE (O(N) filter)
    to ZSET/ZRANGEBYSCORE (O(log N + M)) because per-tenant trace
    volume routinely exceeded what a single LRANGE call could
    serve in <50ms.
    """
    redis = await get_redis_client()
    if not redis:
        return []
    set_key = f"observability:replay:{org_id}"
    try:
        try:
            last_seq = int(last_event_id)
        except (TypeError, ValueError):
            return []
        raw = await redis.zrangebyscore(set_key, last_seq + 1, "+inf")
    except Exception as exc:
        logger.debug(f"replay zrangebyscore failed: {exc}")
        return []
    out: list[dict] = []
    for item in raw:
        try:
            seq_str, payload = item.split("|", 1)
            seq = int(seq_str)
            if seq > last_seq:
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
    set_key = f"observability:replay:{org_id}"
    try:
        # Monotonic per-tenant sequence (Redis INCR for atomicity).
        seq = await redis.incr(f"observability:seq:{org_id}")
        # Cap the per-event payload — a 5MB trace would otherwise
        # blow the bounded replay set past Upstash's free-tier
        # command budget. 16 KB is plenty for the live-tail summary
        # (the full trace lives in telemetry_events).
        body = json.dumps(payload, default=str)[:16 * 1024]
        await redis.publish(channel, body)
        # Add to the bounded replay sorted set (audit P-18). Use the
        # sequence number as the member itself so a Redis retry or
        # duplicate INCR can't silently overwrite a different
        # event's payload — pre-fix the member was ``{seq}|{body}``
        # which collides on identical body content and overwrote the
        # score under that member, hiding the prior event.
        await redis.zadd(set_key, {str(seq): seq})
        await redis.zremrangebyrank(set_key, 0, -1001)
    except Exception as exc:
        logger.debug(f"publish_trace_event failed: {exc}")
