"""Intelligence Gap — RCA & Incidents (Cat 2) routes.

The services under :mod:`eden.insights.rca` and
:mod:`eden.insights.incidents` are real (non-stub)
implementations as of 2026-06-11 — see
``docs/observability-gap/02-root-cause-incidents.md``.

Surface (5 routes):

* ``POST /{trace_id}/analyze`` — categorise a failed trace
* ``GET  /{trace_id}/explain`` — 1-sentence cause + similar
  incidents
* ``POST /incidents/cluster`` — group failed traces in a time
  window into named clusters
* ``GET  /incidents/{cluster_id}/summarize`` — one-paragraph
  cluster summary (the missing route from the appendix
  contract)
* ``GET  /incidents`` — paginated list of clusters
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag, require_org_admin
from eden.insights.incidents.clusterer import IncidentClusterer, IncidentStore
from eden.insights.rca._common import _fetch_cluster_row, _update_cluster_summary
from eden.insights.rca.analyzer import RootCauseAnalyzer

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/rca",
    tags=["intelligence-rca"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

# Stateless singletons — the services are re-runnable (the
# Cat 2 tables have no unique constraint, so we use
# delete-then-insert in the persistence helpers).
_rca = RootCauseAnalyzer()
_clusterer = IncidentClusterer()
_store = IncidentStore()


class ClusterRequest(BaseModel):
    window: str = "24h"
    min_cluster_size: int = 3


class ResolveIncidentRequest(BaseModel):
    note: str | None = None


@router.post("/{trace_id}/analyze")
async def analyze(
    org_id: str = Path(...),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _rca.categorize(org_id, trace_id)


@router.get("/{trace_id}/explain")
async def explain(
    org_id: str = Path(...),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _rca.explain(org_id, trace_id)


@router.post("/incidents/cluster")
async def cluster(
    org_id: str = Path(...),
    body: ClusterRequest = Body(...),
) -> dict[str, Any]:
    return await _clusterer.cluster(
        org_id,
        window=body.window,
        min_cluster_size=body.min_cluster_size,
    )


@router.get("/incidents/{cluster_id}/summarize")
async def summarize_cluster(
    org_id: str = Path(...),
    cluster_id: str = Path(...),
) -> dict[str, Any]:
    return await _clusterer.summarize(org_id, cluster_id)


@router.get("/incidents")
async def list_incidents(
    org_id: str = Path(...),
    limit: int = Query(50, ge=1, le=200),
    severity: str | None = None,
) -> dict[str, Any]:
    return await _store.list(org_id, limit=limit, severity=severity)


@router.post("/incidents/{cluster_id}/resolve")
async def resolve_incident(
    org_id: str = Path(...),
    cluster_id: str = Path(...),
    body: ResolveIncidentRequest = Body(default_factory=ResolveIncidentRequest),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Mark an incident cluster resolved (portal + autonomous parity)."""
    row = await _fetch_cluster_row(org_id, cluster_id)
    if row is None:
        raise HTTPException(status_code=404, detail="cluster_not_found")

    note = (body.note or "").strip() or "Marked resolved via portal"
    prior = (row.get("summary") or "").strip()
    marker = f"[Resolved] {note}"
    if marker in prior:
        new_summary = prior
    else:
        new_summary = f"{prior}\n\n{marker}".strip() if prior else marker

    await _update_cluster_summary(org_id, cluster_id, new_summary)

    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is not None:
            await client.execute(
                """
                UPDATE incidents
                SET status = 'resolved',
                    resolved_at = NOW(),
                    resolution_note = $3
                WHERE org_id = $1 AND cluster_id = $2
                """,
                org_id,
                cluster_id,
                note,
            )
    except Exception as exc:
        logger.debug("resolve_incident: incidents table update skipped: %s", exc)

    return {
        "cluster_id": cluster_id,
        "status": "resolved",
        "summary": new_summary,
    }
