"""Intelligence Gap — Memory Intelligence (Cat 5) routes.

The services under :mod:`eden.kb.episodic.memory_intel` are
real (non-stub) implementations as of 2026-06-11 — see
``docs/observability-gap/05-memory-intelligence.md``.

Surface (4 routes):

* ``POST /{trace_id}/attribute`` — per-memory influence
  scores for a trace; persists to ``memory_attributions``.
* ``GET  /timeline/{memory_id}`` — full lifecycle (created
  / updated / deleted / accessed) for one memory; reads
  from ``memory_timeline_events``.
* ``POST /{trace_id}/impact`` — per-memory impact scores;
  persists to ``memory_impact_scores``.
* ``POST /reaver/suggest`` — merge / archive / demote
  *suggestions* (never destructive; see the appendix for
  the deferred admin endpoint).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.kb.episodic.memory_intel.attributor import (
    MemoryAttributor,
    MemoryImpactScorer,
    MemoryReweaver,
    MemoryTimelineBuilder,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/memory",
    tags=["intelligence-memory"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

# Stateless singletons — the services are re-runnable (the
# Cat 5 tables have no unique constraint, so the helpers use
# the delete-then-insert pattern in :mod:`_common`).
_attributor = MemoryAttributor()
_timeline = MemoryTimelineBuilder()
_impact = MemoryImpactScorer()
_reaver = MemoryReweaver()


class ReweaverRequest(BaseModel):
    memory_id: str = ""
    window: str = "30d"


@router.post("/{trace_id}/attribute")
async def attribute(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _attributor.attribute(org_id, trace_id)


@router.get("/timeline/{memory_id}")
async def timeline(
    org_id: str = Depends(require_path_org_access),
    memory_id: str = Path(...),
) -> dict[str, Any]:
    return await _timeline.timeline(org_id, memory_id=memory_id)


@router.post("/{trace_id}/impact")
async def impact(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _impact.score(org_id, trace_id)


@router.post("/reaver/suggest")
async def reaver_suggest(
    org_id: str = Depends(require_path_org_access),
    body: ReweaverRequest = Body(...),
) -> dict[str, Any]:
    return await _reaver.suggest(
        org_id, memory_id=body.memory_id, window=body.window,
    )
