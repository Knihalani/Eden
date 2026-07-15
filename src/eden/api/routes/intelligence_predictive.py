"""Intelligence Gap — Predictive + Drift (Cat 13) routes.

ponytail: per upgradespec §D.3 (Phase 1 cut), Cat 13 ships
only :class:`QualityPredictor` and :class:`DriftDetector`.
The ``cost`` / ``capacity`` / ``risk`` / embedding-drift
routes were removed; the deep-link endpoints return a
stable 501 envelope pointing at the deferred-roadmap doc.

The Cat 8 Cost Intelligence already covers the per-day
median projection (the trailing-median logic from
``CostPredictor`` was folded into Cat 7 — see
``docs/eden-cost-intel-plan.md``).

The embedding-drift detector was removed; the output-drift
detector (PSI on judge-score distribution) remains the
single ship-ready drift surface.

Mounted at ``/orgs/{org_id}/intelligence/predict`` so the
prefix is preserved and deep-linked portal pages resolve
to 501 rather than 404.

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
from eden.predictive import DriftDetector, QualityPredictor

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


class DriftRequest(BaseModel):
    window: str = Field(default="24h", description="e.g. 24h, 7d")
    method: str = Field(
        default="psi", description="psi | cusum | ks_test | wasserstein",
    )
    baseline_window: str = Field(
        default="7d", description="baseline window for PSI",
    )


# ── Routes (kept) ────────────────────────────────────────────────────


@router.post("/quality")
async def predict_quality(
    org_id: str = Path(...),
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


@router.post("/drift")
async def detect_drift(
    org_id: str = Path(...),
    body: DriftRequest = Body(default_factory=DriftRequest),
) -> dict[str, Any]:
    """PSI-based output drift detector on judge-score distribution."""
    result = await _drift.detect_output_drift(
        org_id, window=body.window,
    )
    if isinstance(result, dict) and isinstance(result.get("data"), dict):
        result["data"]["method"] = body.method
    return result


