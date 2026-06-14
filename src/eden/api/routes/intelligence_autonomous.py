"""Intelligence Gap — Autonomous + NL Interface (Cat 14) routes.

The destructive ``/heal`` route is gated by
``require_org_admin`` AND the ``autonomous_actions_v0``
feature flag (the umbrella flag for the whole autonomous
surface is ``intelligence_gap_v0``). The other 6 routes
are gated by ``intelligence_gap_v0`` + ``get_current_user``
only — they are read-only / suggest-only.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
)
from eden.autonomous import (
    AutoDashboardBuilder,
    InvestigationAgent,
    NLQueryEngine,
    NLReportGenerator,
    RecommendationEngine,
    ReportGenerator,
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
    ],
)

# The 4 base autonomous services.
_investigator = InvestigationAgent()
_reporter = ReportGenerator()
_rec_engine = RecommendationEngine()
# Destructive — guarded per-route below.
_healer = SelfHealer()

# The 3 NL Interface services.
_nl = NLQueryEngine()
_dash = AutoDashboardBuilder()
_nl_report = NLReportGenerator()


class InvestigateRequest(BaseModel):
    trigger: str


class ReportRequest(BaseModel):
    period: str = "weekly"


class HealRequest(BaseModel):
    action_type: str


class NLQueryRequest(BaseModel):
    question: str


class DashboardRequest(BaseModel):
    description: str


class NLReportRequest(BaseModel):
    request: str


@router.post("/investigate")
async def investigate(
    org_id: str = Path(...),
    body: InvestigateRequest = Body(...),
) -> dict[str, Any]:
    return await _investigator.investigate(org_id, trigger=body.trigger)


@router.post("/report")
async def report(
    org_id: str = Path(...),
    body: ReportRequest = Body(...),
) -> dict[str, Any]:
    return await _reporter.generate(org_id, period=body.period)


@router.get("/recommendations")
async def recommendations(org_id: str = Path(...)) -> dict[str, Any]:
    return await _rec_engine.recommend(org_id)


@router.post(
    "/heal",
    # The heal endpoint is the only destructive route in
    # Cat 14. We override the router-level ``get_current_user``
    # dependency with ``require_org_admin`` so a non-admin
    # member can hit the other 6 routes but not this one.
    # The destructive-flag check happens inside the service
    # itself (so the test suite can exercise the queue path
    # without the flag).
    dependencies=[
        Depends(require_feature_flag(_UMBRELLA_FLAG)),
        Depends(require_org_admin),
    ],
)
async def heal(
    org_id: str = Path(...),
    body: HealRequest = Body(...),
) -> dict[str, Any]:
    return await _healer.heal(org_id, action_type=body.action_type)


@router.post("/nl/query")
async def nl_query(
    org_id: str = Path(...),
    body: NLQueryRequest = Body(...),
) -> dict[str, Any]:
    return await _nl.query(org_id, question=body.question)


@router.post("/nl/dashboard")
async def nl_dashboard(
    org_id: str = Path(...),
    body: DashboardRequest = Body(...),
) -> dict[str, Any]:
    return await _dash.build(org_id, description=body.description)


@router.post("/nl/report")
async def nl_report(
    org_id: str = Path(...),
    body: NLReportRequest = Body(...),
) -> dict[str, Any]:
    return await _nl_report.generate(org_id, request=body.request)
