"""F64 — agentic metrics pack API (Home + Fleet)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Path, Query

from eden.api.deps import get_current_user, require_org_member
from eden.evaluation.agentic_metrics import AgenticMetricsService

router = APIRouter(
    prefix="/orgs/{org_id}/agentic-metrics",
    tags=["agentic-metrics"],
    dependencies=[Depends(get_current_user), Depends(require_org_member)],
)
_svc = AgenticMetricsService()


def _ok(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": "f64_agentic_metrics",
        "live": True,
        "trace_id": f"am_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


@router.get("/summary")
async def agentic_metrics_summary(
    org_id: str = Path(...),
    agent_id: str | None = Query(None),
    window_hours: int = Query(24, ge=1, le=720),
) -> dict[str, Any]:
    data = await _svc.summary(
        org_id, agent_id=agent_id, window_hours=window_hours
    )
    return _ok(data)
