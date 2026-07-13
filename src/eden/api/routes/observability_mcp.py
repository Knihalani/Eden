"""MCP trace routes — D.12.1 (§8.1, §C.8).

The spec defines one read endpoint:

* ``GET /v1/traces/{trace_id}/mcp`` — return the MCP-typed
  telemetry events for a trace (server_name, tool_name,
  resource_uri, prompt_name, sampling, transport)

Plus two operational routes for the auth-failure surface
(driven by the ``mcp_server_auth_failure`` hook in §E.1):

* ``GET  /v1/mcp/{org_id}/auth_failures`` — list recent
  failures (org-member gated)
* ``POST /v1/mcp/{org_id}/auth_failures`` — record a
  failure (SDK path; org-admin gated)

All routes are gated by the ``intelligence_gap_v0`` umbrella
flag (per the rest of the cat-3+ surface) and require auth.

Ponytail: response is plain ``{status, data}`` so the
cat-3+ envelope pattern is preserved.
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
)
from eden.api.utils.redact import redact_all
from eden.services.observability import get_mcp_service

logger = logging.getLogger(__name__)

router = APIRouter(
    tags=["observability-mcp"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)


class AuthFailureRequest(BaseModel):
    server_name: str
    failure_kind: str
    transport: str | None = None
    error_message: str | None = None
    trace_id: str | None = None
    span_id: str | None = None


# ── /v1/traces/{trace_id}/mcp ──────────────────────────────────────


@router.get("/v1/traces/{trace_id}/mcp")
async def get_trace_mcp(
    trace_id: str = Path(...),
) -> dict[str, Any]:
    """MCP-specific span attributes for this trace.

    Returns ``[]`` when the trace has no MCP-typed events
    (or the DB is unreachable — best-effort).
    """
    svc = get_mcp_service()
    rows = await svc.list_for_trace(trace_id)
    return {
        "status": "ok",
        "feature": "mcp_traces",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


# ── /v1/mcp/{org_id}/auth_failures ─────────────────────────────────


@router.get("/v1/mcp/{org_id}/auth_failures")
async def list_auth_failures(
    org_id: str = Path(...),
    server_name: str | None = Query(None),
    resolved: bool | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """List MCP server auth failures for an org."""
    svc = get_mcp_service()
    rows = await svc.list_auth_failures(
        org_id,
        server_name=server_name,
        resolved=resolved,
        limit=limit,
    )
    return {
        "status": "ok",
        "feature": "mcp_auth_failures",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


@router.post("/v1/mcp/{org_id}/auth_failures")
async def record_auth_failure(
    org_id: str = Path(...),
    body: AuthFailureRequest = Body(...),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Record an MCP auth failure (SDK / operator path).

    On success, also fires the ``mcp_server_auth_failure``
    hook via :class:`PromotionHook` so the closed-loop
    bus can take action (per spec §E.1).
    """
    svc = get_mcp_service()
    failure_id = await svc.record_auth_failure(
        org_id,
        server_name=body.server_name,
        failure_kind=body.failure_kind,
        transport=body.transport,
        error_message=body.error_message,
        trace_id=body.trace_id,
        span_id=body.span_id,
    )
    # Fire the hook (best-effort — never raises).
    try:
        from eden.llmops.promotion_hooks import PromotionHook
        hook = PromotionHook()
        await hook.on_mcp_server_auth_failure(
            org_id,
            server_name=body.server_name,
            failure_kind=body.failure_kind,
            failure_id=failure_id,
        )
    except Exception as exc:
        logger.debug("mcp route: hook fire failed: %s", redact_all(str(exc)))
    return {
        "status": "ok",
        "feature": "mcp_auth_failures",
        "live": True,
        "data": {"id": failure_id},
    }


# ── N02 fleet dashboard ────────────────────────────────────────────


_fleet_router = APIRouter(
    prefix="/orgs/{org_id}/observability/mcp",
    tags=["observability-mcp-fleet"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)


@_fleet_router.get("/servers")
async def list_mcp_servers(
    org_id: str = Path(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    svc = get_mcp_service()
    rows = await svc.list_server_registry(org_id)
    return {
        "status": "ok",
        "feature": "mcp_fleet",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


@_fleet_router.get("/servers/{server_name}/tools")
async def list_mcp_server_tools(
    org_id: str = Path(...),
    server_name: str = Path(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    svc = get_mcp_service()
    rows = await svc.list_tool_stats(org_id, server_name)
    return {
        "status": "ok",
        "feature": "mcp_tool_stats",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


@_fleet_router.get("/graph")
async def mcp_agent_graph(
    org_id: str = Path(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    svc = get_mcp_service()
    edges = await svc.agent_server_graph(org_id)
    return {
        "status": "ok",
        "feature": "mcp_graph",
        "live": True,
        "data": edges,
        "count": len(edges),
    }


@_fleet_router.get("/auth-failures")
async def fleet_auth_failures(
    org_id: str = Path(...),
    server_name: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    svc = get_mcp_service()
    rows = await svc.list_auth_failures(
        org_id, server_name=server_name, resolved=False, limit=limit
    )
    return {
        "status": "ok",
        "feature": "mcp_auth_failures",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


@_fleet_router.get("/sre")
async def mcp_sre_summary(
    org_id: str = Path(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """D4 — MCP boundary SRE dashboard summary."""
    svc = get_mcp_service()
    summary = await svc.sre_summary(org_id)
    return {
        "status": "ok",
        "feature": "mcp_sre",
        "live": True,
        "data": summary,
    }


@_fleet_router.get("/trends")
async def mcp_call_trends(
    org_id: str = Path(...),
    days: int = Query(7, ge=1, le=90),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Daily MCP call volume + auth-failure trend buckets."""
    svc = get_mcp_service()
    rows = await svc.call_trends(org_id, days=days)
    return {
        "status": "ok",
        "feature": "mcp_trends",
        "live": True,
        "data": rows,
        "count": len(rows),
        "days": days,
    }


router.include_router(_fleet_router)
