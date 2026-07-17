"""Labeling lease + pairwise helpers (W18 soft close)."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_LEASE_TTL = 900  # 15 min
_memory_leases: dict[str, tuple[str, float]] = {}


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
    except Exception as exc:
        logger.debug("labeling lease redis failed: %s", exc)

    now = time.time()
    holder, exp = _memory_leases.get(key, ("", 0.0))
    if holder and exp > now and holder != annotator_id:
        return False
    _memory_leases[key] = (annotator_id, now + ttl)
    return True


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
    except Exception as exc:
        logger.debug("labeling lease release failed: %s", exc)
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
    "lease_ttl_seconds",
    "pairwise_winner_from_label",
    "release_lease",
]
