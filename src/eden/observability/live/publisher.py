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

# NUMSUB cache + sparse EXPIRE — cut Upstash cmds when nobody is
# live-tailing a session (common for SDK publish without an open UI).
# Process-local: sessions already in the org set skip SISMEMBER/SCARD.
_known_sessions: set[str] = set()
_numsub_cache: dict[str, tuple[int, float]] = {}
_maint_at: dict[str, float] = {}
_MAINT_REFRESH_S = 3600.0
_rate_local: dict[str, tuple[int, float]] = {}


def _local_key(org_id: str, session_id: str) -> str:
    return f"{org_id}:{session_id}"


def _live_write_when_idle() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "redis_live_write_when_idle", False))
    except Exception:
        return False


def _numsub_ttls() -> tuple[float, float]:
    try:
        from eden.config import get_settings

        s = get_settings()
        return (
            float(getattr(s, "redis_sse_numsub_idle_ttl_s", 30.0) or 30.0),
            float(getattr(s, "redis_sse_numsub_active_ttl_s", 2.0) or 2.0),
        )
    except Exception:
        return 30.0, 2.0


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
            ch = channel_name(org_id, session_id)
            write_when_idle = _live_write_when_idle()
            sub_count = await self._subscriber_count(redis, ch)
            if sub_count <= 0 and not write_when_idle and not force:
                # No live UI → skip Redis entirely (rate/cap/buffer).
                return {
                    "status": "ok",
                    "event_id": 0,
                    "channel": ch,
                    "dropped": 0,
                    "skipped": "no_subscribers",
                }

            cap = await self._enforce_session_cap(redis, org_id, session_id)
            if cap is not None:
                return cap
            rate = await self._enforce_rate(redis, org_id, session_id)
            if rate is not None:
                return rate

            event_id = int(await redis.incr(seq_key(org_id, session_id)))
            payload["event_id"] = event_id
            body = json.dumps(payload, default=str)[:16 * 1024]

            bkey = buffer_key(org_id, session_id)
            mkey = meta_key(org_id, session_id)
            skey = seq_key(org_id, session_id)
            okey = org_sessions_key(org_id)
            now = time.monotonic()
            maint_key = f"{org_id}:{session_id}"
            need_maint = (
                maint_key not in _maint_at or now >= _maint_at[maint_key]
            )

            pipe = redis.pipeline(transaction=False)
            if sub_count > 0 or force:
                pipe.publish(ch, body)
            pipe.rpush(bkey, body)
            pipe.ltrim(bkey, -LIVE_BUFFER_MAX, -1)
            pipe.hset(
                mkey,
                mapping={
                    "org_id": org_id,
                    "session_id": session_id,
                    "last_event_id": str(event_id),
                    "updated_at": str(time.time()),
                },
            )
            pipe.sadd(okey, session_id)
            if need_maint:
                pipe.expire(bkey, LIVE_META_TTL_S)
                pipe.expire(skey, LIVE_META_TTL_S)
                pipe.expire(mkey, LIVE_META_TTL_S)
                pipe.expire(okey, LIVE_META_TTL_S)
            await pipe.execute()
            _known_sessions.add(f"{org_id}:{session_id}")
            if len(_known_sessions) > 16_384:
                _known_sessions.clear()
            if need_maint:
                _maint_at[maint_key] = now + _MAINT_REFRESH_S

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
                pipe = redis.pipeline(transaction=False)
                pipe.hset(
                    mkey,
                    mapping={
                        "finalized": "1",
                        "trace_id": str(tid or ""),
                        "step_count": str(count),
                        "finalized_at": str(time.time()),
                    },
                )
                pipe.expire(mkey, LIVE_FINALIZE_GRACE_S)
                pipe.expire(buffer_key(org_id, session_id), LIVE_FINALIZE_GRACE_S)
                await pipe.execute()
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

    async def _subscriber_count(self, redis: Any, channel: str) -> int:
        now = time.monotonic()
        cached = _numsub_cache.get(channel)
        if cached is not None and cached[1] > now:
            return cached[0]
        idle_ttl, active_ttl = _numsub_ttls()
        try:
            numsub = await redis.pubsub_numsub(channel)
            sub_count = 0
            if numsub:
                entry = numsub[0]
                if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                    sub_count = int(entry[1])
                else:
                    sub_count = int(entry)
        except Exception:
            # Fail open: assume a listener so we still buffer.
            return 1
        ttl = active_ttl if sub_count > 0 else idle_ttl
        _numsub_cache[channel] = (sub_count, now + ttl)
        if len(_numsub_cache) > 4096:
            expired = [k for k, (_, exp) in _numsub_cache.items() if exp <= now]
            for k in expired:
                _numsub_cache.pop(k, None)
        return sub_count

    async def _enforce_session_cap(
        self, redis: Any, org_id: str, session_id: str
    ) -> dict[str, Any] | None:
        sk = f"{org_id}:{session_id}"
        if sk in _known_sessions:
            return None
        try:
            # SISMEMBER + SCARD (2 cmds, 1 RTT) instead of SMEMBERS
            # which ships every session id back on every publish.
            okey = org_sessions_key(org_id)
            pipe = redis.pipeline(transaction=False)
            pipe.sismember(okey, session_id)
            pipe.scard(okey)
            is_member, count = await pipe.execute()
            if bool(is_member):
                _known_sessions.add(sk)
                return None
            if int(count or 0) >= max_sessions_per_org():
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
        # Prefer process-local counter on single-replica API (Upstash Free).
        # Fall back to Redis when distributed rate limiting is on.
        try:
            from eden.config import get_settings

            distributed = bool(
                getattr(get_settings(), "rate_limit_distributed", False)
            )
        except Exception:
            distributed = False

        key = f"{org_id}:{session_id}"
        if not distributed:
            now = time.monotonic()
            n, window_start = _rate_local.get(key, (0, now))
            if now - window_start >= 60.0:
                n, window_start = 0, now
            n += 1
            _rate_local[key] = (n, window_start)
            if n > LIVE_RATE_LIMIT_PER_MIN:
                return {
                    "status": "error",
                    "code": "rate_limited",
                    "message": "1000 events/min/session exceeded",
                }
            return None

        try:
            rkey = f"trace:live:rate:{org_id}:{session_id}"
            pipe = redis.pipeline(transaction=False)
            pipe.incr(rkey)
            pipe.expire(rkey, 60)
            n, _ = await pipe.execute()
            if int(n) > LIVE_RATE_LIMIT_PER_MIN:
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
