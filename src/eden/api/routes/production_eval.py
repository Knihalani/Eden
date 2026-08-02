"""N03 production eval API."""

from __future__ import annotations

import contextlib
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    require_feature_flag,
    require_path_org_access,
)
from eden.evaluation.production.sampler import ProductionEvalSampler

_FLAG = "production_eval_sampling_v1"

router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["production-eval"],
    dependencies=[
        Depends(require_feature_flag(_FLAG)),
        Depends(require_path_org_access),
    ],
)
_sampler = ProductionEvalSampler()

def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"pe_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }

class PolicyPatch(BaseModel):
    sample_rate: float | None = Field(None, ge=0.0, le=1.0)
    max_cost_usd_per_day: float | None = Field(None, ge=0.0)
    enabled: bool | None = None
    agent_id: str | None = None

@router.get("/production-eval/policies")
async def get_policies(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    policy = await _sampler._resolve_policy(org_id, None)
    return _ok("production_eval", {"policy": policy})

@router.patch("/production-eval/policies")
async def patch_policy(
    org_id: str = Depends(require_path_org_access), body: PolicyPatch = Body(...)
) -> dict[str, Any]:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return _ok("production_eval", {"updated": False})
    policy = await _sampler._resolve_policy(org_id, body.agent_id)
    sample_rate = body.sample_rate if body.sample_rate is not None else policy.get("sample_rate", 0.02)
    max_cost = (
        body.max_cost_usd_per_day
        if body.max_cost_usd_per_day is not None
        else policy.get("max_cost_usd_per_day", 50.0)
    )
    enabled = body.enabled if body.enabled is not None else policy.get("enabled", True)
    with contextlib.suppress(Exception):
        await client.execute(
            "INSERT INTO production_eval_policies "
            "(org_id, agent_id, sample_rate, max_cost_usd_per_day, enabled) "
            "VALUES ($1, $2, $3, $4, $5)",
            org_id,
            body.agent_id,
            sample_rate,
            max_cost,
            enabled,
        )
    return _ok(
        "production_eval",
        {
            "updated": True,
            "policy": {
                "sample_rate": sample_rate,
                "max_cost_usd_per_day": max_cost,
                "enabled": enabled,
                "agent_id": body.agent_id,
            },
        },
    )

@router.get("/agents/{agent_id}/quality/trend")
async def quality_trend(
    org_id: str = Depends(require_path_org_access),
    agent_id: str = Path(...),
    hours: int = Query(168, ge=1, le=720),
) -> dict[str, Any]:
    trend = await _sampler.get_quality_trend(org_id, agent_id, hours=hours)
    return _ok("production_eval", {"agent_id": agent_id, "trend": trend})

@router.post("/production-eval/score/{trace_id}")
async def manual_score(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    agent_id: str | None = Query(None),
) -> dict[str, Any]:
    result = await _sampler.maybe_score_trace(
        org_id, trace_id, agent_id=agent_id, is_stumble=True
    )
    return _ok("production_eval", {"result": result})
