"""N06 agent compliance pack routes."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.governance.compliance_pack import (
    AgentAuditLedgerWriter,
    CompliancePackGenerator,
)

_FLAG = "compliance_pack_export_v1"
router = APIRouter(
    prefix="/orgs/{org_id}/compliance",
    tags=["compliance-pack"],
    dependencies=[
        Depends(require_feature_flag(_FLAG)),
        Depends(get_current_user),
    ],
)
_ledger = AgentAuditLedgerWriter()
_packs = CompliancePackGenerator()


def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"cp_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


class ExportPackRequest(BaseModel):
    period_start: str = Field(..., description="ISO 8601 start")
    period_end: str = Field(..., description="ISO 8601 end")
    framework: str = "soc2_type_ii"


@router.post("/verify")
async def verify_chain(
    org_id: str = Path(...),
    agent_id: str | None = Query(None),
    limit: int = Query(500, ge=1, le=2000),
) -> dict[str, Any]:
    report = await _ledger.verify_chain(org_id, agent_id=agent_id, limit=limit)
    return _ok("agent_audit_ledger_verify", report)


@router.get("/ledger")
async def query_ledger(
    org_id: str = Path(...),
    agent_id: str | None = Query(None),
    event_type: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    events = await _ledger.query(
        org_id, agent_id=agent_id, event_type=event_type, limit=limit
    )
    return _ok("agent_audit_ledger", {"events": events, "count": len(events)})


@router.post("/agents/{agent_id}/export")
async def export_agent_pack(
    org_id: str = Path(...),
    agent_id: str = Path(...),
    body: ExportPackRequest = Body(...),
) -> dict[str, Any]:
    result = await _packs.generate_agent_pack(
        org_id,
        agent_id,
        period_start=body.period_start,
        period_end=body.period_end,
        framework=body.framework,
    )
    return result
