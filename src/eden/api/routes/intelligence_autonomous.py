"""Intelligence Gap — Autonomous + NL Interface (Cat 14) routes.

ponytail: per upgradespec §D.4 (Phase 1 cut), the Cat 14
ship surface is:

* ``InvestigationAgent`` — single-shot RCA + remediation
  proposal (with folded ``report()`` + ``recommend()``
  methods per §D.4)
* ``SelfHealer`` — destructive surface (gated by
  ``require_org_admin`` + ``autonomous_actions_v0``)
* ``NLReportGenerator`` — NL → report

The removed services (``ReportGenerator``,
``RecommendationEngine``, ``NLQueryEngine``) are not
wired to routes in this file; ``AutoDashboardBuilder``
is also unwired — use the manual widget builder UI
instead (W3-10). No 501-returning stubs remain here.

The destructive ``/heal`` route remains gated by
``require_org_admin`` AND the ``autonomous_actions_v0``
feature flag (the umbrella flag for the whole autonomous
surface is ``intelligence_gap_v0``). The other routes are
gated by ``intelligence_gap_v0`` + ``get_current_user``
only — they are read-only / suggest-only.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path
from pydantic import BaseModel

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import safe_detail
from eden.autonomous import (
    InvestigationAgent,
    NLReportGenerator,
    SelfHealer,
)

logger = logging.getLogger(__name__)

# The umbrella feature flag for the whole Cat 14 surface.
_UMBRELLA_FLAG = "intelligence_gap_v0"
# The secondary flag that gates destructive actions
# (self-heal). OFF by default in production; an org must
# explicitly opt in via Settings.
_DESTRUCTIVE_FLAG = "autonomous_actions_v0"

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/autonomous",
    tags=["intelligence-autonomous"],
    dependencies=[
        Depends(require_feature_flag(_UMBRELLA_FLAG)),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

# Surviving autonomous services.
_investigator = InvestigationAgent()
# Destructive — guarded per-route below.
_healer = SelfHealer()

# Surviving NL Interface service.
_nl_report = NLReportGenerator()


class InvestigateRequest(BaseModel):
    # Primary contract (F48): a typed trigger, e.g.
    # ``incident:<uuid>``, ``drift_alert:<id>``, ``issue:<uuid>``.
    trigger: str | None = None
    # Back-compat shim for the portal, which historically sent
    # ``{question, trace_id?}``. When ``trigger`` is omitted we resolve
    # one server-side (trace_id → owning incident cluster). The free
    # text ``question`` is advisory context only.
    question: str | None = None
    trace_id: str | None = None


class ReportRequest(BaseModel):
    period: str = "weekly"


class HealRequest(BaseModel):
    action_type: str


class HealApproveRequest(BaseModel):
    approved_by_user_id: str


class HealDenyRequest(BaseModel):
    denied_by_user_id: str
    reason: str = ""


class HealExecuteRequest(BaseModel):
    approved_by_user_id: str


class NLReportRequest(BaseModel):
    request: str


async def _resolve_investigate_trigger(
    org_id: str, body: InvestigateRequest
) -> str | None:
    """Resolve a typed trigger from a portal ``{question, trace_id}``
    body (F48 shim). Returns ``None`` when no trigger can be derived.

    A ``trace_id`` is mapped to the incident cluster that owns it (the
    ``incident:`` trigger), which the ``InvestigationAgent`` already
    understands. When the trace is not part of any cluster we cannot
    build a meaningful trigger and return ``None`` so the caller can
    respond with a graceful envelope instead of a 422.
    """
    if body.trigger:
        return body.trigger
    if not body.trace_id:
        return None
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            raise HTTPException(status_code=503, detail="Postgres unavailable")
        row = await client.fetchrow(
            "SELECT cluster_id FROM incident_cluster_members "
            "WHERE org_id = $1 AND trace_id = $2 "
            "ORDER BY created_at DESC LIMIT 1",
            org_id,
            body.trace_id,
        )
    except HTTPException:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug(
            "investigate: trace→cluster lookup failed: %s",
            redact_all(str(exc)),
        )
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Failed to resolve investigation trigger"),
        ) from exc
    if row and row.get("cluster_id"):
        return f"incident:{row['cluster_id']}"
    return None


@router.post("/investigate")
async def investigate(
    org_id: str = Depends(require_path_org_access),
    body: InvestigateRequest = Body(...),
) -> dict[str, Any]:
    trigger = await _resolve_investigate_trigger(org_id, body)
    if not trigger:
        return {
            "status": "needs_trigger",
            "feature": "investigation",
            "live": True,
            "data": {
                "message": (
                    "Provide a 'trigger' (e.g. 'incident:<id>', "
                    "'issue:<id>', 'drift_alert:<id>') or a 'trace_id' "
                    "that belongs to a detected incident cluster."
                ),
                "findings": [],
                "proposed_remediations": [],
            },
        }
    return await _investigator.investigate(org_id, trigger=trigger)


@router.post("/report")
async def report(
    org_id: str = Depends(require_path_org_access),
    body: ReportRequest = Body(...),
) -> dict[str, Any]:
    return await _investigator.report(org_id, period=body.period)


@router.get("/recommendations")
async def recommendations(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    return await _investigator.recommend(org_id)


@router.post(
    "/heal",
    # Destructive surface: org admin + ``autonomous_actions_v0``.
    # Router-level ``get_current_user`` is overridden by
    # ``require_org_admin`` so non-admins can still hit read-only
    # Cat 14 routes but not heal/approve/deny/execute.
    dependencies=[
        Depends(require_feature_flag(_UMBRELLA_FLAG)),
        Depends(require_feature_flag(_DESTRUCTIVE_FLAG)),
        Depends(require_org_admin),
    ],
)
async def heal(
    org_id: str = Depends(require_path_org_access),
    body: HealRequest = Body(...),
) -> dict[str, Any]:
    return await _healer.heal(org_id, action_type=body.action_type)


@router.post(
    "/heal/{action_id}/approve",
    dependencies=[
        Depends(require_feature_flag(_UMBRELLA_FLAG)),
        Depends(require_feature_flag(_DESTRUCTIVE_FLAG)),
        Depends(require_org_admin),
    ],
)
async def heal_approve(
    org_id: str = Depends(require_path_org_access),
    action_id: str = Path(...),
    body: HealApproveRequest = Body(...),
) -> dict[str, Any]:
    return await _healer.approve(
        org_id, action_id,
        approved_by_user_id=body.approved_by_user_id,
    )


@router.post(
    "/heal/{action_id}/deny",
    dependencies=[
        Depends(require_feature_flag(_UMBRELLA_FLAG)),
        Depends(require_feature_flag(_DESTRUCTIVE_FLAG)),
        Depends(require_org_admin),
    ],
)
async def heal_deny(
    org_id: str = Depends(require_path_org_access),
    action_id: str = Path(...),
    body: HealDenyRequest = Body(...),
) -> dict[str, Any]:
    return await _healer.deny(
        org_id, action_id,
        denied_by_user_id=body.denied_by_user_id,
        reason=body.reason,
    )


@router.post(
    # Phase 3a (2026-06-23) — separate the approve click from the
    # execute click. The previous ``/heal/{id}/approve`` immediately
    # ran the destructive action; now approve flips status to
    # ``approved`` and the operator must POST to this endpoint as a
    # second confirmation. Same gating (admin + destructive flag)
    # as the approve route.
    "/heal/{action_id}/execute",
    dependencies=[
        Depends(require_feature_flag(_UMBRELLA_FLAG)),
        Depends(require_feature_flag(_DESTRUCTIVE_FLAG)),
        Depends(require_org_admin),
    ],
)
async def heal_execute(
    org_id: str = Depends(require_path_org_access),
    action_id: str = Path(...),
    body: HealExecuteRequest = Body(...),
) -> dict[str, Any]:
    return await _healer.execute_heal(
        org_id, action_id,
        approved_by_user_id=body.approved_by_user_id,
    )


@router.post("/nl/report")
async def nl_report(
    org_id: str = Depends(require_path_org_access),
    body: NLReportRequest = Body(...),
) -> dict[str, Any]:
    return await _nl_report.generate(org_id, request=body.request)
