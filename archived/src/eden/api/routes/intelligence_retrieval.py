"""Intelligence Gap — Retrieval Intelligence (Cat 4) routes.

Real implementation: 4 services under
``src/eden/kb/retrieval_intel/`` (lazy re-exported via
:mod:`eden.kb.retrieval_intel`). Each route delegates to its
service method, which returns the live ``ok`` envelope (or
the live ``bad_request`` envelope on invalid input).

The router keeps module-level instantiation (services are
lightweight — no LLM client, no judge registry) so the route
handlers stay trivial. See
``docs/observability-gap/04-retrieval-intelligence.md`` for
the per-service algorithm specs.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.kb.retrieval_intel.utilization import (
    ChunkAttribution,
    KnowledgeGapDetector,
    RetrievalReorderer,
    RetrievalUtilizationScorer,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/retrieval",
    tags=["intelligence-retrieval"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

_util = RetrievalUtilizationScorer()
_gaps = KnowledgeGapDetector()
_attr = ChunkAttribution()
_reorder = RetrievalReorderer()


class GapRequest(BaseModel):
    window: str = "7d"


class ReorderRequest(BaseModel):
    collection: str


@router.post("/{trace_id}/utilization")
async def utilization(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _util.score(org_id, trace_id)


@router.post("/gaps")
async def gaps(
    org_id: str = Depends(require_path_org_access),
    body: GapRequest = Body(...),
) -> dict[str, Any]:
    return await _gaps.detect(org_id, window=body.window)


@router.post("/{trace_id}/attribution")
async def attribution(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _attr.attribution(org_id, trace_id)


@router.post("/reorder")
async def reorder(
    org_id: str = Depends(require_path_org_access),
    body: ReorderRequest = Body(...),
) -> dict[str, Any]:
    return await _reorder.suggest(org_id, collection=body.collection)
