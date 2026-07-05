"""Top-level cost summary routes.

Cat 23 audit (2026-06-21): the dashboard "last-month trend" placeholder
needed a real endpoint at ``/orgs/{org}/cost/comparison`` (NOT nested
under ``/optimization``). Lives here so the path matches the portal's
expectation without coupling to ``routes/optimization.py``.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends

from eden.api.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/cost", tags=["cost"])


@router.get("/comparison", response_model=dict)
async def cost_comparison(
    org_id: str,
    _user: dict = Depends(get_current_user),
) -> dict:
    """Compare this calendar month's spend against the previous month.

    Source of truth: the Redis hash ``eden:cost:{org_id}:month:{YYYY-MM}``
    written by :class:`CostTracker` on every tracked event. Returns
    ``previous_month_cents=None`` when either month has no data so the
    portal renders "—" instead of a misleading zero.
    """
    from eden.storage.redis import get_redis_client

    now = datetime.now(UTC)
    if now.month == 1:
        prev_year, prev_month = now.year - 1, 12
    else:
        prev_year, prev_month = now.year, now.month - 1
    curr_key = f"{now.year:04d}-{now.month:02d}"
    prev_key = f"{prev_year:04d}-{prev_month:02d}"

    current_cents: float | None = None
    previous_cents: float | None = None
    try:
        redis = await get_redis_client()
    except Exception as exc:  # noqa: BLE001
        logger.warning("cost_comparison: redis unavailable: %s", exc)
        redis = None
    if redis is not None:
        try:
            cur_raw, prev_raw = await redis.mget(
                f"eden:cost:{org_id}:month:{curr_key}",
                f"eden:cost:{org_id}:month:{prev_key}",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("cost_comparison: redis mget failed: %s", exc)
            cur_raw = prev_raw = None
        if cur_raw is not None:
            current_cents = float(cur_raw)
        if prev_raw is not None:
            previous_cents = float(prev_raw)

    delta_cents: float | None = None
    delta_pct: float | None = None
    if current_cents is not None and previous_cents is not None:
        delta_cents = current_cents - previous_cents
        if previous_cents:
            delta_pct = round((delta_cents / previous_cents) * 100, 2)

    return {
        "org_id": org_id,
        "current_month": curr_key,
        "previous_month": prev_key,
        "current_month_cents": current_cents,
        "previous_month_cents": previous_cents,
        "delta_cents": delta_cents,
        "delta_pct": delta_pct,
    }
