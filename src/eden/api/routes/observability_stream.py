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
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from eden.api.deps import require_path_org_access
from eden.observability.ingest_hot_path_metrics import (
    record_ingest_redis_commands,
    record_sse_publish_skipped,
)
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/observability/sse",
    tags=["observability"],
    dependencies=[Depends(require_path_org_access)],
)

# Process-local NUMSUB cache. Idle orgs pay 1 NUMSUB every
# ``_NUMSUB_CACHE_TTL_S`` instead of 1 per ingested event — the
# dominant Upstash Free burn on the ingest path when no SSE client
# is listening. A short TTL keeps new subscribers from waiting long.
_NUMSUB_CACHE_TTL_S = 2.0
_numsub_cache: dict[str, tuple[int, float]] = {}


def _dump_payload(payload: dict[str, Any]) -> str:
    """Prefer A4 jsonx when present; fall back to compact stdlib JSON."""
    try:
        from eden.util.jsonx import dumps as _jsonx_dumps

        return _jsonx_dumps(payload)
    except Exception:
        return json.dumps(payload, default=str)


@router.get("/stream")
async def stream_traces(
    org_id: str = Depends(require_path_org_access),
    last_event_id: str | None = Query(
        None,
        description="Last-Event-ID for resume",
    ),
) -> StreamingResponse:
    """Stream new trace events as SSE.

    Each SSE message is a JSON object with the same shape as the
    list endpoint. The ``id`` field is monotonic within a tenant's
    stream so the client can resume via Last-Event-ID.
    """
    return StreamingResponse(
        _event_stream(org_id, last_event_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


_MAX_REPLAY_GAP = 1000
# Align with portal Vercel SSE proxies (maxDuration=300 on
# ``/api/orgs/.../observability/stream`` and live events). Ending here
# emits ``stream_duration_exceeded`` so the client fails open cleanly
# instead of the platform hard-killing the proxy mid-stream.
_STREAM_MAX_DURATION_S = 300
_STREAM_MAX_EVENTS = 10_000


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

    started_at = time.monotonic()
    events_sent = 0

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
                # Must match ``seq_key`` written by publish_trace_event
                # (``observability:seq:{org}``). Pre-fix this read
                # ``observability:replay:seq:{org}`` and always fell
                # back to the local seq counter.
                raw_seq = await redis.get(
                    f"observability:seq:{org_id}"
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
        # events newer than that from a short-lived list. Use the
        # Redis seq stored with each ZSET member as the SSE ``id`` so
        # Last-Event-ID resume stays aligned with publish_trace_event.
        if last_event_id is not None:
            backfilled = await _replay_since(org_id, last_event_id)
            for ev_seq, ev in backfilled:
                events_sent += 1
                yield _format_sse(
                    "trace", json.dumps(ev, default=str), event_id=str(ev_seq)
                )

        while True:
            if time.monotonic() - started_at >= _STREAM_MAX_DURATION_S:
                yield _format_sse(
                    "error",
                    json.dumps(
                        {
                            "code": "stream_duration_exceeded",
                            "message": (
                                "SSE stream exceeded the 300s bound "
                                "(portal Vercel maxDuration)."
                            ),
                        }
                    ),
                )
                break
            if events_sent >= _STREAM_MAX_EVENTS:
                yield _format_sse(
                    "error",
                    json.dumps(
                        {
                            "code": "stream_event_cap",
                            "message": (
                                f"SSE stream exceeded the {_STREAM_MAX_EVENTS}-event cap."
                            ),
                        }
                    ),
                )
                break
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
            raw = msg.get("data")
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            if not raw:
                continue
            # Prefer ``{seq}|{payload}`` from publish_trace_event so
            # the SSE ``id`` matches the Redis counter used by
            # Last-Event-ID resume. Fall back to plain JSON + local
            # counter for any legacy publishers.
            try:
                if "|" in raw:
                    seq_str, payload_str = raw.split("|", 1)
                    redis_seq = int(seq_str)
                    payload = json.loads(payload_str)
                else:
                    payload = json.loads(raw)
                    seq += 1
                    redis_seq = seq
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            events_sent += 1
            yield _format_sse(
                "trace",
                json.dumps(payload, default=str),
                event_id=str(redis_seq),
            )
    except asyncio.CancelledError:
        # Client disconnected.
        raise
    except Exception as exc:
        logger.debug(f"observability stream error for {org_id}: {exc}")
        # Emit a terminal SSE error so the portal fails open instead of
        # treating a silent close as a transient disconnect + reconnect.
        yield _format_sse(
            "error",
            json.dumps(
                {
                    "code": "stream_interrupted",
                    "message": "Realtime stream interrupted; falling back to REST.",
                }
            ),
        )
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



async def _replay_since(org_id: str, last_event_id: str) -> list[tuple[int, dict]]:
    """Replay missed events from a small Redis sorted set. The set is
    updated by the collector's publish step; it stores the last 1000
    events per tenant with their sequence number as score.

    Returns ``(redis_seq, payload)`` tuples so the SSE generator can
    emit the same ``id`` the publisher wrote — required for
    Last-Event-ID resume across reconnects.

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
    out: list[tuple[int, dict]] = []
    for item in raw:
        try:
            seq_str, payload = item.split("|", 1)
            seq = int(seq_str)
            if seq > last_seq:
                out.append((seq, json.loads(payload)))
        except (ValueError, json.JSONDecodeError):
            continue
    return out


# ── Helper for the collector to publish to the stream ────────────────


async def publish_trace_event(org_id: str, payload: dict[str, Any]) -> None:
    """Publish a new trace event to the per-tenant SSE channel.

    Called by ``TelemetryCollector._route_redis`` (or anywhere
    that wants to push a trace summary to live-tail subscribers).
    The payload should match the shape of the trace list endpoint
    (``trace_id, realm, agent_id, started_at, outcome, span_count,
    duration_ms, streaming_metrics``).

    When PUBSUB NUMSUB is 0, live ``PUBLISH`` is skipped
    (``eden_sse_publish_skipped``) but the replay ZSET is still
    updated so Last-Event-ID resume works after a quiet reconnect.
    NUMSUB results are cached briefly in-process so idle orgs don't
    burn 1 Redis cmd per ingest event. With subscribers, cmds are
    pipelined to cut Redis round-trips.
    """
    redis = await get_redis_client()
    if not redis:
        return
    channel = f"observability:stream:{org_id}"
    set_key = f"observability:replay:{org_id}"
    seq_key = f"observability:seq:{org_id}"
    try:
        now = time.monotonic()
        cached = _numsub_cache.get(channel)
        if cached is not None and cached[1] > now:
            sub_count = cached[0]
        else:
            # NUMSUB — one cheap cmd; skip live PUBLISH when nobody listens.
            numsub = await redis.pubsub_numsub(channel)
            record_ingest_redis_commands(1)
            sub_count = 0
            if numsub:
                entry = numsub[0]
                if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                    sub_count = int(entry[1])
                else:
                    sub_count = int(entry)
            _numsub_cache[channel] = (sub_count, now + _NUMSUB_CACHE_TTL_S)
            # Bound cache size — rare org churn.
            if len(_numsub_cache) > 4096:
                expired = [k for k, (_, exp) in _numsub_cache.items() if exp <= now]
                for k in expired:
                    _numsub_cache.pop(k, None)

        body = _dump_payload(payload)[:16 * 1024]
        # INCR must resolve before ZADD member; then pipeline the rest.
        # Member format is ``{seq}|{payload}`` so ``_replay_since`` can
        # split and rehydrate JSON (score alone is not enough). Publish
        # the same member string on the channel so live SSE ``id``s
        # match Redis seq (Last-Event-ID resume).
        seq = int(await redis.incr(seq_key))
        member = f"{seq}|{body}"
        pipe = redis.pipeline(transaction=False)
        if sub_count > 0:
            pipe.publish(channel, member)
        else:
            record_sse_publish_skipped()
        pipe.zadd(set_key, {member: float(seq)})
        pipe.expire(set_key, 24 * 3600)
        pipe.expire(seq_key, 24 * 3600)
        pipe.zremrangebyrank(set_key, 0, -1001)
        await pipe.execute()
        # incr + (optional publish) + zadd + 2 expire + zremrangebyrank
        record_ingest_redis_commands(5 if sub_count <= 0 else 6)
    except Exception as exc:
        logger.debug(f"publish_trace_event failed: {exc}")
