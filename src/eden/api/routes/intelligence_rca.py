"""Intelligence Gap — RCA & Incidents (Cat 2) routes."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_path_org_access,
)
from eden.insights.incidents.clusterer import IncidentClusterer, IncidentStore
from eden.insights.rca._common import _resolve_incident_cluster
from eden.insights.rca.analyzer import RootCauseAnalyzer

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/rca",
    tags=["intelligence-rca"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

_rca = RootCauseAnalyzer()
_clusterer = IncidentClusterer()
_store = IncidentStore()


class ClusterRequest(BaseModel):
    window: str = "24h"
    min_cluster_size: int = 3


class ResolveIncidentRequest(BaseModel):
    note: str = Field(default="", max_length=2000)


@router.post("/{trace_id}/analyze")
async def analyze(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _rca.categorize(org_id, trace_id)


@router.get("/{trace_id}/explain")
async def explain(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _rca.explain(org_id, trace_id)


@router.post("/incidents/cluster")
async def cluster(
    org_id: str = Depends(require_path_org_access),
    body: ClusterRequest = Body(...),
) -> dict[str, Any]:
    return await _clusterer.cluster(
        org_id,
        window=body.window,
        min_cluster_size=body.min_cluster_size,
    )


@router.get("/incidents/{cluster_id}/summarize")
async def summarize_cluster(
    org_id: str = Depends(require_path_org_access),
    cluster_id: str = Path(...),
) -> dict[str, Any]:
    return await _clusterer.summarize(org_id, cluster_id)


@router.post("/incidents/{cluster_id}/resolve")
async def resolve_incident(
    org_id: str = Depends(require_path_org_access),
    cluster_id: str = Path(...),
    body: ResolveIncidentRequest = Body(default_factory=ResolveIncidentRequest),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Mark an incident cluster as resolved."""
    result = await _resolve_incident_cluster(
        org_id, cluster_id, note=body.note or "Marked resolved via portal"
    )
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Incident cluster not found",
        )
    return result


@router.get("/incidents")
async def list_incidents(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    severity: str | None = None,
) -> dict[str, Any]:
    return await _store.list(org_id, limit=limit, severity=severity)
