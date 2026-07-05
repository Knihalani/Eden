"""Budget API routes — D.10 cost guardrails portal surface (upgradespec §C.3).

Endpoints:

* ``GET  /orgs/{org_id}/budget`` — read the per-org budget config + current
  window consumption. The portal renders this as the budget admin card.
* ``POST /orgs/{org_id}/budget`` — upsert the per-org budget config.
  Org-owner gated.
* ``GET  /orgs/{org_id}/budget/ticker`` — current window consumption +
  recent actions (last 50). The portal renders this as a real-time ticker.
* ``GET  /orgs/{org_id}/budget/actions`` — paginated audit log.
  Portal "Recent threshold events" feed.

The middleware enforcement is done by
:class:`QuotaEnforcementMiddleware` via
:class:`UsageService.get_budget_status`; this route is the read +
admin surface.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_org_owner
from eden.services import budget_service

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/budget",
    tags=["budget"],
    dependencies=[Depends(get_current_user)],
)


class UpsertBudgetRequest(BaseModel):
    cost_soft_limit_usd: float = Field(..., ge=0)
    cost_hard_limit_usd: float = Field(..., ge=0)
    enforcement_enabled: bool = False
    window: str = Field(default="monthly", pattern="^(daily|weekly|monthly)$")
    action_on_exceed: str = Field(
        default="throttle", pattern="^(throttle|kill|alert)$"
    )
    threshold_alert_pct: int = Field(default=80, ge=0, le=100)


@router.get("")
async def get_budget(org_id: str = Path(...)) -> dict[str, Any]:
    """Read the per-org budget config + current window consumption."""
    budget = await budget_service.get_budget(org_id)
    consumption = await budget_service.get_consumption(org_id, window=budget["window"])
    cost_used = consumption["cost_usd"]
    cost_soft = budget["cost_soft_limit_usd"]
    cost_hard = budget["cost_hard_limit_usd"]
    pct_of_hard = (cost_used / cost_hard * 100.0) if cost_hard > 0 else 0.0
    return {
        "status": "ok",
        "feature": "budget_admin",
        "live": True,
        "data": {
            "budget": budget,
            "consumption": consumption,
            "rollup": {
                "cost_used_usd": cost_used,
                "cost_soft_limit_usd": cost_soft,
                "cost_hard_limit_usd": cost_hard,
                "pct_of_hard": round(pct_of_hard, 2),
                "threshold_alert_pct": budget["threshold_alert_pct"],
                "alert_breached": pct_of_hard >= budget["threshold_alert_pct"],
                "exceeded": pct_of_hard >= 100.0,
            },
        },
    }


@router.post("")
async def upsert_budget(
    org_id: str = Path(...),
    body: UpsertBudgetRequest = Body(...),
    _user: dict = Depends(require_org_owner),
) -> dict[str, Any]:
    """Upsert the per-org budget config. Org-owner gated."""
    persisted = await budget_service.upsert_budget(
        org_id,
        cost_soft_limit_usd=body.cost_soft_limit_usd,
        cost_hard_limit_usd=body.cost_hard_limit_usd,
        enforcement_enabled=body.enforcement_enabled,
        window=body.window,
        action_on_exceed=body.action_on_exceed,
        threshold_alert_pct=body.threshold_alert_pct,
    )
    return {
        "status": "ok",
        "feature": "budget_admin",
        "live": True,
        "data": persisted,
    }


@router.get("/ticker")
async def ticker(org_id: str = Path(...)) -> dict[str, Any]:
    """Real-time budget ticker (consumption + recent actions).

    The portal polls this every 5s for the live ticker card.
    """
    budget = await budget_service.get_budget(org_id)
    consumption = await budget_service.get_consumption(org_id, window=budget["window"])
    actions = await budget_service.list_actions(org_id, limit=10)
    return {
        "status": "ok",
        "feature": "budget_ticker",
        "live": True,
        "data": {
            "budget": budget,
            "consumption": consumption,
            "recent_actions": actions,
        },
    }


@router.get("/actions")
async def list_actions(
    org_id: str = Path(...),
    limit: int = Query(50, ge=1, le=500),
) -> dict[str, Any]:
    """Paginated audit log of threshold/exceeded events."""
    actions = await budget_service.list_actions(org_id, limit=limit)
    return {
        "status": "ok",
        "feature": "budget_actions",
        "live": True,
        "data": {"actions": actions, "count": len(actions)},
    }
