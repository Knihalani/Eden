"""N05 fleet health API."""

from __future__ import annotations

import contextlib
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.fleet.service import FleetHealthService

_FLAG = "fleet_health_v1"
router = APIRouter(
    prefix="/orgs/{org_id}/fleet",
    tags=["fleet"],
    dependencies=[
        Depends(require_feature_flag(_FLAG)),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)
_fleet = FleetHealthService()


def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"fl_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


class AgentPatch(BaseModel):
    tier: str | None = None
    display_name: str | None = None


@router.get("/sla-breaches")
async def fleet_sla_breaches(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    return _ok("fleet_health", await _fleet.sla_breaches(org_id))


@router.get("/summary")
async def fleet_summary(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    return _ok("fleet_health", await _fleet.summary(org_id))


@router.get("/heatmap")
async def fleet_heatmap(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    return _ok("fleet_health", await _fleet.heatmap(org_id))


@router.get("/delegation")
async def fleet_delegation(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    return _ok("fleet_health", await _fleet.delegation_graph(org_id))


@router.get("/agents/{agent_id}")
async def get_agent(
    org_id: str = Depends(require_path_org_access), agent_id: str = Path(...)
) -> dict[str, Any]:
    summary = await _fleet.summary(org_id)
    agents = summary.get("agents") or []
    card = next((a for a in agents if a.get("agent_id") == agent_id), None)
    if card is None:
        await _fleet.discover_agent(org_id, agent_id)
        summary = await _fleet.summary(org_id)
        card = next(
            (a for a in summary.get("agents") or [] if a.get("agent_id") == agent_id),
            {"agent_id": agent_id},
        )
    return _ok("fleet_health", {"agent": card})


@router.patch("/agents/{agent_id}")
async def patch_agent(
    org_id: str = Depends(require_path_org_access),
    agent_id: str = Path(...),
    body: AgentPatch = Body(...),
) -> dict[str, Any]:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is not None:
        await _fleet.discover_agent(org_id, agent_id, display_name=body.display_name)
        if body.tier:
            with contextlib.suppress(Exception):
                await client.execute(
                    "UPDATE agent_registry SET tier = $3 "
                    "WHERE org_id = $1 AND agent_id = $2",
                    org_id,
                    agent_id,
                    body.tier,
                )
    return await get_agent(org_id, agent_id)
