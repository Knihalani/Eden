"""Computer Use routes — D.12.3 (§8.3, §C.8).

Routes (per spec §C.8):

* ``GET  /v1/traces/{trace_id}/computer_use`` — return the
  steps (with screenshot URIs) for a trace.
* ``POST /v1/computer_use/{org_id}/steps`` — record a
  step (SDK path; org-member gated).
* ``POST /v1/computer_use/{org_id}/screenshots/tombstone`` —
  mark a screenshot URI for RTBF purge (org-admin gated).
* ``GET  /v1/computer_use/{org_id}/screenshots/tombstoned/{trace_id}`` —
  list tombstoned screenshots for a trace (org-member gated).

The hook fires from inside the service on
``record_step(blocked=True)`` — the route layer doesn't
have to remember to fire it.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_org_member,
)
from eden.services.observability import ACTION_TYPES, get_computer_use_service

logger = logging.getLogger(__name__)

router = APIRouter(
    tags=["observability-computer-use"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)


class RecordStepRequest(BaseModel):
    trace_id: str
    span_id: str
    step_index: int = Field(..., ge=0)
    action_type: str
    action_payload: dict[str, Any] = Field(default_factory=dict)
    screenshot_before: str | None = None
    screenshot_after: str | None = None
    target_app: str | None = None
    target_coords: dict[str, Any] | None = None
    success: bool | None = None
    error: str | None = None
    duration_ms: int | None = None
    blocked: bool = False


class TombstoneRequest(BaseModel):
    s3_uri: str
    trace_id: str
    reason: str | None = None


# ── /v1/traces/{trace_id}/computer_use ──────────────────────────────


@router.get("/v1/traces/{trace_id}/computer_use")
async def get_trace_computer_use(
    trace_id: str = Path(...),
) -> dict[str, Any]:
    """Return every Computer Use step for a trace."""
    svc = get_computer_use_service()
    rows = await svc.get_steps_for_trace(trace_id)
    return {
        "status": "ok",
        "feature": "computer_use",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


# ── /v1/computer_use/{org_id}/steps ─────────────────────────────────


@router.post("/v1/computer_use/{org_id}/steps")
async def record_step(
    org_id: str = Path(...),
    body: RecordStepRequest = Body(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Record a Computer Use step. Idempotent on
    (span_id, step_index). Setting ``blocked=True`` fires
    the ``on_computer_use_blocked`` hook (per spec §E.1).
    """
    if body.action_type not in ACTION_TYPES:
        return {
            "status": "error",
            "feature": "computer_use",
            "live": False,
            "message": (
                f"unknown action_type: {body.action_type!r} "
                f"(expected one of {list(ACTION_TYPES)})"
            ),
            "data": None,
        }
    svc = get_computer_use_service()
    step_id = await svc.record_step(
        org_id,
        trace_id=body.trace_id,
        span_id=body.span_id,
        step_index=body.step_index,
        action_type=body.action_type,
        action_payload=body.action_payload,
        screenshot_before=body.screenshot_before,
        screenshot_after=body.screenshot_after,
        target_app=body.target_app,
        target_coords=body.target_coords,
        success=body.success,
        error=body.error,
        duration_ms=body.duration_ms,
        blocked=body.blocked,
    )
    return {
        "status": "ok" if step_id else "error",
        "feature": "computer_use",
        "live": bool(step_id),
        "data": {"id": step_id},
    }


# ── /v1/computer_use/{org_id}/screenshots/tombstone ──────────────────


@router.post("/v1/computer_use/{org_id}/screenshots/tombstone")
async def tombstone_screenshot(
    org_id: str = Path(...),
    body: TombstoneRequest = Body(...),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Mark a Computer Use screenshot for RTBF purge."""
    svc = get_computer_use_service()
    ok = await svc.mark_screenshot_tombstoned(
        org_id,
        s3_uri=body.s3_uri,
        trace_id=body.trace_id,
        tombstoned_by="org_admin",
        reason=body.reason,
    )
    return {
        "status": "ok" if ok else "error",
        "feature": "computer_use_screenshots",
        "live": ok,
        "data": {"s3_uri": body.s3_uri, "tombstoned": ok},
    }


# ── /v1/computer_use/{org_id}/screenshots/tombstoned/{trace_id} ─────


@router.get(
    "/v1/computer_use/{org_id}/screenshots/tombstoned/{trace_id}"
)
async def list_tombstoned(
    org_id: str = Path(...),
    trace_id: str = Path(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """List tombstoned screenshots for a trace."""
    svc = get_computer_use_service()
    rows = await svc.list_tombstoned_for_trace(trace_id)
    return {
        "status": "ok",
        "feature": "computer_use_screenshots",
        "live": True,
        "data": rows,
        "count": len(rows),
    }
