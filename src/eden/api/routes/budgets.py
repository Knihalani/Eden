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

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_org_owner, require_path_org_access
from eden.services import budget_service

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/budget",
    tags=["budget"],
    dependencies=[Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


class UpsertBudgetRequest(BaseModel):
    cost_soft_limit_usd: float = Field(..., ge=0)
    cost_hard_limit_usd: float = Field(..., ge=0)
    enforcement_enabled: bool = True
    window: str = Field(default="monthly", pattern="^(daily|weekly|monthly)$")
    action_on_exceed: str = Field(
        default="throttle", pattern="^(throttle|kill|alert)$"
    )
    threshold_alert_pct: int = Field(default=80, ge=0, le=100)
    alert_thresholds: list[int] = Field(default_factory=lambda: [50, 80, 100])
    # FEAT-47: optional team/agent scope. Defaults to the org-level
    # budget, matching the pre-FEAT-47 behavior.
    scope_type: str = Field(default="org", pattern="^[a-z_]{1,16}$")
    scope_id: str | None = Field(default=None, max_length=128)


@router.get("")
async def get_budget(
    org_id: str = Depends(require_path_org_access),
    scope_type: str = Query(default="org"),
    scope_id: str | None = Query(default=None),
) -> dict[str, Any]:
    """Read the per-org budget config + current window consumption.

    ``scope_type``/``scope_id`` (FEAT-47) read a team/agent-scoped
    budget instead of the org-level one; both default to the
    org-level scope.
    """
    budget = await budget_service.get_budget(org_id, scope_type=scope_type, scope_id=scope_id)
    consumption = await budget_service.get_consumption(
        org_id, window=budget["window"], scope_type=scope_type, scope_id=scope_id
    )
    cost_used = consumption["cost_usd"]
    cost_soft = budget["cost_soft_limit_usd"]
    cost_hard = budget["cost_hard_limit_usd"]
    pct_of_hard = (cost_used / cost_hard * 100.0) if cost_hard > 0 else 0.0
    thresholds = list(budget.get("alert_thresholds") or [50, 80, 100])
    breached = [t for t in thresholds if pct_of_hard >= float(t)]
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
                "alert_thresholds": thresholds,
                "thresholds_breached": breached,
                "alert_breached": pct_of_hard >= budget["threshold_alert_pct"],
                "exceeded": pct_of_hard >= 100.0,
            },
        },
    }


@router.post("")
async def upsert_budget(
    org_id: str = Depends(require_path_org_access),
    body: UpsertBudgetRequest = Body(...),
    _user: dict = Depends(require_org_owner),
) -> dict[str, Any]:
    """Upsert the per-org (optionally team/agent-scoped) budget config.

    Org-owner gated.
    """
    persisted = await budget_service.upsert_budget(
        org_id,
        cost_soft_limit_usd=body.cost_soft_limit_usd,
        cost_hard_limit_usd=body.cost_hard_limit_usd,
        enforcement_enabled=body.enforcement_enabled,
        window=body.window,
        action_on_exceed=body.action_on_exceed,
        threshold_alert_pct=body.threshold_alert_pct,
        alert_thresholds=body.alert_thresholds or [50, 80, 100],
        scope_type=body.scope_type,
        scope_id=body.scope_id,
    )
    return {
        "status": "ok",
        "feature": "budget_admin",
        "live": True,
        "data": persisted,
    }


@router.get("/ticker")
async def ticker(
    org_id: str = Depends(require_path_org_access),
    scope_type: str = Query(default="org"),
    scope_id: str | None = Query(default=None),
) -> dict[str, Any]:
    """Real-time budget ticker (consumption + recent actions).

    The portal polls this every 5s for the live ticker card.
    ``scope_type``/``scope_id`` (FEAT-47) narrow the ticker to a
    team/agent-scoped budget; both default to the org-level scope.
    """
    budget = await budget_service.get_budget(org_id, scope_type=scope_type, scope_id=scope_id)
    consumption = await budget_service.get_consumption(
        org_id, window=budget["window"], scope_type=scope_type, scope_id=scope_id
    )
    actions = await budget_service.list_actions(
        org_id, limit=10, scope_type=scope_type, scope_id=scope_id
    )
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
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=500),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None),
) -> dict[str, Any]:
    """Paginated audit log of threshold/exceeded events.

    ``scope_type`` (FEAT-47) filters to a single scope's actions;
    left unset (the default) it returns actions across every scope
    for the org, matching the pre-FEAT-47 behavior.
    """
    actions = await budget_service.list_actions(
        org_id, limit=limit, scope_type=scope_type, scope_id=scope_id
    )
    return {
        "status": "ok",
        "feature": "budget_actions",
        "live": True,
        "data": {"actions": actions, "count": len(actions)},
    }
