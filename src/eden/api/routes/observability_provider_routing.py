"""D.12.6 Provider routing API routes (§8.6).

Thin FastAPI wrapper over ``ProviderRoutingService``. All
persistence and validation logic lives in
``eden.services.observability.provider_routing``; this module
only handles request/response shaping + org membership
enforcement.

Routes:
* ``POST /v1/provider_routing/{org_id}/attempts``
* ``GET  /v1/traces/{trace_id}/provider_routing``
* ``GET  /v1/provider_routing/{org_id}/attempts``
* ``GET  /v1/provider_routing/{org_id}/failure_rate``
* ``GET  /v1/provider_routing/{org_id}/repeated_failures``
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel

from eden.api.deps import require_org_member, resolve_eden_org_id
from eden.api.utils.redact import redact_all
from eden.services.observability import get_provider_routing_service

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1",
    tags=["provider-routing"],
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


class ProviderRoutingAttemptCreate(BaseModel):
    trace_id: str
    span_id: str
    attempted_provider: str
    attempted_model: str
    sequence_index: int
    decision: str
    failure_reason: str | None = None
    latency_ms: int | None = None


@router.post("/provider_routing/{org_id}/attempts")
async def post_provider_routing_attempt(
    body: ProviderRoutingAttemptCreate,
    org_id: str = Path(...),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Record a single provider-routing attempt. Route-level
    validation surfaces unknown decision / negative sequence_index
    as a ``{status: error}`` envelope rather than a 500.
    """
    scoped = await _assert_path_org(org_id, member)
    svc = get_provider_routing_service()
    try:
        attempt_id = await svc.record_attempt(
            scoped,
            trace_id=body.trace_id,
            span_id=body.span_id,
            attempted_provider=body.attempted_provider,
            attempted_model=body.attempted_model,
            sequence_index=body.sequence_index,
            decision=body.decision,
            failure_reason=body.failure_reason,
            latency_ms=body.latency_ms,
        )
    except ValueError as exc:
        return {"status": "error", "message": redact_all(str(exc))}
    return _ok({"id": attempt_id})


@router.get("/traces/{trace_id}/provider_routing")
async def get_trace_provider_routing(
    trace_id: str = Path(...),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Return every routing attempt recorded for a trace."""
    svc = get_provider_routing_service()
    rows = await svc.get_attempts_for_trace(trace_id, org_id=member["org_id"])
    return _ok(rows, count=len(rows))


@router.get("/provider_routing/{org_id}/attempts")
async def list_provider_routing_attempts(
    org_id: str = Path(...),
    attempted_provider: str | None = Query(None),
    decision: str | None = Query(None),
    since_minutes: int | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """List routing attempts for an org with optional filters."""
    scoped = await _assert_path_org(org_id, member)
    svc = get_provider_routing_service()
    try:
        rows = await svc.list_attempts(
            scoped,
            attempted_provider=attempted_provider,
            decision=decision,
            since_minutes=since_minutes,
            limit=limit,
        )
    except ValueError as exc:
        return {"status": "error", "message": redact_all(str(exc))}
    return _ok(rows, count=len(rows))


@router.get("/provider_routing/{org_id}/failure_rate")
async def get_provider_routing_failure_rate(
    org_id: str = Path(...),
    attempted_provider: str = Query(...),
    window_minutes: int = Query(15, ge=1, le=1440),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Return the rolling failure rate for a provider."""
    scoped = await _assert_path_org(org_id, member)
    svc = get_provider_routing_service()
    rate = await svc.get_failure_rate(
        scoped, attempted_provider=attempted_provider, window_minutes=window_minutes,
    )
    return _ok(rate)


@router.get("/provider_routing/{org_id}/repeated_failures")
async def get_provider_routing_repeated_failures(
    org_id: str = Path(...),
    attempted_provider: str = Query(...),
    window_minutes: int = Query(15, ge=1, le=1440),
    threshold: int = Query(10, ge=1),
    member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Detect a repeated-failure spike for a provider (read-only
    — never fires the closed-loop hook; that's reserved for the
    background detector so a dashboard refresh can't spam it).
    """
    scoped = await _assert_path_org(org_id, member)
    svc = get_provider_routing_service()
    summary = await svc.detect_repeated_failures(
        scoped,
        attempted_provider=attempted_provider,
        window_minutes=window_minutes,
        threshold=threshold,
        fire_hook=False,
    )
    if summary is None:
        return _ok({"spike": False})
    return _ok(summary)


__all__ = ["router"]
