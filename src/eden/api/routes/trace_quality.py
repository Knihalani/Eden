"""Trace-quality + online guardrails API surface (spec §6, v2.7).

This module owns the 10 routes that make the trace-quality
system reachable from FastAPI. The 5 report routes
(``/v1/traces/{trace_id}/{efficiency,loops,quality,reasoning,
guardrail_actions}``) read the sidecar-written per-trace report
tables. The 5 hot-path routes cover:

* ``POST /v1/guardrails/trajectory/check`` — live per-step
  evaluation; runs the TrajectoryGuardrail hot path with the
  per-tenant kill switch.
* ``POST /v1/llmops/stat_gate/evaluate`` — Phase 6 5-check
  StatGate on control/treatment arrays.
* ``GET  /v1/guardrails/actions/pending`` — operator inbox for
  the mutating actions that were NOT applied (kill switch off).
* ``POST /v1/guardrails/actions/{id}/approve`` — operator flips
  ``applied=False → applied=True`` on a single pending action.
* ``POST /v1/admin/guardrails/{action_class}/enable|disable`` —
  per-tenant per-action kill switch toggle (admin-only).

Tenant-scoping is enforced via ``require_org_member`` for reads
and ``require_org_admin`` for the admin routes. Cross-tenant
lookups return 404 (per spec §0, No-Drop Invariant #16). ETag /
``If-None-Match`` on GET routes. Cache-Control: private,
max-age=300 on the report endpoints. Audit log fires via the
existing writer with ``event_type = "trace_quality.computed"``.

The hot-path hooks (Cat 15/17/22 wiring) live in
``eden.observability.trace_quality.hooks`` and are wired at
``api/app.py:lifespan``. The sidecar worker
(``observability/quality_pipeline/worker.py``) writes the report
tables; the routes here are the read path.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_org_admin,
    require_org_member,
)
from eden.observability.trace_quality.queries import (
    fetch_efficiency_report,
    fetch_guardrail_actions,
    fetch_loop_report,
    fetch_pending_actions,
    fetch_quality_report,
    fetch_reasoning_report,
    fetch_tenant_action_config,
    set_action_applied,
    set_tenant_action_config,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["trace_quality"])


# ── Pydantic schemas ────────────────────────────────────────────────


class TraceEfficiencyReport(BaseModel):
    trace_id: str
    tas: int | None = None
    avs: int | None = None
    vae: int | None = None
    grade: str | None = None
    intervention: str = "allow"
    metrics: dict[str, float] = Field(default_factory=dict)
    fix_patches: list[dict[str, Any]] = Field(default_factory=list)
    created_at: str | None = None


class TraceLoopReport(BaseModel):
    trace_id: str
    verdict: str = "OK"
    detectors_tripped: list[str] = Field(default_factory=list)
    severity: str = "low"
    action: str = "allow"
    max_cosine: float | None = None
    max_jaccard: float | None = None
    step_index: int | None = None
    created_at: str | None = None


class TraceQualityReport(BaseModel):
    trace_id: str
    hallucination_score: float | None = None
    groundedness: float | None = None
    tool_relevance: float | None = None
    step_coherence: float | None = None
    components: dict[str, Any] = Field(default_factory=dict)
    verdict: str = "allow"
    created_at: str | None = None


class TraceReasoningReport(BaseModel):
    trace_id: str
    coherence: float | None = None
    informativeness: float | None = None
    goal_alignment: float | None = None
    verification: float | None = None
    calibration_error: float | None = None
    composite: float | None = None
    lanham_trap: bool = False
    created_at: str | None = None


class GuardrailActionLog(BaseModel):
    trace_id: str
    actions: list[dict[str, Any]] = Field(default_factory=list)


class TrajectoryCheckRequest(BaseModel):
    trace_id: str
    step_index: int = Field(..., ge=0)
    event: dict[str, Any]
    agent_id: str | None = None


class TrajectoryCheckResponse(BaseModel):
    recommended_action: str
    applied: bool
    reason: str
    action_class: str
    audit_id: str | None = None


class StatGateEvaluateRequest(BaseModel):
    control: list[float] = Field(..., min_length=1)
    treatment: list[float] = Field(..., min_length=1)
    alpha: float = 0.05
    min_n: int = 30


class StatGateEvaluateResponse(BaseModel):
    verdict: str
    ece: float
    p_value: float
    cohens_d: float
    n: int
    explanation: str


class PendingActionsResponse(BaseModel):
    actions: list[dict[str, Any]]
    count: int


class ApproveActionResponse(BaseModel):
    action_id: str
    applied: bool
    reason: str


class KillSwitchResponse(BaseModel):
    tenant_id: str
    action_class: str
    applied_by_default: bool


# ── Helpers ─────────────────────────────────────────────────────────


def _etag(payload: Any) -> str:
    """Stable ETag from a JSON-serialisable payload."""
    blob = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return 'W/"' + hashlib.sha256(blob).hexdigest()[:16] + '"'


async def _write_audit(
    tenant_id: str,
    *,
    event_type: str,
    payload: dict[str, Any],
    user_id: str | None = None,
) -> None:
    """Best-effort audit log write.

    The existing audit log writer lives in
    ``eden.audit.writer.write_audit_event``; this wrapper
    swallows exceptions (per the "audit must not break the
    request" pattern used elsewhere in Cat 15). On dev/test
    environments without Postgres, the wrapper is a no-op.
    """
    try:
        from eden.audit.writer import write_audit_event  # type: ignore
    except Exception:
        return
    try:
        await write_audit_event(
            tenant_id=tenant_id,
            event_type=event_type,
            payload=payload,
            user_id=user_id,
        )
    except Exception:
        logger.debug("trace_quality.audit: %s failed", event_type)


# ── Report routes (5 GETs) ─────────────────────────────────────────


@router.get(
    "/traces/{trace_id}/efficiency",
    response_model=TraceEfficiencyReport,
)
async def get_trace_efficiency(
    org_id: str = Path(..., alias="org_id"),
    trace_id: str = Path(...),
    if_none_match: str | None = Header(None, alias="If-None-Match"),
    _org: dict = Depends(require_org_member),
):
    """Per-trace ETEC composite report. Spec §6 row 1."""
    report = await fetch_efficiency_report(org_id, trace_id)
    if report is None:
        raise HTTPException(status_code=404, detail="trace_not_found")
    etag = _etag(report)
    if if_none_match and if_none_match == etag:
        raise HTTPException(status_code=304)
    resp = TraceEfficiencyReport(**report)
    from fastapi import Response  # local import to keep top tidy

    return Response(
        content=resp.model_dump_json(),
        media_type="application/json",
        headers={
            "ETag": etag,
            "Cache-Control": "private, max-age=300",
        },
    )


@router.get("/traces/{trace_id}/loops", response_model=TraceLoopReport)
async def get_trace_loops(
    org_id: str = Path(..., alias="org_id"),
    trace_id: str = Path(...),
    if_none_match: str | None = Header(None, alias="If-None-Match"),
    _org: dict = Depends(require_org_member),
):
    """Per-trace loop ensemble verdict. Spec §6 row 2."""
    report = await fetch_loop_report(org_id, trace_id)
    if report is None:
        raise HTTPException(status_code=404, detail="trace_not_found")
    etag = _etag(report)
    if if_none_match and if_none_match == etag:
        raise HTTPException(status_code=304)
    resp = TraceLoopReport(**report)
    from fastapi import Response

    return Response(
        content=resp.model_dump_json(),
        media_type="application/json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=300"},
    )


@router.get("/traces/{trace_id}/quality", response_model=TraceQualityReport)
async def get_trace_quality(
    org_id: str = Path(..., alias="org_id"),
    trace_id: str = Path(...),
    if_none_match: str | None = Header(None, alias="If-None-Match"),
    _org: dict = Depends(require_org_member),
):
    """Per-trace quality stack report. Spec §6 row 3."""
    report = await fetch_quality_report(org_id, trace_id)
    if report is None:
        raise HTTPException(status_code=404, detail="trace_not_found")
    etag = _etag(report)
    if if_none_match and if_none_match == etag:
        raise HTTPException(status_code=304)
    resp = TraceQualityReport(**report)
    from fastapi import Response

    return Response(
        content=resp.model_dump_json(),
        media_type="application/json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=300"},
    )


@router.get(
    "/traces/{trace_id}/reasoning", response_model=TraceReasoningReport
)
async def get_trace_reasoning(
    org_id: str = Path(..., alias="org_id"),
    trace_id: str = Path(...),
    if_none_match: str | None = Header(None, alias="If-None-Match"),
    _org: dict = Depends(require_org_member),
):
    """Per-trace Phase 9 reasoning composite. Spec §6 row 4."""
    report = await fetch_reasoning_report(org_id, trace_id)
    if report is None:
        raise HTTPException(status_code=404, detail="trace_not_found")
    etag = _etag(report)
    if if_none_match and if_none_match == etag:
        raise HTTPException(status_code=304)
    resp = TraceReasoningReport(**report)
    from fastapi import Response

    return Response(
        content=resp.model_dump_json(),
        media_type="application/json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=300"},
    )


@router.get(
    "/traces/{trace_id}/guardrail_actions",
    response_model=GuardrailActionLog,
)
async def get_trace_guardrail_actions(
    org_id: str = Path(..., alias="org_id"),
    trace_id: str = Path(...),
    limit: int = Query(200, ge=1, le=1000),
    _org: dict = Depends(require_org_member),
):
    """Per-step guardrail action log. Spec §6 row 5."""
    rows = await fetch_guardrail_actions(org_id, trace_id, limit=limit)
    return GuardrailActionLog(trace_id=trace_id, actions=rows)


# ── Hot-path routes ────────────────────────────────────────────────


@router.post(
    "/guardrails/trajectory/check",
    response_model=TrajectoryCheckResponse,
)
async def post_trajectory_check(
    org_id: str = Path(..., alias="org_id"),
    req: TrajectoryCheckRequest = Body(...),
    user: dict = Depends(get_current_user),
    _org: dict = Depends(require_org_member),
):
    """Live per-step TrajectoryGuardrail evaluation.

    Runs the 8 hot-path checks (Cat 15 + Phase 4), reads the
    per-tenant kill switch (``tenant_guardrail_action_config``),
    and returns the recommended action + applied flag. Mutating
    actions (``block_user``, ``revoke_api_key``, ...) default
    ``applied=False``; read-only actions default ``applied=True``.

    The sidecar write-back to ``trace_guardrail_actions`` is
    best-effort. The hot-path MUST stay <5ms p99 over 1000-step
    workload (spec §3 + Invariant #3).
    """
    from eden.observability.trace_quality.hooks import (
        evaluate_trajectory_step,
    )

    result = await evaluate_trajectory_step(
        org_id=org_id,
        trace_id=req.trace_id,
        step_index=req.step_index,
        event=req.event,
        agent_id=req.agent_id,
    )
    await _write_audit(
        org_id,
        event_type="trace_quality.computed",
        payload={
            "trace_id": req.trace_id,
            "step_index": req.step_index,
            "action_class": result["action_class"],
            "recommended": result["recommended_action"],
            "applied": result["applied"],
        },
        user_id=(user or {}).get("user_id"),
    )
    return TrajectoryCheckResponse(**result)


@router.post(
    "/llmops/stat_gate/evaluate",
    response_model=StatGateEvaluateResponse,
)
async def post_stat_gate_evaluate(
    req: StatGateEvaluateRequest = Body(...),
    _user: dict = Depends(get_current_user),
):
    """Phase 6 5-check StatGate evaluation.

    Accepts control + treatment arrays (each ≥1 element) and
    returns the per-check breakdown + a final verdict
    (``APPLY`` iff all 5 checks pass). Used by the A/B decision
    paths in Cat 17 closed-loop and Cat 12 experiment hooks.
    """
    from supplementaries.phase_6_stat_gate.gate import evaluate_gate

    result = evaluate_gate(
        control=req.control,
        treatment=req.treatment,
        alpha=req.alpha,
        min_n=req.min_n,
    )
    return StatGateEvaluateResponse(**result.to_dict())


# ── Operator inbox routes ──────────────────────────────────────────


@router.get(
    "/guardrails/actions/pending",
    response_model=PendingActionsResponse,
)
async def get_pending_actions(
    org_id: str = Path(..., alias="org_id"),
    action_class: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    _org: dict = Depends(require_org_member),
):
    """Operator inbox — mutating actions NOT applied (kill switch off)."""
    rows = await fetch_pending_actions(
        org_id,
        action_class=action_class,
        limit=limit,
    )
    return PendingActionsResponse(actions=rows, count=len(rows))


@router.post(
    "/guardrails/actions/{action_id}/approve",
    response_model=ApproveActionResponse,
)
async def approve_action(
    org_id: str = Path(..., alias="org_id"),
    action_id: str = Path(...),
    user: dict = Depends(get_current_user),
    _org: dict = Depends(require_org_member),
):
    """Flip a single pending action from applied=False → applied=True."""
    row = await set_action_applied(
        org_id,
        action_id=action_id,
        applied=True,
        reason="operator_approved",
        user_id=(user or {}).get("user_id"),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="action_not_found")
    await _write_audit(
        org_id,
        event_type="trace_quality.action_approved",
        payload={"action_id": action_id, "applied": True},
        user_id=(user or {}).get("user_id"),
    )
    return ApproveActionResponse(
        action_id=action_id,
        applied=True,
        reason="operator_approved",
    )


# ── Admin kill-switch routes ───────────────────────────────────────


@router.post(
    "/admin/guardrails/{action_class}/enable",
    response_model=KillSwitchResponse,
)
async def enable_kill_switch(
    org_id: str = Path(..., alias="org_id"),
    action_class: str = Path(...),
    user: dict = Depends(get_current_user),
    _org: dict = Depends(require_org_admin),
):
    """Per-tenant per-action kill switch: enable auto-apply.

    Admin-only. Mutating actions are flagged in the audit log
    so operators can review high-blast-radius flips.
    """
    row = await set_tenant_action_config(
        org_id,
        action_class=action_class,
        applied_by_default=True,
        updated_by=(user or {}).get("user_id"),
    )
    await _write_audit(
        org_id,
        event_type="trace_quality.kill_switch.enabled",
        payload={
            "action_class": action_class,
            "applied_by_default": True,
        },
        user_id=(user or {}).get("user_id"),
    )
    return KillSwitchResponse(
        tenant_id=org_id,
        action_class=action_class,
        applied_by_default=True,
    )


@router.post(
    "/admin/guardrails/{action_class}/disable",
    response_model=KillSwitchResponse,
)
async def disable_kill_switch(
    org_id: str = Path(..., alias="org_id"),
    action_class: str = Path(...),
    user: dict = Depends(get_current_user),
    _org: dict = Depends(require_org_admin),
):
    """Per-tenant per-action kill switch: disable auto-apply."""
    row = await set_tenant_action_config(
        org_id,
        action_class=action_class,
        applied_by_default=False,
        updated_by=(user or {}).get("user_id"),
    )
    await _write_audit(
        org_id,
        event_type="trace_quality.kill_switch.disabled",
        payload={
            "action_class": action_class,
            "applied_by_default": False,
        },
        user_id=(user or {}).get("user_id"),
    )
    return KillSwitchResponse(
        tenant_id=org_id,
        action_class=action_class,
        applied_by_default=False,
    )


# ── Re-export for tests ────────────────────────────────────────────


__all__ = [
    "router",
    "TraceEfficiencyReport",
    "TraceLoopReport",
    "TraceQualityReport",
    "TraceReasoningReport",
    "GuardrailActionLog",
    "TrajectoryCheckRequest",
    "TrajectoryCheckResponse",
    "StatGateEvaluateRequest",
    "StatGateEvaluateResponse",
    "PendingActionsResponse",
    "ApproveActionResponse",
    "KillSwitchResponse",
]