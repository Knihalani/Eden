"""Intelligence Gap — Predictive + Drift (Cat 13) routes.

Live surfaces:

* :class:`QualityPredictor` — per-day judge-score forecast
* :class:`CostPredictor` — per-day cost forecast (Postgres
  aggregates; documents ClickHouse→Postgres assumptions)
* :class:`CapacityPredictor` — multi-scenario GPU-hour
  projection
* :class:`RiskScorer` — composite 5-component risk
* :class:`DriftDetector` — output + embedding PSI drift

Mounted at ``/orgs/{org_id}/intelligence/predict``.

Gates:
* ``intelligence_gap_v0`` umbrella flag
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth
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


# ── Pydantic bodies ──────────────────────────────────────────────────


class QualityRequest(BaseModel):
    # LP-12: portal historically sent ``{horizon_days}`` without
    # ``request_id`` → 422. Accept both shapes; mint a request_id
    # when the client omits it.
    request_id: str | None = Field(
        default=None,
        description="Correlation id for predict-vs-actuals; auto-minted when omitted.",
    )
    judge_name: str | None = None
    forecast_horizon: str = Field(default="7d", description="e.g. 7d, 14d, 30d")
    history_window: str = Field(default="7d", description="e.g. 7d, 30d, 90d")
    # Portal alias — ``{horizon_days: 7}`` maps onto forecast_horizon.
    horizon_days: int | None = Field(default=None, ge=1, le=90)


class CostRequest(BaseModel):
    request_id: str | None = Field(
        default=None,
        description="Correlation id; auto-minted when omitted.",
    )
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
    request_id: str | None = Field(
        default=None,
        description="Correlation id; auto-minted when omitted.",
    )
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


def _mint_request_id(prefix: str, explicit: str | None) -> str:
    if explicit and explicit.strip():
        return explicit.strip()
    import uuid

    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# ── Routes ────────────────────────────────────────────────────────────


@router.post("/quality")
async def predict_quality(
    org_id: str = Path(...),
    body: QualityRequest = Body(...),
) -> dict[str, Any]:
    """Per-day judge-score forecast with CUSUM anomalies."""
    request_id = _mint_request_id("portal", body.request_id)
    forecast_horizon = body.forecast_horizon
    if body.horizon_days is not None:
        forecast_horizon = f"{body.horizon_days}d"
    return await _quality.predict(
        org_id,
        request_id=request_id,
        judge_name=body.judge_name,
        forecast_horizon=forecast_horizon,
        history_window=body.history_window,
    )


@router.post("/cost")
async def predict_cost(
    org_id: str = Path(...),
    body: CostRequest = Body(default_factory=CostRequest),
) -> dict[str, Any]:
    """Per-day cost forecast from Postgres usage aggregates."""
    return await _cost.predict(
        org_id,
        request_id=_mint_request_id("cost", body.request_id),
        forecast_horizon=body.forecast_horizon,
        history_window=body.history_window,
        group_by=body.group_by,
    )


@router.post("/capacity")
async def predict_capacity(
    org_id: str = Path(...),
    body: CapacityRequest = Body(default_factory=CapacityRequest),
) -> dict[str, Any]:
    """Multi-scenario GPU-hour capacity projection."""
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
    body: RiskRequest = Body(default_factory=RiskRequest),
) -> dict[str, Any]:
    """Composite 5-component org risk score."""
    return await _risk.score(
        org_id,
        request_id=_mint_request_id("risk", body.request_id),
        window=body.window,
    )


@router.post("/drift")
async def detect_drift(
    org_id: str = Path(...),
    body: DriftRequest = Body(default_factory=DriftRequest),
) -> dict[str, Any]:
    """PSI-based drift detector (output or embedding)."""
    if body.drift_type == "embedding":
        return await _drift.detect_embedding_drift(
            org_id, window=body.window,
        )
    result = await _drift.detect_output_drift(
        org_id, window=body.window,
    )
    if isinstance(result, dict) and isinstance(result.get("data"), dict):
        result["data"]["method"] = body.method
    return result


@router.post("/drift/output")
async def drift_output_legacy(
    org_id: str = Path(...),
    body: DriftRequest = Body(default_factory=DriftRequest),
) -> dict[str, Any]:
    """v1 back-compat alias for output drift."""
    return await detect_drift(
        org_id,
        DriftRequest(
            window=body.window,
            method=body.method,
            drift_type="output",
            baseline_window=body.baseline_window,
        ),
    )


@router.post("/drift/embedding")
async def drift_embedding_legacy(
    org_id: str = Path(...),
    body: DriftRequest = Body(default_factory=DriftRequest),
) -> dict[str, Any]:
    """Embedding / topic drift via hash-bucket PSI proxy."""
    return await _drift.detect_embedding_drift(
        org_id, window=body.window,
    )
