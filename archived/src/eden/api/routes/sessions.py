"""Session lifecycle routes (Phase A1, 2026-06-19) + N12 timeline.

Lifecycle endpoints (``router``):

- ``POST /orgs/{org_id}/intelligence/user/sessions/start`` — allocate a session_id + secret.
- ``POST /orgs/{org_id}/intelligence/user/sessions/{session_id}/end`` — close a session.
- ``POST /orgs/{org_id}/intelligence/user/sessions/{session_id}/identify`` — attach user_id.
- ``GET /orgs/{org_id}/intelligence/user/sessions/{session_id}`` — read a session summary.
- ``POST /orgs/{org_id}/intelligence/user/identify`` — top-level identify (no session).

Backed by ``SessionIdentityService`` in
:mod:`eden.services.app_intel.sessions`. Sessions are a Phase A1
wrapper around the Cat 9 ``user_sessions`` table (migration 024).

N12 timeline endpoints (``timeline_router``, backed by the
``session_summaries`` rollup in :mod:`eden.sessions`):

- ``GET /orgs/{org_id}/sessions`` — filtered session list.
- ``GET /orgs/{org_id}/sessions/{session_id}/timeline`` — ordered turn cards.
- ``POST /orgs/{org_id}/sessions/{session_id}/link-issue`` — attach an F29 issue.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.utils.redact import redact_all
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


# ── N12 session multi-turn timeline ──────────────────────────────────
#
# Separate router: these live at /orgs/{org_id}/sessions (portal
# surface over the session_summaries rollup), not under the
# /intelligence/user lifecycle prefix. Registered alongside ``router``
# in the deferred-router table in eden.api.app.

timeline_router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["sessions-timeline"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


class SessionSummaryItem(BaseModel):
    session_id: str
    agent_id: str | None = None
    user_id: str | None = None
    trace_ids: list[str] = Field(default_factory=list)
    turn_count: int
    total_cost_usd: float
    total_input_tokens: int
    total_output_tokens: int
    total_latency_ms: float | None = None
    session_start: str | None = None
    session_end: str | None = None
    had_stumble: bool
    stumble_count: int
    stumble_turn_indices: list[int] = Field(default_factory=list)
    issue_count: int
    linked_issue_id: str | None = None
    outcome: str
    updated_at: str | None = None


class SessionListResponse(BaseModel):
    sessions: list[SessionSummaryItem]
    total: int
    limit: int
    offset: int


class SessionTurnIssue(BaseModel):
    issue_id: str
    status: str
    severity: str
    title: str


class SessionTurn(BaseModel):
    index: int
    trace_id: str
    started_at: str | None = None
    ended_at: str | None = None
    duration_ms: float | None = None
    cost_usd: float | None = None
    input_tokens: int
    output_tokens: int
    outcome: str | None = None
    error_type: str | None = None
    had_stumble: bool
    stumble_kinds: list[str] = Field(default_factory=list)
    issues: list[SessionTurnIssue] = Field(default_factory=list)
    summary: str | None = None


class SessionTimelineResponse(BaseModel):
    org_id: str
    session_id: str
    summary: SessionSummaryItem
    turn_count: int
    turns: list[SessionTurn]
    limit: int
    offset: int


class LinkIssueRequest(BaseModel):
    issue_id: str = Field(..., min_length=1, max_length=64)


class LinkIssueResponse(BaseModel):
    status: str
    session_id: str
    linked_issue_id: str


def _sessions_unavailable(exc: Exception) -> HTTPException:
    # Postgres down → 503, never a fake empty list (same contract as
    # observability.list_traces).
    logger.warning("sessions timeline: storage unavailable: %s", redact_all(str(exc)))
    return HTTPException(
        status_code=503,
        detail="Sessions temporarily unavailable",
        headers={"Retry-After": "5"},
    )


@timeline_router.get("/sessions", response_model=SessionListResponse)
async def sessions_list(
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None, max_length=256),
    since: datetime | None = Query(
        None, description="Only sessions with activity at/after this time."
    ),
    had_stumble: bool | None = Query(None),
    min_cost: float | None = Query(None, ge=0),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> SessionListResponse:
    """List rolled-up sessions, most recent first."""
    from eden.sessions import list_sessions

    try:
        result = await list_sessions(
            org_id,
            agent_id=agent_id,
            since=since,
            had_stumble=had_stumble,
            min_cost=min_cost,
            limit=limit,
            offset=offset,
        )
    except (ConnectionError, TimeoutError, OSError) as exc:
        raise _sessions_unavailable(exc) from exc
    return SessionListResponse(**result)


@timeline_router.get(
    "/sessions/{session_id}/timeline", response_model=SessionTimelineResponse
)
async def sessions_timeline(
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(..., min_length=1, max_length=128),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> SessionTimelineResponse:
    """Ordered turn cards for one session (trace per turn), paginated."""
    from eden.sessions import SessionNotFoundError, get_session_timeline

    try:
        result = await get_session_timeline(
            org_id, session_id, limit=limit, offset=offset
        )
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="session not found") from None
    except (ConnectionError, TimeoutError, OSError) as exc:
        raise _sessions_unavailable(exc) from exc
    return SessionTimelineResponse(**result)


@timeline_router.post(
    "/sessions/{session_id}/link-issue", response_model=LinkIssueResponse
)
async def sessions_link_issue(
    body: LinkIssueRequest,
    org_id: str = Depends(require_path_org_access),
    session_id: str = Path(..., min_length=1, max_length=128),
) -> LinkIssueResponse:
    """Attach an org-owned F29 issue to a session."""
    from eden.sessions import SessionNotFoundError, link_issue
    from eden.sessions.timeline import IssueNotFoundError

    try:
        result = await link_issue(org_id, session_id, body.issue_id)
    except IssueNotFoundError:
        raise HTTPException(status_code=404, detail="issue not found") from None
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="session not found") from None
    except (ConnectionError, TimeoutError, OSError) as exc:
        raise _sessions_unavailable(exc) from exc
    return LinkIssueResponse(status="ok", **result)
