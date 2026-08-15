"""Intelligence Gap — Predictive + Drift (Cat 13) routes.

Ships all 5 Cat 13 services: :class:`QualityPredictor`,
:class:`CostPredictor`, :class:`CapacityPredictor`,
:class:`RiskScorer`, and :class:`DriftDetector` (output +
embedding). ``/drift`` is the v2 consolidated route that
dispatches on the ``drift_type`` body field; ``/drift/output``
and ``/drift/embedding`` are kept as v1 routes for back-compat
with existing deep links.

The Cat 8 Cost Intelligence's trailing-median forecast is a
narrower single-number projection; :class:`CostPredictor` here
is the fuller per-day + per-agent breakdown service (see
``docs/observability-gap/13-predictive-intelligence.md``).

Mounted at ``/orgs/{org_id}/intelligence/predict``.

Gates:
* ``intelligence_gap_v0`` umbrella flag
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
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
        Depends(require_path_org_access),
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
    request_id: str | None = Field(default=None)
    forecast_horizon: str = Field(default="30d", description="e.g. 7d, 30d, 90d")
    history_window: str = Field(default="30d", description="e.g. 7d, 30d, 90d")
    group_by: str = Field(default="agent", description="agent | org")


class CapacityRequest(BaseModel):
    horizon_days: int = Field(default=7, ge=1, le=90)
    forecast_horizon: str | None = None
    scenario: str = Field(default="baseline")
    current_fleet_size: int | None = None


class RiskRequest(BaseModel):
    request_id: str | None = Field(default=None)
    window: str = Field(default="24h", description="e.g. 24h, 7d")


class DriftRequest(BaseModel):
    window: str = Field(default="24h", description="e.g. 24h, 7d")
    method: str = Field(
        default="psi", description="psi | cusum | ks_test | wasserstein",
    )
    baseline_window: str = Field(
        default="7d", description="baseline window for PSI",
    )
    drift_type: str = Field(
        default="output", description="output | embedding",
    )


# ── Routes ───────────────────────────────────────────────────────────


@router.post("/quality")
async def predict_quality(
    org_id: str = Depends(require_path_org_access),
    body: QualityRequest = Body(...),
) -> dict[str, Any]:
    """Per-day judge-score forecast with CUSUM anomalies."""
    import uuid

    request_id = body.request_id or f"portal-{uuid.uuid4().hex[:12]}"
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
    org_id: str = Depends(require_path_org_access),
    body: CostRequest = Body(default_factory=CostRequest),
) -> dict[str, Any]:
    """Per-day cost forecast with per-agent breakdown + WoW alert."""
    import uuid

    request_id = body.request_id or f"portal-{uuid.uuid4().hex[:12]}"
    return await _cost.predict(
        org_id,
        request_id=request_id,
        forecast_horizon=body.forecast_horizon,
        history_window=body.history_window,
        group_by=body.group_by,
    )


@router.post("/capacity")
async def predict_capacity(
    org_id: str = Depends(require_path_org_access),
    body: CapacityRequest = Body(default_factory=CapacityRequest),
) -> dict[str, Any]:
    """N-day GPU-hour demand projection under a demand scenario."""
    kwargs: dict[str, Any] = {
        "horizon_days": body.horizon_days,
        "forecast_horizon": body.forecast_horizon,
        "scenario": body.scenario,
    }
    if body.current_fleet_size is not None:
        kwargs["current_fleet_size"] = body.current_fleet_size
    return await _capacity.predict(org_id, **kwargs)


@router.post("/risk")
async def score_risk(
    org_id: str = Depends(require_path_org_access),
    body: RiskRequest = Body(default_factory=RiskRequest),
) -> dict[str, Any]:
    """Composite org risk score (judge-score / cost-CV / latency-p95 / drift)."""
    import uuid

    request_id = body.request_id or f"portal-{uuid.uuid4().hex[:12]}"
    return await _risk.score(org_id, request_id=request_id, window=body.window)


@router.post("/drift/output")
async def detect_output_drift_v1(
    org_id: str = Depends(require_path_org_access),
    body: DriftRequest = Body(default_factory=DriftRequest),
) -> dict[str, Any]:
    """v1 route (back-compat): PSI-based output drift on judge scores."""
    return await _drift.detect_output_drift(org_id, window=body.window)


@router.post("/drift/embedding")
async def detect_embedding_drift_v1(
    org_id: str = Depends(require_path_org_access),
    body: DriftRequest = Body(default_factory=DriftRequest),
) -> dict[str, Any]:
    """v1 route (back-compat): embedding/topic drift on response text."""
    return await _drift.detect_embedding_drift(org_id, window=body.window)


@router.post("/drift")
async def detect_drift(
    org_id: str = Depends(require_path_org_access),
    body: DriftRequest = Body(default_factory=DriftRequest),
) -> dict[str, Any]:
    """v2 consolidated drift route — dispatches on ``drift_type``
    (``output`` default, or ``embedding``).
    """
    if body.drift_type == "embedding":
        result = await _drift.detect_embedding_drift(org_id, window=body.window)
    else:
        result = await _drift.detect_output_drift(org_id, window=body.window)
    if isinstance(result, dict) and isinstance(result.get("data"), dict):
        result["data"]["method"] = body.method
    return result


