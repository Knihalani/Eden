"""Intelligence Gap — Quality domain router (Eval, Governance).

W3-6: consolidates deferred-router loading for:
  * intelligence_eval
  * intelligence_governance
"""
from __future__ import annotations

from fastapi import APIRouter

from eden.api.routes.intelligence_eval import router as _eval_router
from eden.api.routes.intelligence_governance import router as _governance_router

# Combined domain router — one deferred import instead of many.
router = APIRouter()
router.include_router(_eval_router)
router.include_router(_governance_router)
