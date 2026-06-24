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
    request_id: str
    judge_name: str | None = None
    forecast_horizon: str = Field(default="7d", description="e.g. 7d, 14d, 30d")
    history_window: str = Field(default="7d", description="e.g. 7d, 30d, 90d")


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
    return await _quality.predict(
        org_id,
        request_id=body.request_id,
        judge_name=body.judge_name,
        forecast_horizon=body.forecast_horizon,
        history_window=body.history_window,
    )


@router.post("/drift")
async def detect_drift(
    org_id: str = Path(...),
    body: DriftRequest = Body(...),
) -> dict[str, Any]:
    """PSI-based output drift detector on judge-score distribution."""
    result = await _drift.detect_output_drift(
        org_id, window=body.window,
    )
    if isinstance(result, dict) and isinstance(result.get("data"), dict):
        result["data"]["method"] = body.method
    return result


# ── Routes (removed per §D.3) ────────────────────────────────────────


def _deferred(message: str) -> dict[str, Any]:
    """Stable 501-shape envelope for endpoints cut per upgradespec §D.3."""
    return {
        "status": "not_implemented",
        "feature": "predictive_v15",
        "live": False,
        "message": message,
        "data": {
            "deferred_roadmap": "docs/eden-predictive-roadmap.md",
        },
    }


@router.post("/cost")
async def predict_cost(org_id: str = Path(...)) -> dict[str, Any]:
    """Removed per §D.3 — per-day median projection now lives in Cat 7
    (Cost Intelligence) as ``CostForecast.median_projection``."""
    return _deferred("CostPredictor removed; median projection in Cat 7.")


@router.post("/capacity")
async def predict_capacity(org_id: str = Path(...)) -> dict[str, Any]:
    """Removed per §D.3."""
    return _deferred("CapacityPredictor removed per upgradespec §D.3.")


@router.post("/risk")
async def score_risk(org_id: str = Path(...)) -> dict[str, Any]:
    """Removed per §D.3."""
    return _deferred("RiskScorer removed per upgradespec §D.3.")


@router.post("/drift/embedding")
async def drift_embedding_legacy(org_id: str = Path(...)) -> dict[str, Any]:
    """Removed per §D.3 — embedding drift detector was experimental;
    re-add when a learned embedding model ships (v1.4 swap-in)."""
    return _deferred("Embedding drift removed per upgradespec §D.3.")