"""Closed-loop bus liveness probe (M2, D4).

    GET /internal/loop-health

Answers "is the autonomy loop actually alive?" — the F46 bus fails soft
everywhere (publish falls back to the outbox, the consumer retries), so
without this probe a dead Redis looks identical to a quiet system.

Status semantics:

* ``dead`` — no Redis client, or the ``eden.loop.events`` stream is
  missing/unreadable. Nothing published now reaches the orchestrator
  directly (the outbox still buffers).
* ``degraded`` — the stream answers but a publish failed recently or
  undrained outbox rows exist (Redis flapped; replay in progress).
* ``ok`` — stream reachable, no recent failures, empty outbox.

Auth mirrors the Prometheus ``/metrics`` endpoint: constant-time bearer
check against ``metrics_bearer_token`` (the existing pattern for
non-org-scoped ops endpoints; ``/v1/internal/health/*`` relies on the
IP-allowlist middleware instead, which does not cover this path).
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Depends

from eden.observability.metrics_endpoint import _check_metrics_auth

logger = logging.getLogger(__name__)

router = APIRouter(tags=["internal"])

#: A publish failure younger than this marks the bus ``degraded`` even
#: when the stream currently answers (Redis is flapping).
_RECENT_FAILURE_WINDOW_S = 300.0


def _dec(value: Any) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)


def _entry_id_age_s(entry_id: Any, now: float) -> float | None:
    """Age of a Redis stream entry id (``<ms>-<seq>``) in seconds."""
    try:
        ms = int(_dec(entry_id).split("-", 1)[0])
        if ms <= 0:
            return None
        return max(0.0, now - ms / 1000.0)
    except (TypeError, ValueError):
        return None


async def probe_loop_health() -> dict[str, Any]:
    """Build the loop-health snapshot. Never raises."""
    from eden.closed_loop import event_bus

    now = time.time()
    outbox_depth = await event_bus.outbox_depth()
    failure_ts = event_bus.last_publish_failure_ts
    last_publish_failure_age_s = (
        max(0.0, now - failure_ts) if failure_ts else None
    )

    redis = None
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
    except Exception as exc:
        logger.debug("loop-health: redis client init failed: %s", exc)
        redis = None

    bus = "ok"
    last_event_age_s: float | None = None
    consumer_lag: int | None = None
    if redis is None:
        bus = "dead"
    else:
        try:
            info = await redis.xinfo_stream(event_bus.LOOP_STREAM)
            info = {_dec(k): v for k, v in dict(info or {}).items()}
            last_entry = info.get("last-entry") or info.get("last_entry")
            if isinstance(last_entry, (list, tuple)) and last_entry:
                last_event_age_s = _entry_id_age_s(last_entry[0], now)
            elif info.get("last-generated-id") is not None:
                last_event_age_s = _entry_id_age_s(
                    info["last-generated-id"], now
                )
        except Exception as exc:
            logger.debug("loop-health: xinfo stream failed: %s", exc)
            bus = "dead"
        if bus != "dead":
            try:
                groups = await redis.xinfo_groups(event_bus.LOOP_STREAM)
                for group in groups or []:
                    g = {_dec(k): v for k, v in dict(group or {}).items()}
                    if _dec(g.get("name", "")) != event_bus._GROUP:
                        continue
                    raw = g.get("lag")
                    if raw is None:
                        raw = g.get("pending")
                    if raw is not None:
                        consumer_lag = int(raw)
                    break
            except Exception as exc:
                logger.debug("loop-health: xinfo groups failed: %s", exc)

    if bus == "ok" and (
        outbox_depth > 0
        or (
            last_publish_failure_age_s is not None
            and last_publish_failure_age_s < _RECENT_FAILURE_WINDOW_S
        )
    ):
        bus = "degraded"

    return {
        "bus": bus,
        "last_event_age_s": last_event_age_s,
        "consumer_lag": consumer_lag,
        "outbox_depth": outbox_depth,
        "last_publish_failure_age_s": last_publish_failure_age_s,
    }


@router.get(
    "/internal/loop-health", dependencies=[Depends(_check_metrics_auth)]
)
async def loop_health() -> dict[str, Any]:
    return await probe_loop_health()
