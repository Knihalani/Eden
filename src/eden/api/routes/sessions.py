"""Session lifecycle routes (Phase A1, 2026-06-19).

Endpoints:

- ``POST /orgs/{org_id}/intelligence/user/sessions/start`` — allocate a session_id + secret.
- ``POST /orgs/{org_id}/intelligence/user/sessions/{session_id}/end`` — close a session.
- ``POST /orgs/{org_id}/intelligence/user/sessions/{session_id}/identify`` — attach user_id.
- ``GET /orgs/{org_id}/intelligence/user/sessions/{session_id}`` — read a session summary.
- ``POST /orgs/{org_id}/intelligence/user/identify`` — top-level identify (no session).

Backed by ``SessionIdentityService`` in
:mod:`eden.services.app_intel.sessions`. Sessions are a Phase A1
wrapper around the Cat 9 ``user_sessions`` table (migration 024).
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.services.app_intel import DEFAULT_TTL_HOURS, SessionIdentityService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/user",
    tags=["intelligence-user-sessions"],
    dependencies=[Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


class SessionStartRequest(BaseModel):
    user_id: str | None = Field(default=None, max_length=128)
    metadata: dict[str, Any] | None = None
    ttl_hours: int | None = Field(default=None, ge=1, le=24 * 30)


class SessionStartResponse(BaseModel):
    session_id: str
    session_secret: str
    expires_at: str


class SessionIdentifyRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)


class IdentifyRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    traits: dict[str, Any] | None = None


@router.post("/sessions/start", response_model=SessionStartResponse)
async def sessions_start(
    body: SessionStartRequest,
    org_id: str = Depends(require_path_org_access),
) -> SessionStartResponse:
    svc = SessionIdentityService()
    result = await svc.start(
        org_id,
        user_id=body.user_id,
        metadata=body.metadata,
        ttl_hours=body.ttl_hours or DEFAULT_TTL_HOURS,
    )
    if not result["session_id"]:
        raise HTTPException(status_code=503, detail="session store unavailable")
    return SessionStartResponse(**result)


@router.post("/sessions/{session_id}/end")
async def sessions_end(
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(..., min_length=1, max_length=64),
) -> dict:
    svc = SessionIdentityService()
    ok = await svc.end(org_id, session_id)
    if not ok:
        raise HTTPException(status_code=503, detail="session store unavailable")
    return {"status": "ok", "session_id": session_id, "ended": True}


@router.post("/sessions/{session_id}/identify")
async def sessions_identify(
    body: SessionIdentifyRequest,
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(..., min_length=1, max_length=64),
) -> dict:
    svc = SessionIdentityService()
    ok = await svc.identify(org_id, session_id, body.user_id)
    if not ok:
        raise HTTPException(status_code=503, detail="session store unavailable")
    return {"status": "ok", "session_id": session_id, "user_id": body.user_id}


@router.get("/sessions/{session_id}")
async def sessions_get(
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(..., min_length=1, max_length=64),
) -> dict:
    svc = SessionIdentityService()
    result = await svc.get(org_id, session_id)
    if result.get("not_found"):
        raise HTTPException(status_code=404, detail="session not found")
    return result


@router.post("/identify")
async def identify(
    body: IdentifyRequest,
    org_id: str = Depends(require_path_org_access),
) -> dict:
    """Top-level identify (no session). Records the user→org
    association but does not open a session.
    """
    # Minimal: we don't currently persist traits server-side; the
    # SDK stores them client-side and re-sends them with every
    # track() call. This endpoint exists to mirror the SDK API
    # shape and to be the place where traits-server-side lives
    # when we add it.
    return {"status": "ok", "org_id": org_id, "user_id": body.user_id}
