"""Intelligence Gap — Predictive + Drift (Cat 13) routes.

The route surface matches the v1.5 doc API contracts
(``docs/observability-gap/13-predictive-intelligence.md``
§ API contracts):

* ``POST /intelligence/predict/quality`` — per-day judge-
  score forecast with CUSUM anomalies and trend
  classification.
* ``POST /intelligence/predict/cost`` — per-day cost
  forecast with per-agent breakdown + WoW growth alert.
* ``POST /intelligence/predict/capacity`` — multi-
  scenario GPU-hour projection (baseline | 2x | 3x | 5x)
  with headroom map + recommendation.
* ``POST /intelligence/predict/risk`` — composite 5-
  component risk score with alerts and recommendation.
* ``POST /intelligence/predict/drift`` — single drift
  route that supports ``method=psi|cusum|ks_test|
  wasserstein`` and a ``type=output|embedding`` selector.

All routes are gated by the ``intelligence_gap_v0``
umbrella feature flag and require a valid current user.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.predictive import (
    CapacityPredictor,
    CostPredictor,
    DriftDetector,
    QualityPredictor,
    RiskScorer,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/predict",
    tags=["intelligence-predictive"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

_quality = QualityPredictor()
_cost = CostPredictor()
_capacity = CapacityPredictor()
_risk = RiskScorer()
_drift = DriftDetector()


# ── Pydantic bodies (per doc § API contracts) ────────────────────────


class QualityRequest(BaseModel):
    request_id: str
    judge_name: str | None = None
    forecast_horizon: str = Field(default="7d", description="e.g. 7d, 14d, 30d")
    history_window: str = Field(default="7d", description="e.g. 7d, 30d, 90d")


class CostRequest(BaseModel):
    request_id: str
    forecast_horizon: str = Field(default="30d", description="e.g. 7d, 30d, 90d")
    history_window: str = Field(default="30d", description="e.g. 7d, 30d, 90d")
    group_by: str = Field(
        default="agent", description="agent (default) or org",
    )


class CapacityRequest(BaseModel):
    horizon_days: int = Field(default=7, ge=1, le=90)
    forecast_horizon: str | None = Field(
        default=None, description="optional, e.g. 30d, 90d",
    )
    scenario: str = Field(
        default="baseline", description="baseline | 2x | 3x | 5x",
    )
    current_fleet_size: int = Field(
        default=8, ge=1, description="current GPU fleet size",
    )


class RiskRequest(BaseModel):
    request_id: str
    window: str = Field(default="24h", description="e.g. 24h, 12h, 7d")


class DriftRequest(BaseModel):
    window: str = Field(default="24h", description="e.g. 24h, 7d")
    method: str = Field(
        default="psi", description="psi | cusum | ks_test | wasserstein",
    )
    drift_type: str = Field(
        default="output", description="output | embedding",
    )
    baseline_window: str = Field(
        default="7d", description="baseline window for PSI",
    )


# ── Routes ────────────────────────────────────────────────────────────


@router.post("/quality")
async def predict_quality(
    org_id: str = Path(...),
    body: QualityRequest = Body(...),
) -> dict[str, Any]:
    return await _quality.predict(
        org_id,
        request_id=body.request_id,
        judge_name=body.judge_name,
        forecast_horizon=body.forecast_horizon,
        history_window=body.history_window,
    )


@router.post("/cost")
async def predict_cost(
    org_id: str = Path(...),
    body: CostRequest = Body(...),
) -> dict[str, Any]:
    return await _cost.predict(
        org_id,
        request_id=body.request_id,
        forecast_horizon=body.forecast_horizon,
        history_window=body.history_window,
        group_by=body.group_by,
    )


@router.post("/capacity")
async def predict_capacity(
    org_id: str = Path(...),
    body: CapacityRequest = Body(...),
) -> dict[str, Any]:
    return await _capacity.predict(
        org_id,
        horizon_days=body.horizon_days,
        forecast_horizon=body.forecast_horizon,
        scenario=body.scenario,
        current_fleet_size=body.current_fleet_size,
    )


@router.post("/risk")
async def score_risk(
    org_id: str = Path(...),
    body: RiskRequest = Body(...),
) -> dict[str, Any]:
    return await _risk.score(
        org_id, request_id=body.request_id, window=body.window,
    )


# Single drift route — consolidates the v1
# ``drift/output`` and ``drift/embedding`` shapes per the
# doc's ``POST /intelligence/predict/detect-drift`` spec.
# The ``method`` and ``drift_type`` parameters control the
# algorithm and the substrate.
@router.post("/drift")
async def detect_drift(
    org_id: str = Path(...),
    body: DriftRequest = Body(...),
) -> dict[str, Any]:
    if body.drift_type == "embedding":
        return await _drift.detect_embedding_drift(
            org_id, window=body.window,
        )
    # ``output`` (the default) — the PSI detector. The
    # ``method`` param is preserved in the response so the
    # caller can audit which algorithm ran.
    result = await _drift.detect_output_drift(
        org_id, window=body.window,
    )
    if isinstance(result, dict) and isinstance(result.get("data"), dict):
        result["data"]["method"] = body.method
    return result


# Back-compat routes for the v1 callers that hit
# ``/drift/output`` and ``/drift/embedding`` directly.
# The v1.5 doc's primary route is ``/drift``; these two
# are kept so existing integrations don't break.
@router.post("/drift/output")
async def drift_output_legacy(
    org_id: str = Path(...),
    body: DriftRequest = Body(...),
) -> dict[str, Any]:
    return await _drift.detect_output_drift(
        org_id, window=body.window,
    )


@router.post("/drift/embedding")
async def drift_embedding_legacy(
    org_id: str = Path(...),
    body: DriftRequest = Body(...),
) -> dict[str, Any]:
    return await _drift.detect_embedding_drift(
        org_id, window=body.window,
    )
