"""N11 — publish live span events to Redis pub/sub + buffer."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from eden.observability.live.stream import (
    LIVE_BUFFER_MAX,
    LIVE_FINALIZE_GRACE_S,
    LIVE_META_TTL_S,
    LIVE_RATE_LIMIT_PER_MIN,
    SessionBuffer,
    buffer_key,
    channel_name,
    live_enabled,
    max_sessions_per_org,
    meta_key,
    org_sessions_key,
    seq_key,
)

logger = logging.getLogger(__name__)

# Process-local fallback when Redis is down (SDK HTTP still accepted).
_LOCAL_BUFFERS: dict[str, SessionBuffer] = {}


def _local_key(org_id: str, session_id: str) -> str:
    return f"{org_id}:{session_id}"


class LiveTracePublisher:
    """Publish in-flight span events onto ``trace:live:{org}:{session}``."""

    async def publish(
        self,
        org_id: str,
        session_id: str,
        event: dict[str, Any],
        *,
        force: bool = False,
    ) -> dict[str, Any]:
        if not force and not live_enabled():
            return {"status": "disabled", "feature": "live_trace_streaming_v1"}

        etype = str(event.get("type") or "span_update")
        payload = dict(event)
        payload.setdefault("type", etype)
        payload.setdefault("ts", time.time())
        payload["org_id"] = org_id
        payload["session_id"] = session_id

        redis = await self._redis()
        if redis is None:
            return self._publish_local(org_id, session_id, payload)

        try:
            cap = await self._enforce_session_cap(redis, org_id, session_id)
            if cap is not None:
                return cap
            rate = await self._enforce_rate(redis, org_id, session_id)
            if rate is not None:
                return rate

            event_id = int(await redis.incr(seq_key(org_id, session_id)))
            payload["event_id"] = event_id
            body = json.dumps(payload, default=str)[:16 * 1024]

            ch = channel_name(org_id, session_id)
            await redis.publish(ch, body)

            bkey = buffer_key(org_id, session_id)
            await redis.rpush(bkey, body)
            await redis.ltrim(bkey, -LIVE_BUFFER_MAX, -1)
            await redis.expire(bkey, LIVE_META_TTL_S)
            await redis.expire(seq_key(org_id, session_id), LIVE_META_TTL_S)

            mkey = meta_key(org_id, session_id)
            await redis.hset(
                mkey,
                mapping={
                    "org_id": org_id,
                    "session_id": session_id,
                    "last_event_id": str(event_id),
                    "updated_at": str(time.time()),
                },
            )
            await redis.expire(mkey, LIVE_META_TTL_S)
            await redis.sadd(org_sessions_key(org_id), session_id)
            await redis.expire(org_sessions_key(org_id), LIVE_META_TTL_S)

            return {
                "status": "ok",
                "event_id": event_id,
                "channel": ch,
                "dropped": 0,
            }
        except Exception as exc:
            logger.debug("live publish redis failed: %s", exc)
            return self._publish_local(org_id, session_id, payload)

    async def finalize(
        self,
        org_id: str,
        session_id: str,
        *,
        trace_id: str | None = None,
        step_count: int | None = None,
    ) -> dict[str, Any]:
        """Mark session finalized, publish closing event, schedule channel TTL."""
        if not live_enabled():
            return {"status": "disabled", "feature": "live_trace_streaming_v1"}

        events = await self.drain_buffer(org_id, session_id)
        count = step_count if step_count is not None else len(events)
        tid = trace_id or (events[-1].get("trace_id") if events else session_id)

        close_ev = {
            "type": "trace_finalized",
            "trace_id": tid,
            "step_count": count,
            "session_id": session_id,
        }
        pub = await self.publish(org_id, session_id, close_ev, force=True)

        redis = await self._redis()
        if redis is not None:
            try:
                mkey = meta_key(org_id, session_id)
                await redis.hset(
                    mkey,
                    mapping={
                        "finalized": "1",
                        "trace_id": str(tid or ""),
                        "step_count": str(count),
                        "finalized_at": str(time.time()),
                    },
                )
                await redis.expire(mkey, LIVE_FINALIZE_GRACE_S)
                await redis.expire(
                    buffer_key(org_id, session_id), LIVE_FINALIZE_GRACE_S
                )
                await redis.expire(
                    channel_name(org_id, session_id), LIVE_FINALIZE_GRACE_S
                )
            except Exception as exc:
                logger.debug("live finalize meta failed: %s", exc)

        lk = _local_key(org_id, session_id)
        buf = _LOCAL_BUFFERS.get(lk)
        if buf is not None:
            buf.finalized = True
            buf.finalized_at = time.monotonic()

        return {
            "status": "ok",
            "trace_id": tid,
            "step_count": count,
            "buffered_events": len(events),
            "finalize_event": pub,
            "persisted_once": True,
        }

    async def drain_buffer(
        self, org_id: str, session_id: str
    ) -> list[dict[str, Any]]:
        redis = await self._redis()
        if redis is None:
            buf = _LOCAL_BUFFERS.get(_local_key(org_id, session_id))
            return list(buf.events) if buf else []
        try:
            raw = await redis.lrange(buffer_key(org_id, session_id), 0, -1)
        except Exception:
            buf = _LOCAL_BUFFERS.get(_local_key(org_id, session_id))
            return list(buf.events) if buf else []
        out: list[dict[str, Any]] = []
        for item in raw or []:
            try:
                out.append(json.loads(item))
            except (TypeError, ValueError):
                continue
        return out

    def _publish_local(
        self, org_id: str, session_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        lk = _local_key(org_id, session_id)
        buf = _LOCAL_BUFFERS.setdefault(lk, SessionBuffer())
        before = buf.dropped
        event_id = len(buf.events) + buf.dropped + 1
        payload = {**payload, "event_id": event_id}
        buf.append(payload)
        return {
            "status": "ok",
            "event_id": event_id,
            "channel": channel_name(org_id, session_id),
            "transport": "local",
            "dropped": buf.dropped - before,
        }

    async def _enforce_session_cap(
        self, redis: Any, org_id: str, session_id: str
    ) -> dict[str, Any] | None:
        try:
            members = await redis.smembers(org_sessions_key(org_id))
            active = {m.decode() if isinstance(m, bytes) else str(m) for m in (members or [])}
            if session_id not in active and len(active) >= max_sessions_per_org():
                return {
                    "status": "error",
                    "code": "session_cap",
                    "message": f"Org live session cap ({max_sessions_per_org()}) reached",
                }
        except Exception:
            return None
        return None

    async def _enforce_rate(
        self, redis: Any, org_id: str, session_id: str
    ) -> dict[str, Any] | None:
        try:
            key = f"trace:live:rate:{org_id}:{session_id}"
            n = int(await redis.incr(key))
            if n == 1:
                await redis.expire(key, 60)
            if n > LIVE_RATE_LIMIT_PER_MIN:
                return {
                    "status": "error",
                    "code": "rate_limited",
                    "message": "1000 events/min/session exceeded",
                }
        except Exception:
            return None
        return None

    async def _redis(self) -> Any | None:
        try:
            from eden.storage.redis import get_redis_client

            return await get_redis_client()
        except Exception:
            return None
