"""Intelligence Gap — Tool Intelligence (Cat 7) routes.

Real implementation: 4 services under
``src/eden/services/tool_intel/`` (lazy re-exported via
:mod:`eden.services.tool_intel`). Each route delegates to its
service method, which returns the live ``ok`` envelope (or
``bad_request`` on invalid input). The
:class:`ToolAttributionScorer` and :class:`ToolComparator`
fire the closed-loop
:func:`PromotionHook.on_drift_alert` hook for material
success-rate drops (|Δ| ≥ 0.10 absolute) and large
inter-tool gaps (≥ 0.20) respectively.

The router keeps module-level instantiation (services are
lightweight — no LLM client, no judge registry) so the route
handlers stay trivial. See
``docs/observability-gap/07-tool-intelligence.md`` for the
per-service algorithm specs.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.services.tool_intel.services import (
    ToolAttributionScorer,
    ToolComparator,
    ToolRecommender,
    ToolRegistryTaxonomy,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/tools",
    tags=["intelligence-tools"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

_attr = ToolAttributionScorer()
_compare = ToolComparator()
_recommend = ToolRecommender()
_taxonomy = ToolRegistryTaxonomy()


class AttributionRequest(BaseModel):
    """Body for ``POST /tools/attribution``.

    The ``trace_id`` is optional — when provided, the
    scorer also returns the per-trace event list and
    writes a per-trace row to ``tool_attributions``. When
    omitted, the scorer is window-aggregate-only.
    """

    trace_id: str | None = None
    tool_id: str = Field(..., min_length=1, max_length=128)
    agent_id: str | None = None
    window: str = "30d"


class CompareRequest(BaseModel):
    """Body for ``POST /tools/compare``."""

    tool_a: str = Field(..., min_length=1, max_length=128)
    tool_b: str = Field(..., min_length=1, max_length=128)
    window: str = "7d"


class RecommendRequest(BaseModel):
    """Body for ``POST /tools/recommend``."""

    task_type: str | None = None
    agent_id: str | None = None
    k: int = Field(3, ge=1, le=10)


@router.post("/attribution")
async def attribution(
    org_id: str = Depends(require_path_org_access),
    body: AttributionRequest = Body(...),
) -> dict[str, Any]:
    """Per-tool attribution: success rate, latency,
    contribution score, and drift alerts vs. the previous
    same-length window."""
    return await _attr.score(
        org_id,
        trace_id=body.trace_id,
        tool_id=body.tool_id,
        agent_id=body.agent_id,
        window=body.window,
    )


@router.post("/compare")
async def compare(
    org_id: str = Depends(require_path_org_access),
    body: CompareRequest = Body(...),
) -> dict[str, Any]:
    """Two-tool comparison: success-rate / latency / cost
    diffs and a winner (or tie below the non-inferiority
    margin)."""
    return await _compare.compare(
        org_id,
        tool_a=body.tool_a,
        tool_b=body.tool_b,
        window=body.window,
    )


@router.post("/recommend")
async def recommend(
    org_id: str = Depends(require_path_org_access),
    body: RecommendRequest = Body(...),
) -> dict[str, Any]:
    """Top-K tool recommendations for a given task type +
    agent, weighted by success + material + latency + cost."""
    return await _recommend.recommend(
        org_id,
        task_type=body.task_type,
        agent_id=body.agent_id,
        k=body.k,
    )


@router.get("/taxonomy")
async def taxonomy(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    """The org's tool catalog + co-occurrence matrix
    (which tools tend to be called together)."""
    return await _taxonomy.taxonomy(org_id)
