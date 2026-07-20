"""Intelligence Gap — Cost Intelligence (Cat 8) routes.

Real implementation: 4 services under
``src/eden/services/cost_intel/`` (lazy re-exported via
:mod:`eden.services.cost_intel`). Each route delegates to its
service method, which returns the live ``ok`` envelope (or
``bad_request`` on invalid input). The
:class:`CostAnomalyDetector` fires the closed-loop
:func:`PromotionHook.on_drift_alert` hook for each
high-severity (|z| > 4) cost anomaly.

The router keeps module-level instantiation (services are
lightweight — no LLM client, no judge registry) so the route
handlers stay trivial. See
``docs/observability-gap/08-cost-intelligence.md`` for the
per-service algorithm specs.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.services.cost_intel.efficiency import (
    CostAnomalyDetector,
    CostEfficiencyScorer,
    CostForecast,
    ROIAnalyzer,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/cost",
    tags=["intelligence-cost"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

_eff = CostEfficiencyScorer()
_roi = ROIAnalyzer()
_anom = CostAnomalyDetector()
_forecast = CostForecast()


class EfficiencyRequest(BaseModel):
    group_by: str = "outcome_type"
    window: str = "7d"


class ROIRequest(BaseModel):
    window: str = "30d"


class AnomalyRequest(BaseModel):
    window: str = "7d"


@router.post("/efficiency")
async def efficiency(
    org_id: str = Depends(require_path_org_access),
    body: EfficiencyRequest = Body(...),
) -> dict[str, Any]:
    return await _eff.score(
        org_id, group_by=body.group_by, window=body.window
    )


@router.post("/roi")
async def roi(
    org_id: str = Depends(require_path_org_access),
    body: ROIRequest = Body(...),
) -> dict[str, Any]:
    return await _roi.roi(org_id, window=body.window)


@router.post("/anomalies")
async def anomalies(
    org_id: str = Depends(require_path_org_access),
    body: AnomalyRequest = Body(...),
) -> dict[str, Any]:
    return await _anom.detect(org_id, window=body.window)


@router.get("/forecast")
async def forecast(
    org_id: str = Depends(require_path_org_access),
    horizon_days: int = Query(7, ge=1, le=90),
) -> dict[str, Any]:
    return await _forecast.forecast(org_id, horizon_days=horizon_days)
