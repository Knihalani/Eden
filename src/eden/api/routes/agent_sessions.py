"""Agent sessions API (F23 / N12) — NOT user intelligence sessions."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.services.agent_sessions import AgentSessionService

logger = logging.getLogger(__name__)

_FLAG = "agent_sessions_v1"

router = APIRouter(
    prefix="/orgs/{org_id}/agent-sessions",
    tags=["agent-sessions"],
    dependencies=[
        Depends(require_feature_flag(_FLAG)),
        Depends(get_current_user),
    ],
)

_svc = AgentSessionService()


def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"as_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


class SessionStartRequest(BaseModel):
    agent_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] | None = None
    session_id: str | None = None


class SessionEndRequest(BaseModel):
    success: bool = True
    failure_reason: str | None = None


class SessionIdentifyRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=256)


class AttachTraceRequest(BaseModel):
    trace_id: str = Field(..., min_length=1)


@router.post("/start")
async def start_session(
    org_id: str = Path(...),
    body: SessionStartRequest = Body(default=SessionStartRequest()),
) -> dict[str, Any]:
    session = await _svc.start(
        org_id,
        agent_id=body.agent_id,
        user_id=body.user_id,
        metadata=body.metadata,
        session_id=body.session_id,
    )
    return _ok("agent_sessions", {"session": session.to_dict()})


@router.get("")
async def list_sessions(
    org_id: str = Path(...),
    agent_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    sessions = await _svc.list_sessions(org_id, agent_id=agent_id, limit=limit)
    return _ok(
        "agent_sessions",
        {"sessions": [s.to_dict() for s in sessions], "count": len(sessions)},
    )


@router.get("/{session_id}")
async def get_session(
    org_id: str = Path(...), session_id: str = Path(...)
) -> dict[str, Any]:
    session = await _svc.get(org_id, session_id)
    if session is None:
        return {
            "status": "not_found",
            "feature": "agent_sessions",
            "live": True,
            "data": {"session_id": session_id},
        }
    return _ok("agent_sessions", {"session": session.to_dict()})


@router.post("/{session_id}/end")
async def end_session(
    org_id: str = Path(...),
    session_id: str = Path(...),
    body: SessionEndRequest = Body(default=SessionEndRequest()),
) -> dict[str, Any]:
    session = await _svc.complete(
        org_id,
        session_id,
        success=body.success,
        failure_reason=body.failure_reason,
    )
    if session is None:
        return {
            "status": "not_found",
            "feature": "agent_sessions",
            "live": True,
            "data": {"session_id": session_id},
        }
    return _ok("agent_sessions", {"session": session.to_dict()})


@router.post("/{session_id}/identify")
async def identify_session(
    org_id: str = Path(...),
    session_id: str = Path(...),
    body: SessionIdentifyRequest = Body(...),
) -> dict[str, Any]:
    ok = await _svc.identify(org_id, session_id, body.user_id)
    return _ok("agent_sessions", {"session_id": session_id, "updated": ok})


@router.post("/{session_id}/traces")
async def attach_trace(
    org_id: str = Path(...),
    session_id: str = Path(...),
    body: AttachTraceRequest = Body(...),
) -> dict[str, Any]:
    ok = await _svc.attach_trace(org_id, session_id, body.trace_id)
    return _ok(
        "agent_sessions",
        {"session_id": session_id, "trace_id": body.trace_id, "attached": ok},
    )
