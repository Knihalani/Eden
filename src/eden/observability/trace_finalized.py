"""``trace.finalized`` Redis stream (F20 auto-detection trigger).

Emitted (best-effort) by the telemetry collector when a trace reaches a
terminal event. The :mod:`eden.workers.trace_finalized_consumer` reads
this global stream, runs :class:`~eden.issues.auto_scanner.AutoIssueScanner`
per trace, and writes any stumbles.

Topology decision (recorded in the PR): a **single global stream** keyed
``trace.finalized`` with the ``org_id`` carried in the payload — mirrors
the existing ``eden_alerts`` pattern and keeps consumer-group management
to one stream. Emission is idempotent-friendly: the consumer + stumble
dedup absorb duplicate finalize signals for the same trace.
"""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

TRACE_FINALIZED_STREAM = "trace.finalized"
TRACE_FINALIZED_DLQ_STREAM = "trace.finalized.dlq"
_STREAM_MAXLEN = 100_000
# One XADD per (org, trace) — terminal events often fire twice
# (span.end + session.end). Process-local + Redis SETNX coalesce.
_EMIT_DEDUP_TTL_S = 3600
_emitted_local: dict[str, float] = {}

# Event types that unambiguously mark the end of a trace/session/run.
_TERMINAL_TYPES = {
    "trace.end",
    "trace.finalized",
    "session.end",
    "agent.finish",
    "agent.end",
    "run.end",
    "workflow.end",
}


def is_finalizing_event(event: Any) -> bool:
    """Return True when ``event`` marks a trace as finalized.

    Accepts either a ``TelemetryEvent`` (attribute access) or a plain
    dict. A root ``span.end`` (no ``parent_span_id``) also counts, since
    the root span closing means the trace is complete.
    """
    et = _get(event, "event_type")
    if not et:
        return False
    et = str(et).lower()
    if et in _TERMINAL_TYPES:
        return True
    return et in ("span.end", "span") and not _get(event, "parent_span_id")


def _get(event: Any, key: str) -> Any:
    if isinstance(event, dict):
        return event.get(key)
    return getattr(event, key, None)


async def emit_trace_finalized(
    *,
    org_id: str,
    trace_id: str,
    agent_id: str | None = None,
    session_id: str | None = None,
    user_id: str | None = None,
    redis: Any | None = None,
) -> bool:
    """XADD a ``trace.finalized`` entry. Best-effort; never raises.

    Coalesces to one emit per ``(org_id, trace_id)`` within an hour so
    multi-terminal traces (root span.end + session.end) do not double
    bill Upstash XADD / double-wake the consumer.
    """
    try:
        oid = org_id or ""
        tid = trace_id or ""
        if not oid or not tid:
            return False
        dedup_key = f"{oid}:{tid}"
        now_mono = time.monotonic()
        exp = _emitted_local.get(dedup_key)
        if exp is not None and exp > now_mono:
            return False

        if redis is None:
            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
        if redis is None:
            return False

        claimed = await redis.set(
            f"trace.finalized:emitted:{dedup_key}",
            "1",
            nx=True,
            ex=_EMIT_DEDUP_TTL_S,
        )
        if not claimed:
            _emitted_local[dedup_key] = now_mono + float(_EMIT_DEDUP_TTL_S)
            return False

        await redis.xadd(
            TRACE_FINALIZED_STREAM,
            {
                "org_id": oid,
                "trace_id": tid,
                "agent_id": agent_id or "",
                "session_id": session_id or "",
                "user_id": user_id or "",
                "finalized_at": str(time.time()),
            },
            maxlen=_STREAM_MAXLEN,
            approximate=True,
        )
        _emitted_local[dedup_key] = now_mono + float(_EMIT_DEDUP_TTL_S)
        if len(_emitted_local) > 8192:
            stale = [k for k, e in _emitted_local.items() if e <= now_mono]
            for k in stale:
                _emitted_local.pop(k, None)
        return True
    except Exception as exc:  # pragma: no cover - redis optional
        logger.debug("trace_finalized: emit failed: %s", exc)
        return False


async def maybe_emit_trace_finalized(event: Any, redis: Any | None = None) -> bool:
    """Emit ``trace.finalized`` for a terminal event, gated by the
    ``auto_issue_detection_v1`` flag. Cheap no-op for non-terminal
    events so it is safe to call on the per-event hot path."""
    if not is_finalizing_event(event):
        return False
    try:
        from eden.config import get_settings

        if not getattr(get_settings(), "auto_issue_detection_v1", True):
            return False
    except Exception:
        pass
    attrs = _get(event, "attributes") or {}
    return await emit_trace_finalized(
        org_id=_get(event, "tenant_id") or _get(event, "org_id") or "",
        trace_id=_get(event, "trace_id") or "",
        agent_id=_get(event, "agent_id"),
        session_id=attrs.get("session_id") if isinstance(attrs, dict) else None,
        user_id=attrs.get("user_id") if isinstance(attrs, dict) else None,
        redis=redis,
    )
