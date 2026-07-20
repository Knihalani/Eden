"""Ingest-side agent sessions (F23) — org API key auth for SDKs.

Portal/Clerk routes remain at ``/orgs/{org_id}/agent-sessions``.
SDKs call these ``/ingest/agent-sessions`` endpoints with
``X-Org-Api-Key`` via :func:`get_ingest_auth`.

Auth is ``get_ingest_auth`` only (API key or session cookie) — not
``require_path_org_access``, which depends on Clerk ``get_current_user``
and would 401 Clerk-less SDK callers before ingest auth runs.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_ingest_auth
from eden.api.utils.safe_error import safe_detail
from eden.services.agent_sessions import AgentSessionService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/ingest/agent-sessions",
    tags=["ingest-agent-sessions"],
)

_svc = AgentSessionService()


def _ok(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": "agent_sessions",
        "live": True,
        "trace_id": f"ias_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _assert_ingest_org(auth: dict, org_id: str) -> None:
    """Reject path/auth org mismatches with HTTP 403 (not soft 200)."""
    auth_org = auth.get("org_id")
    if not auth_org or str(auth_org) != str(org_id):
        raise HTTPException(
            status_code=403,
            detail="Path org_id does not match authenticated org",
        )


def _require_session_uuid(session_id: str) -> str:
    """agent_sessions.id is UUID — reject bad client ids as 422, not 500."""
    try:
        return str(uuid.UUID(str(session_id)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(
            status_code=422,
            detail="session_id must be a valid UUID",
        ) from exc


class SessionStartRequest(BaseModel):
    agent_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] | None = None
    session_id: str | None = None


class SessionEndRequest(BaseModel):
    success: bool = True
    failure_reason: str | None = None
    cost_usd: float | None = None
    trace_ids: list[str] | None = None


class SessionIdentifyRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=256)


class AttachTraceRequest(BaseModel):
    trace_id: str = Field(..., min_length=1)


@router.post("/start")
async def start_session(
    org_id: str = Path(..., description="Organization ID"),
    body: SessionStartRequest = Body(default=SessionStartRequest()),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    _assert_ingest_org(auth, org_id)
    session_id = body.session_id
    if session_id is not None:
        session_id = _require_session_uuid(session_id)
    try:
        session = await _svc.start(
            org_id,
            agent_id=body.agent_id,
            user_id=body.user_id,
            metadata=body.metadata,
            session_id=session_id,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("ingest agent-session start failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                exc,
                fallback="Agent session ingest temporarily unavailable",
            ),
            headers={"Retry-After": "5"},
        ) from exc
    return _ok({"session": session.to_dict()})


@router.post("/{session_id}/end")
async def end_session(
    org_id: str = Path(..., description="Organization ID"),
    session_id: str = Path(...),
    body: SessionEndRequest = Body(default=SessionEndRequest()),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    _assert_ingest_org(auth, org_id)
    session_id = _require_session_uuid(session_id)
    try:
        if body.trace_ids:
            await _svc.attach_traces(org_id, session_id, body.trace_ids)
        session = await _svc.complete(
            org_id,
            session_id,
            success=body.success,
            failure_reason=body.failure_reason,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("ingest agent-session end failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                exc,
                fallback="Agent session ingest temporarily unavailable",
            ),
            headers={"Retry-After": "5"},
        ) from exc
    if session is None:
        return {
            "status": "not_found",
            "feature": "agent_sessions",
            "live": True,
            "data": {"session_id": session_id},
        }
    data: dict[str, Any] = {"session": session.to_dict()}
    if body.cost_usd is not None:
        data["cost_usd"] = body.cost_usd
    return _ok(data)


@router.post("/{session_id}/identify")
async def identify_session(
    org_id: str = Path(..., description="Organization ID"),
    session_id: str = Path(...),
    body: SessionIdentifyRequest = Body(...),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    _assert_ingest_org(auth, org_id)
    session_id = _require_session_uuid(session_id)
    try:
        ok = await _svc.identify(org_id, session_id, body.user_id)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("ingest agent-session identify failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                exc,
                fallback="Agent session ingest temporarily unavailable",
            ),
            headers={"Retry-After": "5"},
        ) from exc
    return _ok({"session_id": session_id, "updated": ok, "user_id": body.user_id})


@router.post("/{session_id}/traces")
async def attach_trace(
    org_id: str = Path(..., description="Organization ID"),
    session_id: str = Path(...),
    body: AttachTraceRequest = Body(...),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    _assert_ingest_org(auth, org_id)
    session_id = _require_session_uuid(session_id)
    try:
        ok = await _svc.attach_trace(org_id, session_id, body.trace_id)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("ingest agent-session attach_trace failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                exc,
                fallback="Agent session ingest temporarily unavailable",
            ),
            headers={"Retry-After": "5"},
        ) from exc
    return _ok(
        {"session_id": session_id, "trace_id": body.trace_id, "attached": ok},
    )
