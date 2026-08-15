"""A2A protocol routes — D.12.2 (§8.2, §C.8).

Routes (per spec §C.8):

* ``GET  /v1/traces/{trace_id}/a2a`` — return the parent +
  children A2A links for a trace.
* ``POST /v1/a2a/{org_id}/links`` — register a link (SDK path)
* ``GET  /v1/a2a/{org_id}/invocations/{trace_id}`` — return
  the BFS invocation graph for a trace (nodes + edges).
* ``POST /v1/a2a/{org_id}/links/{link_id}/fail`` — mark a
  link as failed (fires the ``on_a2a_invocation_failed`` hook).

All routes are gated by ``intelligence_gap_v0`` + auth.
The SDK's typical entry point is ``POST /links`` followed
by an update via ``POST /links/{id}/fail`` on errors.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_org_member,
    require_path_org_access,
    resolve_eden_org_id,
)
from eden.services.observability import get_a2a_service

logger = logging.getLogger(__name__)

router = APIRouter(
    tags=["observability-a2a"],
    dependencies=[Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)


async def _assert_path_org(org_id: str, member: dict) -> str:
    from fastapi import HTTPException

    eden_path = await resolve_eden_org_id(org_id) or org_id
    if str(member["org_id"]) != str(eden_path):
        raise HTTPException(
            status_code=403,
            detail="Path org_id does not match authenticated org",
        )
    return str(member["org_id"])


class RegisterLinkRequest(BaseModel):
    parent_trace_id: str
    child_trace_id: str
    parent_agent_id: str
    child_agent_id: str
    parent_span_id: str
    invocation_type: str
    response_status: str | None = None


class MarkFailedRequest(BaseModel):
    error_kind: str


# ── /v1/traces/{trace_id}/a2a ────────────────────────────────────────


@router.get("/v1/traces/{trace_id}/a2a")
async def get_trace_a2a(
    trace_id: str = Path(...),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Return the parent + children A2A links for this trace."""
    svc = get_a2a_service()
    data = await svc.get_links_for_trace(trace_id, org_id=member["org_id"])
    return {
        "status": "ok",
        "feature": "a2a_links",
        "live": True,
        "data": data,
        "count": len(data["parent"]) + len(data["children"]),
    }


# ── /v1/a2a/{org_id}/links ───────────────────────────────────────────


@router.post("/v1/a2a/{org_id}/links")
async def register_link(
    org_id: str = Depends(require_path_org_access),
    body: RegisterLinkRequest = Body(...),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Register a new A2A link. Idempotent on
    (parent_trace_id, parent_span_id, child_trace_id)."""
    scoped = await _assert_path_org(org_id, member)
    svc = get_a2a_service()
    link_id = await svc.register_link(
        scoped,
        parent_trace_id=body.parent_trace_id,
        child_trace_id=body.child_trace_id,
        parent_agent_id=body.parent_agent_id,
        child_agent_id=body.child_agent_id,
        parent_span_id=body.parent_span_id,
        invocation_type=body.invocation_type,
        response_status=body.response_status,
    )
    return {
        "status": "ok",
        "feature": "a2a_links",
        "live": True,
        "data": {"id": link_id},
    }


# ── /v1/a2a/{org_id}/invocations/{trace_id} ─────────────────────────


@router.get("/v1/a2a/{org_id}/invocations/{trace_id}")
async def get_invocation_graph(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    max_depth: int = Query(4, ge=1, le=16),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Return the BFS invocation graph (nodes + edges) for a trace."""
    scoped = await _assert_path_org(org_id, member)
    svc = get_a2a_service()
    graph = await svc.get_invocation_graph(
        trace_id, org_id=scoped, max_depth=max_depth,
    )
    return {
        "status": "ok",
        "feature": "a2a_invocation_graph",
        "live": True,
        "data": graph,
        "node_count": len(graph["nodes"]),
        "edge_count": len(graph["edges"]),
    }


# ── /v1/a2a/{org_id}/links/{link_id}/fail ───────────────────────────


@router.post("/v1/a2a/{org_id}/links/{link_id}/fail")
async def mark_link_failed(
    org_id: str = Depends(require_path_org_access),
    link_id: str = Path(...),
    body: MarkFailedRequest = Body(...),
    admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Mark a link as failed. Fires the ``on_a2a_invocation_failed``
    hook (per spec §E.1).
    """
    await _assert_path_org(org_id, admin)
    svc = get_a2a_service()
    ok = await svc.mark_failed(link_id, error_kind=body.error_kind)
    return {
        "status": "ok" if ok else "error",
        "feature": "a2a_links",
        "live": ok,
        "data": {"id": link_id, "marked_failed": ok},
    }
