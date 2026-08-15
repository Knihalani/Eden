"""Intelligence Gap — MLOps domain router (Experiments, Predictive, Metric Studio).

W3-6: consolidates deferred-router loading for:
  * intelligence_experiments
  * intelligence_predictive
  * intelligence_metric_studio
"""
from __future__ import annotations

from fastapi import APIRouter

from eden.api.routes.intelligence_experiments import router as _experiments_router
from eden.api.routes.intelligence_predictive import router as _predictive_router
from eden.api.routes.intelligence_metric_studio import router as _metric_studio_router

# Combined domain router — one deferred import instead of many.
router = APIRouter()
router.include_router(_experiments_router)
router.include_router(_predictive_router)
router.include_router(_metric_studio_router)
