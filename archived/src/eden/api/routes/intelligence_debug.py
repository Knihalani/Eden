"""Intelligence Gap — Debug domain router (Time Travel, DSL, Memory).

W3-6: consolidates deferred-router loading for:
  * intelligence_time_travel
  * intelligence_dsl
  * intelligence_memory
"""
from __future__ import annotations

from fastapi import APIRouter

from eden.api.routes.intelligence_time_travel import router as _time_travel_router
from eden.api.routes.intelligence_dsl import router as _dsl_router
from eden.api.routes.intelligence_memory import router as _memory_router

# Combined domain router — one deferred import instead of many.
router = APIRouter()
router.include_router(_time_travel_router)
router.include_router(_dsl_router)
router.include_router(_memory_router)
