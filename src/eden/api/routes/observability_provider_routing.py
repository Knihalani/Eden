"""Provider routing routes — D.12.6 (§2.12, §C.8).

Routes:

* ``POST /v1/provider_routing/{org_id}/attempts`` — record a
  single routing attempt (SDK path; org-member gated). The
  4-decision CHECK + UNIQUE(trace_id, sequence_index) are
  enforced at the DB layer; the route layer also rejects
  unknown decisions and out-of-range sequence_index values
  with a 400.
* ``GET  /v1/traces/{trace_id}/provider_routing`` — return
  the routing attempts for a trace (no auth gate beyond
  the global feature flag + current user).
* ``GET  /v1/provider_routing/{org_id}/attempts`` — list
  attempts for an org with optional filters
  ``attempted_provider``, ``decision``, ``since_minutes``.
* ``GET  /v1/provider_routing/{org_id}/failure_rate`` —
  return the per-provider failure rate in the rolling
  ``window_minutes`` window (org-member gated).
* ``GET  /v1/provider_routing/{org_id}/repeated_failures`` —
  return the spike summary for ``(org, provider)`` and
  (when ``fire_hook=true``) emit the
  ``on_provider_routing_repeated_failures`` hook (org-admin
  gated).

The hook fires from inside the service on
``detect_repeated_failures`` — the route layer doesn't
have to remember to fire it.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_org_member,
)
from eden.services.observability import (
    DECISIONS,
    DEFAULT_REPEATED_FAILURE_THRESHOLD,
    DEFAULT_REPEATED_FAILURE_WINDOW_MINUTES,
    MAX_SEQUENCE_INDEX,
    get_provider_routing_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    tags=["observability-provider-routing"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)


class RecordAttemptRequest(BaseModel):
    trace_id: str
    span_id: str
    attempted_provider: str
    attempted_model: str
    sequence_index: int = Field(..., ge=0, le=MAX_SEQUENCE_INDEX)
    decision: str
    failure_reason: str | None = None
    latency_ms: int | None = Field(default=None, ge=0)


# ── /v1/provider_routing/{org_id}/attempts (record) ──────────────────


@router.post("/v1/provider_routing/{org_id}/attempts")
async def record_attempt(
    org_id: str = Path(...),
    body: RecordAttemptRequest = Body(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Record a single provider-routing attempt. Idempotent
    on ``(trace_id, sequence_index)`` so a middleware retry
    of the same attempt upserts in place (R-13).
    """
    if body.decision not in DECISIONS:
        return {
            "status": "error",
            "feature": "provider_routing",
            "live": False,
            "message": (
                f"unknown decision: {body.decision!r} "
                f"(expected one of {list(DECISIONS)})"
            ),
            "data": None,
        }
    svc = get_provider_routing_service()
    attempt_id = await svc.record_attempt(
        org_id,
        trace_id=body.trace_id,
        span_id=body.span_id,
        attempted_provider=body.attempted_provider,
        attempted_model=body.attempted_model,
        sequence_index=body.sequence_index,
        decision=body.decision,
        failure_reason=body.failure_reason,
        latency_ms=body.latency_ms,
    )
    return {
        "status": "ok" if attempt_id else "error",
        "feature": "provider_routing",
        "live": bool(attempt_id),
        "data": {"id": attempt_id},
    }


# ── /v1/traces/{trace_id}/provider_routing ───────────────────────────


@router.get("/v1/traces/{trace_id}/provider_routing")
async def get_trace_provider_routing(
    trace_id: str = Path(...),
) -> dict[str, Any]:
    """Return every provider-routing attempt for a trace."""
    svc = get_provider_routing_service()
    rows = await svc.get_attempts_for_trace(trace_id)
    return {
        "status": "ok",
        "feature": "provider_routing",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


# ── /v1/provider_routing/{org_id}/attempts (list) ────────────────────


@router.get("/v1/provider_routing/{org_id}/attempts")
async def list_attempts(
    org_id: str = Path(...),
    attempted_provider: str | None = Query(None),
    decision: str | None = Query(None),
    since_minutes: int | None = Query(None, ge=1, le=24 * 60 * 7),
    limit: int = Query(100, ge=1, le=500),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """List attempts for an org with optional filters."""
    if decision is not None and decision not in DECISIONS:
        return {
            "status": "error",
            "feature": "provider_routing",
            "live": False,
            "message": (
                f"unknown decision: {decision!r} "
                f"(expected one of {list(DECISIONS)})"
            ),
            "data": None,
        }
    svc = get_provider_routing_service()
    rows = await svc.list_attempts(
        org_id,
        attempted_provider=attempted_provider,
        decision=decision,
        since_minutes=since_minutes,
        limit=limit,
    )
    return {
        "status": "ok",
        "feature": "provider_routing",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


# ── /v1/provider_routing/{org_id}/failure_rate ───────────────────────


@router.get("/v1/provider_routing/{org_id}/failure_rate")
async def get_failure_rate(
    org_id: str = Path(...),
    attempted_provider: str = Query(...),
    window_minutes: int = Query(
        DEFAULT_REPEATED_FAILURE_WINDOW_MINUTES, ge=1, le=24 * 60 * 7,
    ),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Return the per-provider failure rate for the org in
    the rolling ``window_minutes`` window.
    """
    svc = get_provider_routing_service()
    rate = await svc.get_failure_rate(
        org_id,
        attempted_provider=attempted_provider,
        window_minutes=window_minutes,
    )
    return {
        "status": "ok",
        "feature": "provider_routing",
        "live": True,
        "data": rate,
    }


# ── /v1/provider_routing/{org_id}/repeated_failures ──────────────────


@router.get("/v1/provider_routing/{org_id}/repeated_failures")
async def detect_repeated_failures(
    org_id: str = Path(...),
    attempted_provider: str = Query(...),
    window_minutes: int = Query(
        DEFAULT_REPEATED_FAILURE_WINDOW_MINUTES, ge=1, le=24 * 60 * 7,
    ),
    threshold: int = Query(
        DEFAULT_REPEATED_FAILURE_THRESHOLD, ge=1, le=1000,
    ),
    fire_hook: bool = Query(True),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Return the repeated-failure summary for
    ``(org, provider)`` in the rolling window. When the
    non-success count crosses ``threshold``, the response
    carries ``spike: true``. ``fire_hook=false`` is a
    dry-run (no hook emission).
    """
    svc = get_provider_routing_service()
    summary = await svc.detect_repeated_failures(
        org_id,
        attempted_provider=attempted_provider,
        window_minutes=window_minutes,
        threshold=threshold,
        fire_hook=fire_hook,
    )
    if summary is None:
        return {
            "status": "ok",
            "feature": "provider_routing",
            "live": True,
            "data": {
                "org_id": org_id,
                "attempted_provider": attempted_provider,
                "window_minutes": int(window_minutes),
                "threshold": int(threshold),
                "spike": False,
                "trace_ids": [],
            },
        }
    return {
        "status": "ok",
        "feature": "provider_routing",
        "live": True,
        "data": summary,
    }
