"""Intelligence Gap — Data domain router (Retrieval, Columnar, Outcomes, Cost).

W3-6: consolidates deferred-router loading for:
  * intelligence_retrieval
  * intelligence_columnar
  * intelligence_outcomes
  * intelligence_cost
"""
from __future__ import annotations

from fastapi import APIRouter

from eden.api.routes.intelligence_retrieval import router as _retrieval_router
from eden.api.routes.intelligence_columnar import router as _columnar_router
from eden.api.routes.intelligence_outcomes import router as _outcomes_router
from eden.api.routes.intelligence_cost import router as _cost_router

# Combined domain router — one deferred import instead of many.
router = APIRouter()
router.include_router(_retrieval_router)
router.include_router(_columnar_router)
router.include_router(_outcomes_router)
router.include_router(_cost_router)
