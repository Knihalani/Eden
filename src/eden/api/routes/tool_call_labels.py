"""F21 — tool call label API routes."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.learning.tool_call_calibrator import list_calibrators, train_and_persist
from eden.learning.tool_call_labels import ToolCallLabelCreate, ToolCallLabelService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/tool-calls",
    tags=["tool-call-labels"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_feature_flag("tool_call_label_learning_v1")),
        Depends(require_path_org_access),
    ],
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
    span_id: str = Path(...),
    body: LabelToolCallRequest = Body(...),
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
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
    train_hint = None
    if body.agent_id and await _svc.should_train(org_id, body.agent_id, body.tool_name):
        try:
            train_hint = await train_and_persist(org_id, body.agent_id, body.tool_name)
        except Exception as exc:
            logger.debug("calibrator train skipped: %s", redact_all(str(exc)))
            train_hint = {"status": "train_error", "error": str(exc)}
    return {
        "status": "ok",
        "feature": "tool_call_labels",
        "live": True,
        "data": result,
        "calibrator": train_hint,
    }


@router.delete("/{span_id}/label")
async def delete_tool_call_label(
    span_id: str = Path(...),
    org_id: str = Depends(require_path_org_access),
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
    agent_id: str = Path(...),
    tool_name: str | None = None,
    org_id: str = Depends(require_path_org_access),
) -> dict[str, Any]:
    rows = await _svc.list_for_agent(org_id, agent_id, tool_name=tool_name)
    return {
        "status": "ok",
        "feature": "tool_call_labels",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


@router.get("/agents/{agent_id}/tool-calibrators")
async def get_tool_calibrators(
    agent_id: str = Path(...),
    org_id: str = Depends(require_path_org_access),
) -> dict[str, Any]:
    rows = await list_calibrators(org_id, agent_id)
    return {
        "status": "ok",
        "feature": "tool_call_labels",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


@router.post("/agents/{agent_id}/tool-calibrators/retrain")
async def retrain_tool_calibrator(
    agent_id: str = Path(...),
    body: dict[str, Any] = Body(default_factory=dict),
    org_id: str = Depends(require_path_org_access),
) -> dict[str, Any]:
    tool_name = str(body.get("tool_name") or "")
    if not tool_name:
        return {"status": "error", "error": "tool_name required"}
    result = await train_and_persist(org_id, agent_id, tool_name)
    return {"status": "ok", "feature": "tool_call_labels", "live": True, "data": result}
