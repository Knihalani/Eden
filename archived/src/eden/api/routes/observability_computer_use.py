"""D.12.3 Computer Use API routes (§8.3).

Thin FastAPI wrapper over ``ComputerUseService``. All persistence
and validation logic lives in
``eden.services.observability.computer_use``; this module only
handles request/response shaping + org membership enforcement.

Routes:
* ``GET  /v1/traces/{trace_id}/computer_use``
* ``POST /v1/computer_use/{org_id}/steps``
* ``POST /v1/computer_use/{org_id}/screenshots/tombstone``
* ``GET  /v1/computer_use/{org_id}/screenshots/tombstoned/{trace_id}``
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import require_org_member, resolve_eden_org_id
from eden.api.utils.redact import redact_all
from eden.services.observability import get_computer_use_service

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1",
    tags=["computer-use"],
    dependencies=[Depends(require_org_member)],
)


async def _assert_path_org(org_id: str, member: dict) -> str:
    eden_path = await resolve_eden_org_id(org_id) or org_id
    if str(member["org_id"]) != str(eden_path):
        from fastapi import HTTPException

        raise HTTPException(
            status_code=403,
            detail="Path org_id does not match authenticated org",
        )
    return str(member["org_id"])


def _ok(data: Any, **extra: Any) -> dict[str, Any]:
    return {"status": "ok", "data": data, **extra}


class ComputerUseStepCreate(BaseModel):
    trace_id: str
    span_id: str
    step_index: int
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


@router.get("/traces/{trace_id}/computer_use")
async def get_trace_computer_use(
    trace_id: str = Path(...),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Return every Computer Use step recorded for a trace."""
    svc = get_computer_use_service()
    steps = await svc.get_steps_for_trace(trace_id, org_id=member["org_id"])
    return _ok(steps, count=len(steps))


@router.post("/computer_use/{org_id}/steps")
async def post_computer_use_step(
    body: ComputerUseStepCreate,
    org_id: str = Path(...),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Record a single Computer Use step. Route-level validation
    rejects unknown action_type before touching the DB.
    """
    scoped = await _assert_path_org(org_id, member)
    svc = get_computer_use_service()
    try:
        step_id = await svc.record_step(
            scoped,
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
    except ValueError as exc:
        return {"status": "error", "message": redact_all(str(exc))}
    return _ok({"id": step_id})


@router.post("/computer_use/{org_id}/screenshots/tombstone")
async def post_computer_use_tombstone(
    body: TombstoneRequest,
    org_id: str = Path(...),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Mark a screenshot URI for RTBF purge."""
    scoped = await _assert_path_org(org_id, member)
    svc = get_computer_use_service()
    ok = await svc.mark_screenshot_tombstoned(
        scoped,
        s3_uri=body.s3_uri,
        trace_id=body.trace_id,
        reason=body.reason,
    )
    return _ok({"tombstoned": ok})


@router.get("/computer_use/{org_id}/screenshots/tombstoned/{trace_id}")
async def get_computer_use_tombstoned(
    org_id: str = Path(...),
    trace_id: str = Path(...),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """List every tombstoned screenshot for a trace."""
    scoped = await _assert_path_org(org_id, member)
    svc = get_computer_use_service()
    rows = await svc.list_tombstoned_for_trace(trace_id, org_id=scoped)
    return _ok(rows, count=len(rows))


__all__ = ["router"]
