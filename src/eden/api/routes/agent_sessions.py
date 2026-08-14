"""Agent sessions API (F23 / N12) — NOT user intelligence sessions."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.services.agent_sessions import AgentSessionService

logger = logging.getLogger(__name__)

_FLAG = "agent_sessions_v1"

router = APIRouter(
    prefix="/orgs/{org_id}/agent-sessions",
    tags=["agent-sessions"],
    dependencies=[
        Depends(require_feature_flag(_FLAG)),
        Depends(get_current_user),
        Depends(require_path_org_access),
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
    outcome: str | None = None
    source: str | None = None
    reason: str | None = None
    explicit: bool | None = None
    slack: dict[str, str] | None = None
    slack_channel: str | None = None
    slack_ts: str | None = None


class SessionIdentifyRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=256)


class AttachTraceRequest(BaseModel):
    trace_id: str = Field(..., min_length=1)


@router.get("/contract")
async def session_contract() -> dict[str, Any]:
    from eden.services.session_contract import SESSION_CONTRACT

    return _ok("agent_session_contract", {"contract": SESSION_CONTRACT})


@router.post("/start")
async def start_session(
    org_id: str = Depends(require_path_org_access),
    body: SessionStartRequest = Body(default_factory=SessionStartRequest),
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
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    sessions = await _svc.list_sessions(org_id, agent_id=agent_id, limit=limit)
    return _ok(
        "agent_sessions",
        {"sessions": [s.to_dict() for s in sessions], "count": len(sessions)},
    )



class HelpContractIn(BaseModel):
    agent_id: str
    sentence: str = Field(..., min_length=8, max_length=280)
    x_job: str | None = None
    x_keywords: list[str] | None = None
    y_person: str | None = None
    y_slack_user_id: str | None = None


@router.get("/help-status")
async def help_status(
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None),
) -> dict[str, Any]:
    from eden.integrations.slack import store as slack_store

    install = await slack_store.get_install(org_id)
    channels = await slack_store.list_channels(org_id)
    mapped = [c for c in channels if c.get("agent_id") == agent_id] if agent_id else channels
    mapped = [c for c in mapped if c.get("agent_id")]
    contract = (
        await slack_store.get_current_help_contract(org_id, agent_id)
        if agent_id
        else None
    )
    leftover = await slack_store.list_leftover_events(
        org_id, agent_id=agent_id, limit=20
    )
    counts = await slack_store.help_counts(org_id, agent_id=agent_id)
    invited = bool(install)
    history = bool(install and not slack_store.needs_reconsent(install))
    if not invited or not mapped:
        reason = "invite" if not invited else "map"
        copy = (
            "If they will not invite Eden to the channels where leftover work "
            "shows up, and will not map those channels to a HelpContract, you "
            "cannot close the loop. Traces alone are not enough. Thumbs alone "
            "are not enough. A Slack install that only pages out is not enough. "
            "The team must not have to tag anything. Do not sign the design-partner week. "
            "We can see this agent run. We cannot tell if "
            "it helped — Eden is not invited to the channel where leftover work "
            "would show up, or that channel is not mapped. Do not sign the design-partner week."
        )
    elif not contract:
        reason = "no_contract"
        copy = "We can see it run. We cannot tell if it helped, because nobody wrote what help means."
    elif not history:
        reason = "invite"
        copy = "We can page this channel. We cannot see whether a person still did the work in it."
    elif counts.get("leftover_7d", 0) == 0:
        reason = "no extra work seen"
        copy = ""
    else:
        reason = None
        copy = ""
    return _ok(
        "help_status",
        {
            "contract": contract,
            "mapped_channels": mapped,
            "invited": invited,
            "history_consented": history,
            "leftover": leftover,
            "counts": counts,
            "unknown_reason": reason,
            "install_bar": {"loud": bool(copy), "copy": copy},
        },
    )


@router.put("/help-contract")
async def put_help_contract(
    org_id: str = Depends(require_path_org_access),
    body: HelpContractIn = Body(...),
) -> dict[str, Any]:
    from eden.integrations.slack import store as slack_store

    row = await slack_store.upsert_help_contract(
        org_id,
        agent_id=body.agent_id,
        sentence=body.sentence,
        created_by="portal",
        x_job=body.x_job,
        x_keywords=body.x_keywords,
        y_person=body.y_person,
        y_slack_user_id=body.y_slack_user_id,
    )
    return _ok("help_contract", {"contract": row})


@router.get("/{session_id}")
async def get_session(
    org_id: str = Depends(require_path_org_access), session_id: str = Path(...)
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
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(...),
    body: SessionEndRequest = Body(default_factory=SessionEndRequest),
) -> dict[str, Any]:
    from eden.services.session_contract import pointer_from_payload
    pointer = pointer_from_payload({"slack": body.slack, "slack_channel": body.slack_channel, "slack_ts": body.slack_ts})
    session = await _svc.complete(
        org_id,
        session_id,
        success=body.success,
        failure_reason=body.failure_reason,
        outcome=body.outcome,
        source=body.source,
        reason=body.reason,
        explicit=body.explicit,
        slack_channel=pointer[0],
        slack_ts=pointer[1],
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
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(...),
    body: SessionIdentifyRequest = Body(...),
) -> dict[str, Any]:
    ok = await _svc.identify(org_id, session_id, body.user_id)
    return _ok("agent_sessions", {"session_id": session_id, "updated": ok})


@router.post("/{session_id}/traces")
async def attach_trace(
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(...),
    body: AttachTraceRequest = Body(...),
) -> dict[str, Any]:
    ok = await _svc.attach_trace(org_id, session_id, body.trace_id)
    return _ok(
        "agent_sessions",
        {"session_id": session_id, "trace_id": body.trace_id, "attached": ok},
    )
