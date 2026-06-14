"""Intelligence Gap — Governance (Cat 10) routes.

10 routes spread across 4 sub-surfaces:

* **Approvals** (4 routes) — create / request / resolve / list
* **Compliance** (3 routes) — generate / list / get
* **Security** (2 routes) — scan / list-runs
* **GDPR + Lineage + Dashboard** (3 routes) — rtbf / lineage /
  dashboard

The intelligence-gap umbrella feature flag still gates the
whole surface. ``get_current_user`` is required on every
route (the spec wants every governance call audit-logged with
an actor).

Mirrors the route style of
:mod:`eden.api.routes.intelligence_outcomes` (Cat 11) and
:mod:`eden.api.routes.intelligence_user` (Cat 9).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.services.governance_intel import (
    ApprovalWorkflowService,
    ComplianceDashboardService,
    ComplianceEvidenceGenerator,
    DataLineageService,
    RightToBeForgottenService,
    SecurityScanner,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/governance",
    tags=["intelligence-governance"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

_approvals = ApprovalWorkflowService()
_evidence = ComplianceEvidenceGenerator()
_scanner = SecurityScanner()
_rtbf = RightToBeForgottenService()
_lineage = DataLineageService()
_dashboard = ComplianceDashboardService()


# ────────────────────────────────────────────────────────────────────
#  Request models
# ────────────────────────────────────────────────────────────────────


class ApprovalCreateRequest(BaseModel):
    """Body for ``POST /approvals``."""

    name: str
    resource_type: str | None = None
    required_approvers: int = 1
    ttl_seconds: int = 3600
    auto_approve_if_no_response: bool = False
    steps: list[dict[str, Any]] = Field(default_factory=list)


class ApprovalRequestRequest(BaseModel):
    """Body for ``POST /approvals/request``."""

    workflow_id: str
    action: str
    target: str | None = None
    value: Any = None
    rationale: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class ApprovalResolveRequest(BaseModel):
    """Body for ``POST /approvals/{request_id}/resolve``."""

    decision: str  # "approve" | "deny"
    rationale: str | None = None


class ComplianceGenerateRequest(BaseModel):
    """Body for ``POST /compliance/generate``."""

    framework: str
    period_start: str
    period_end: str


class CompliancePeriodRequest(BaseModel):
    """Legacy body for the 3 framework-specific routes."""

    period_start: str
    period_end: str


class SecurityScanRequest(BaseModel):
    """Body for ``POST /security/scan``."""

    window_start: str | None = None
    window_end: str | None = None
    scanners: list[str] | None = None
    scope: str = "all"
    redact_in_place: bool = True
    limit: int = 10000


class RTBFRequest(BaseModel):
    """Body for ``POST /rtbf``."""

    user_id: str
    sla_days: int = 14
    dry_run: bool = False


class LineageRequest(BaseModel):
    """Body for ``POST /lineage``."""

    resource_type: str
    resource_id: str
    depth: int = 2


# ────────────────────────────────────────────────────────────────────
#  Helpers
# ────────────────────────────────────────────────────────────────────


def _actor_id(user: Any) -> str:
    """Extract the actor id from the ``get_current_user`` result.

    Defensive — ``user`` may be a dict, a pydantic model, or a
    plain str depending on the auth layer. Falls back to
    ``"system"``.
    """
    if user is None:
        return "system"
    if isinstance(user, str):
        return user
    for attr in ("id", "user_id", "sub", "email"):
        v = user.get(attr) if isinstance(user, dict) else getattr(user, attr, None)
        if v:
            return str(v)
    return "system"


# ────────────────────────────────────────────────────────────────────
#  Approvals (4 routes)
# ────────────────────────────────────────────────────────────────────


@router.post("/approvals")
async def create_approval(
    body: ApprovalCreateRequest,
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _approvals.create(
        org_id,
        name=body.name,
        resource_type=body.resource_type,
        required_approvers=body.required_approvers,
        ttl_seconds=body.ttl_seconds,
        auto_approve_if_no_response=body.auto_approve_if_no_response,
        steps=body.steps,
    )


@router.post("/approvals/request")
async def request_approval(
    body: ApprovalRequestRequest,
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _approvals.request(
        org_id,
        workflow_id=body.workflow_id,
        requested_by=_actor_id(user),
        action=body.action,
        target=body.target,
        value=body.value,
        rationale=body.rationale,
        payload=body.payload,
    )


@router.post("/approvals/{request_id}/resolve")
async def resolve_approval(
    body: ApprovalResolveRequest,
    org_id: str = Path(...),
    request_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _approvals.resolve(
        org_id,
        request_id=request_id,
        approver=_actor_id(user),
        decision=body.decision,
        rationale=body.rationale,
    )


@router.get("/approvals")
async def list_approvals(
    org_id: str = Path(...),
    state: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _approvals.list_requests(
        org_id, state=state, limit=limit,
    )


# ────────────────────────────────────────────────────────────────────
#  Compliance (3 routes + 4 legacy framework routes)
# ────────────────────────────────────────────────────────────────────


@router.post("/compliance/generate")
async def generate_compliance(
    body: ComplianceGenerateRequest,
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _evidence.generate(
        org_id,
        framework=body.framework,
        period_start=body.period_start,
        period_end=body.period_end,
        generated_by=_actor_id(user),
    )


@router.get("/compliance/packs")
async def list_compliance_packs(
    org_id: str = Path(...),
    framework: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _evidence.list_packs(
        org_id, framework=framework, limit=limit,
    )


@router.get("/compliance/packs/{evidence_pack_id}")
async def get_compliance_pack(
    org_id: str = Path(...),
    evidence_pack_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _evidence.get_pack(
        org_id, evidence_pack_id=evidence_pack_id,
    )


# ── Legacy framework-specific routes (kept for SDK back-compat) ──


@router.post("/compliance/soc2")
async def soc2(
    body: CompliancePeriodRequest,
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _evidence.generate_soc2_evidence(
        org_id,
        period_start=body.period_start,
        period_end=body.period_end,
        generated_by=_actor_id(user),
    )


@router.post("/compliance/hipaa")
async def hipaa(
    body: CompliancePeriodRequest,
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _evidence.generate_hipaa_evidence(
        org_id,
        period_start=body.period_start,
        period_end=body.period_end,
        generated_by=_actor_id(user),
    )


@router.post("/compliance/gdpr")
async def gdpr(
    body: CompliancePeriodRequest,
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _evidence.generate_gdpr_evidence(
        org_id,
        period_start=body.period_start,
        period_end=body.period_end,
        generated_by=_actor_id(user),
    )


@router.post("/compliance/iso27001")
async def iso27001(
    body: CompliancePeriodRequest,
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _evidence.generate_iso27001_evidence(
        org_id,
        period_start=body.period_start,
        period_end=body.period_end,
        generated_by=_actor_id(user),
    )


# ────────────────────────────────────────────────────────────────────
#  Security (2 routes)
# ────────────────────────────────────────────────────────────────────


@router.post("/security/scan")
async def security_scan(
    body: SecurityScanRequest | None = None,
    org_id: str = Path(...),
    scope: str | None = Query(None),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    """Run a PII / sensitive-data scan.

    Accepts a body for the full surface, or a query-string ``scope``
    for the legacy v0 path.
    """
    if body is None:
        body = SecurityScanRequest(scope=scope or "all")
    elif scope is not None:
        body = body.model_copy(update={"scope": scope})
    return await _scanner.scan_for_pii_leakage(
        org_id,
        window_start=body.window_start,
        window_end=body.window_end,
        scanners=body.scanners,
        scope=body.scope,
        redact_in_place=body.redact_in_place,
        limit=body.limit,
    )


@router.get("/security/scans")
async def list_security_scans(
    org_id: str = Path(...),
    limit: int = Query(50, ge=1, le=200),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _scanner.list_runs(org_id, limit=limit)


# ────────────────────────────────────────────────────────────────────
#  v2 surfaces — RTBF, Lineage, Dashboard (3 routes)
# ────────────────────────────────────────────────────────────────────


@router.post("/rtbf")
async def process_rtbf(
    body: RTBFRequest,
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _rtbf.process_request(
        org_id,
        user_id=body.user_id,
        requested_by=_actor_id(user),
        sla_days=body.sla_days,
        dry_run=body.dry_run,
    )


@router.post("/lineage")
async def trace_lineage(
    body: LineageRequest,
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _lineage.trace(
        org_id,
        resource_type=body.resource_type,
        resource_id=body.resource_id,
        depth=body.depth,
    )


@router.get("/dashboard")
async def get_dashboard(
    org_id: str = Path(...),
    user: Any = Depends(get_current_user),
) -> dict[str, Any]:
    return await _dashboard.aggregate(org_id)
