"""Intelligence Gap — Observability domain router (APM depth, RCA, Replay).

W3-6: consolidates deferred-router loading for:
  * intelligence_apm_depth
  * intelligence_rca
  * intelligence_replay
"""
from __future__ import annotations

from fastapi import APIRouter

from eden.api.routes.intelligence_apm_depth import router as _apm_depth_router
from eden.api.routes.intelligence_rca import router as _rca_router
from eden.api.routes.intelligence_replay import router as _replay_router

# Combined domain router — one deferred import instead of many.
router = APIRouter()
router.include_router(_apm_depth_router)
router.include_router(_rca_router)
router.include_router(_replay_router)
