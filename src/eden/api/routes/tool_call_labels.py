"""F21 — tool call label API routes."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_org_member
from eden.learning.tool_call_labels import ToolCallLabelCreate, ToolCallLabelService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/tool-calls",
    tags=["tool-call-labels"],
    dependencies=[Depends(get_current_user)],
)

_svc = ToolCallLabelService()


class LabelToolCallRequest(BaseModel):
    trace_id: str
    tool_name: str
    label: str = Field(..., pattern="^(good|bad)$")
    reason: str | None = None
    agent_id: str | None = None
    args_summary: str | None = None


@router.post("/{span_id}/label")
async def label_tool_call(
    org_id: str = Path(...),
    span_id: str = Path(...),
    body: LabelToolCallRequest = Body(...),
    user: dict = Depends(require_org_member),
) -> dict[str, Any]:
    labeled_by = str(user.get("sub") or user.get("user_id") or "")
    result = await _svc.create_label(
        ToolCallLabelCreate(
            org_id=org_id,
            span_id=span_id,
            trace_id=body.trace_id,
            tool_name=body.tool_name,
            label=body.label,
            reason=body.reason,
            agent_id=body.agent_id,
            args_summary=body.args_summary,
            labeled_by=labeled_by or None,
        )
    )
    return {"status": "ok", "feature": "tool_call_labels", "live": True, "data": result}


@router.delete("/{span_id}/label")
async def delete_tool_call_label(
    org_id: str = Path(...),
    span_id: str = Path(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    deleted = await _svc.delete_label(org_id, span_id)
    return {
        "status": "ok",
        "feature": "tool_call_labels",
        "live": True,
        "data": {"deleted": deleted},
    }


@router.get("/agents/{agent_id}/labels")
async def list_tool_labels(
    org_id: str = Path(...),
    agent_id: str = Path(...),
    tool_name: str | None = None,
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    rows = await _svc.list_for_agent(org_id, agent_id, tool_name=tool_name)
    return {
        "status": "ok",
        "feature": "tool_call_labels",
        "live": True,
        "data": rows,
        "count": len(rows),
    }
