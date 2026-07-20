"""F09 — browser session recording API (RRWeb payloads).

Playback UI must keep an F09 sandbox (iframe sandbox / CSP) around
rrweb-player; this module enforces org membership + session ownership
only.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    require_feature_flag,
    resolve_path_org_access,
)
from eden.replay.store import BrowserSessionStore

logger = logging.getLogger(__name__)

_FLAG = "browser_recording_v1"


async def _require_path_org(
    org_id: str = Path(..., description="Organization ID"),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> str:
    _, eden_org = await resolve_path_org_access(org_id, user, payload)
    return eden_org


router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["browser-sessions"],
    dependencies=[
        Depends(require_feature_flag(_FLAG)),
        Depends(get_current_user),
        Depends(_require_path_org),
    ],
)

_store = BrowserSessionStore()


def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"bs_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _not_found(key: str, value: str) -> dict[str, Any]:
    return {
        "status": "not_found",
        "feature": "browser_recording",
        "data": {key: value},
    }


class CreateBrowserSessionRequest(BaseModel):
    trace_id: str = Field(..., min_length=1)
    agent_session_id: str | None = None
    user_agent: str = ""
    viewport_w: int = 0
    viewport_h: int = 0


class AppendEventsRequest(BaseModel):
    events: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/browser-sessions")
async def create_browser_session(
    org_id: str = Depends(_require_path_org),
    body: CreateBrowserSessionRequest = Body(...),
) -> dict[str, Any]:
    session = await _store.create_session(
        org_id,
        trace_id=body.trace_id,
        agent_session_id=body.agent_session_id,
        user_agent=body.user_agent,
        viewport_w=body.viewport_w,
        viewport_h=body.viewport_h,
    )
    return _ok("browser_recording", {"session": session.to_dict()})


@router.post("/browser-sessions/{session_id}/events")
async def append_browser_events(
    org_id: str = Depends(_require_path_org),
    session_id: str = Path(...),
    body: AppendEventsRequest = Body(...),
) -> dict[str, Any]:
    # Session must belong to path org (store filters by org_id).
    session = await _store.get_session(org_id, session_id)
    if session is None:
        return _not_found("session_id", session_id)
    count = await _store.append_events(org_id, session_id, body.events)
    return _ok("browser_recording", {"session_id": session_id, "appended": count})


@router.get("/browser-sessions/{session_id}")
async def get_browser_session(
    org_id: str = Depends(_require_path_org), session_id: str = Path(...)
) -> dict[str, Any]:
    session = await _store.get_session(org_id, session_id)
    if session is None:
        return _not_found("session_id", session_id)
    return _ok("browser_recording", {"session": session.to_dict()})


@router.get("/traces/{trace_id}/browser-replay")
async def browser_replay_for_trace(
    org_id: str = Depends(_require_path_org), trace_id: str = Path(...)
) -> dict[str, Any]:
    bundle = await _store.replay_bundle_for_trace(org_id, trace_id)
    if bundle is None:
        return _not_found("trace_id", trace_id)
    return _ok("browser_recording", bundle)
