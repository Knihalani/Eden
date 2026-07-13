"""Change impact preview API (N04)."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.change_impact.preview import (
    ImpactPreviewOrchestrator,
    format_pr_comment,
)

logger = logging.getLogger(__name__)

_FLAG = "change_impact_preview_v1"

router = APIRouter(
    prefix="/orgs/{org_id}/change-impact",
    tags=["change-impact"],
    dependencies=[
        Depends(require_feature_flag(_FLAG)),
        Depends(get_current_user),
    ],
)

_orchestrator = ImpactPreviewOrchestrator()


def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"ci_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


class PreviewRequest(BaseModel):
    change_id: str = Field(..., min_length=1)
    changed_files: list[str] = Field(default_factory=list)
    agent_id: str | None = None
    trace_ids: list[str] | None = None


@router.post("/preview")
async def preview_change(
    org_id: str = Path(...),
    body: PreviewRequest = Body(...),
) -> dict[str, Any]:
    report = await _orchestrator.generate_report(
        org_id,
        change_id=body.change_id,
        changed_files=body.changed_files,
        agent_id=body.agent_id,
        trace_ids=body.trace_ids,
    )
    return _ok(
        "change_impact",
        {
            "report": report.to_dict(),
            "pr_comment": format_pr_comment(report),
        },
    )


@router.get("/{change_id}")
async def get_impact_report(
    org_id: str = Path(...), change_id: str = Path(...)
) -> dict[str, Any]:
    report = await _orchestrator.get_report(org_id, change_id)
    if report is None:
        return {
            "status": "not_found",
            "feature": "change_impact",
            "live": True,
            "data": {"change_id": change_id},
        }
    return _ok(
        "change_impact",
        {"report": report.to_dict(), "pr_comment": format_pr_comment(report)},
    )
