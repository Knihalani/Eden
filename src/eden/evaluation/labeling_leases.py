"""Labeling lease + pairwise helpers (W18 soft close)."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)

try:
    from eden.observability.simple_metrics import Counter as _MetricsCounter
except Exception:  # noqa: BLE001 — metrics are best-effort
    _MetricsCounter = None  # type: ignore[misc, assignment]

_DEFAULT_LEASE_TTL = 900  # 15 min
_memory_leases: dict[str, tuple[str, float]] = {}
_memory_fallback_total: int = 0

if _MetricsCounter is not None:
    _MEMORY_FALLBACK_COUNTER = _MetricsCounter(
        "eden_labeling_lease_memory_fallback_total",
        "Labeling lease ops that used in-process memory fallback (Redis unavailable)",
        labelnames=("operation",),
    )
else:
    _MEMORY_FALLBACK_COUNTER = None  # type: ignore[assignment]


def _record_memory_fallback(operation: str, exc: Exception | None = None) -> None:
    """Log and count in-memory lease fallback — exclusivity is process-local only."""
    global _memory_fallback_total
    _memory_fallback_total += 1
    if _MEMORY_FALLBACK_COUNTER is not None:
        _MEMORY_FALLBACK_COUNTER.labels(operation=operation).inc()
    logger.warning(
        "labeling lease exclusivity degraded: using in-memory fallback for %s "
        "(redis unavailable; cross-instance exclusivity not guaranteed; "
        "fallback_total=%d)",
        operation,
        _memory_fallback_total,
        exc_info=exc,
    )


def lease_ttl_seconds() -> int:
    raw = os.getenv("EDEN_LABELING_LEASE_TTL_SECONDS", str(_DEFAULT_LEASE_TTL))
    try:
        return max(30, int(raw))
    except ValueError:
        return _DEFAULT_LEASE_TTL


def _lease_key(org_id: str, item_id: str) -> str:
    return f"labeling:lease:{org_id}:{item_id}"


async def claim_lease(org_id: str, item_id: str, annotator_id: str) -> bool:
    """Claim an exclusive annotation lease. Returns False if held by another."""
    key = _lease_key(org_id, item_id)
    ttl = lease_ttl_seconds()
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is not None:
            ok = await redis.set(key, annotator_id, nx=True, ex=ttl)
            if ok:
                return True
            holder = await redis.get(key)
            if holder is None:
                return bool(await redis.set(key, annotator_id, nx=True, ex=ttl))
            return str(holder) == str(annotator_id)
        _record_memory_fallback("claim_lease")
    except Exception as exc:
        _record_memory_fallback("claim_lease", exc)

    now = time.time()
    holder, exp = _memory_leases.get(key, ("", 0.0))
    if holder and exp > now and holder != annotator_id:
        return False
    _memory_leases[key] = (annotator_id, now + ttl)
    return True


async def has_active_lease(org_id: str, item_id: str) -> bool:
    """Return True when an exclusive lease is currently held (Redis or memory)."""
    key = _lease_key(org_id, item_id)
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is not None:
            holder = await redis.get(key)
            return holder is not None
        _record_memory_fallback("has_active_lease")
    except Exception as exc:
        _record_memory_fallback("has_active_lease", exc)

    holder, exp = _memory_leases.get(key, ("", 0.0))
    return bool(holder) and exp > time.time()


async def release_lease(org_id: str, item_id: str, annotator_id: str) -> None:
    key = _lease_key(org_id, item_id)
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is not None:
            holder = await redis.get(key)
            if holder is None or str(holder) == str(annotator_id):
                await redis.delete(key)
            return
        _record_memory_fallback("release_lease")
    except Exception as exc:
        _record_memory_fallback("release_lease", exc)
    holder, _exp = _memory_leases.get(key, ("", 0.0))
    if holder == annotator_id or not holder:
        _memory_leases.pop(key, None)


def build_pairwise_payload(
    *,
    left: dict[str, Any],
    right: dict[str, Any],
    criterion: str = "overall_quality",
) -> dict[str, Any]:
    """Schema payload for pairwise A/B labeling (F50)."""
    return {
        "type": "pairwise",
        "criterion": criterion,
        "left": left,
        "right": right,
        "options": ["left", "right", "tie"],
    }


def pairwise_winner_from_label(label: Any) -> str | None:
    """Normalize pairwise annotation to left|right|tie."""
    if isinstance(label, dict):
        if "winner" in label:
            w = str(label["winner"]).lower()
            return w if w in ("left", "right", "tie") else None
        if "value" in label:
            return pairwise_winner_from_label(label["value"])
    if isinstance(label, str):
        w = label.strip().lower()
        if w in ("left", "right", "tie", "a", "b"):
            return {"a": "left", "b": "right"}.get(w, w)
    return None


__all__ = [
    "build_pairwise_payload",
    "claim_lease",
    "has_active_lease",
    "lease_ttl_seconds",
    "pairwise_winner_from_label",
    "release_lease",
    "_memory_fallback_total",
]
