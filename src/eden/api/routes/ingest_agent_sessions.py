"""Ingest-side agent sessions (F23) — org API key auth for SDKs.

Portal/Clerk routes remain at ``/orgs/{org_id}/agent-sessions``.
SDKs call these ``/ingest/agent-sessions`` endpoints with
``X-Org-Api-Key`` via :func:`get_ingest_auth`.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_ingest_auth
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
    org_id: str = Path(...),
    body: SessionStartRequest = Body(default=SessionStartRequest()),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    if auth.get("org_id") and auth["org_id"] != org_id:
        return {"status": "forbidden", "feature": "agent_sessions", "live": True}
    session = await _svc.start(
        org_id,
        agent_id=body.agent_id,
        user_id=body.user_id,
        metadata=body.metadata,
        session_id=body.session_id,
    )
    return _ok({"session": session.to_dict()})


@router.post("/{session_id}/end")
async def end_session(
    org_id: str = Path(...),
    session_id: str = Path(...),
    body: SessionEndRequest = Body(default=SessionEndRequest()),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    if auth.get("org_id") and auth["org_id"] != org_id:
        return {"status": "forbidden", "feature": "agent_sessions", "live": True}
    if body.trace_ids:
        for tid in body.trace_ids:
            await _svc.attach_trace(org_id, session_id, tid)
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
    data: dict[str, Any] = {"session": session.to_dict()}
    if body.cost_usd is not None:
        data["cost_usd"] = body.cost_usd
    return _ok(data)


@router.post("/{session_id}/identify")
async def identify_session(
    org_id: str = Path(...),
    session_id: str = Path(...),
    body: SessionIdentifyRequest = Body(...),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    if auth.get("org_id") and auth["org_id"] != org_id:
        return {"status": "forbidden", "feature": "agent_sessions", "live": True}
    ok = await _svc.identify(org_id, session_id, body.user_id)
    return _ok({"session_id": session_id, "updated": ok, "user_id": body.user_id})


@router.post("/{session_id}/traces")
async def attach_trace(
    org_id: str = Path(...),
    session_id: str = Path(...),
    body: AttachTraceRequest = Body(...),
    auth: dict = Depends(get_ingest_auth),
) -> dict[str, Any]:
    if auth.get("org_id") and auth["org_id"] != org_id:
        return {"status": "forbidden", "feature": "agent_sessions", "live": True}
    ok = await _svc.attach_trace(org_id, session_id, body.trace_id)
    return _ok(
        {"session_id": session_id, "trace_id": body.trace_id, "attached": ok},
    )
