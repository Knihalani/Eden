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
from eden.insights.rca._common import (
    _fetch_trace_events,
    _not_found_envelope,
    _ok_envelope,
    _resolve_incident_cluster,
)
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


def _event_failed(ev: dict[str, Any]) -> bool:
    return bool(ev.get("error")) or ev.get("outcome") == "error"


def _event_error_type(ev: dict[str, Any]) -> str | None:
    err = ev.get("error")
    if isinstance(err, dict):
        t = err.get("type")
        return str(t) if t is not None else None
    return None


def _build_causal_chain(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Turn an ordered trace-event list into a deep-linkable causal chain.

    ``_fetch_trace_events`` already returns events ordered by ``timestamp``
    ascending, so index order *is* execution order. Each node carries the
    ``span_id`` / ``parent_span_id`` a UI needs to deep-link, plus an
    ``implicated`` flag set when the step errored. ``implicated_span_ids`` is
    the ordered, de-duplicated list of failing spans; ``root_cause_span_id``
    is the first failure (earliest-failure-wins).

    Honest limitation: ordering is *temporal*, and implication is "this span
    errored", not a proven data-dependency graph — ``parent_span_id`` is
    surfaced so the UI can render the actual span tree.
    """
    chain: list[dict[str, Any]] = []
    implicated: list[str] = []
    for step, ev in enumerate(events):
        span_id = ev.get("span_id")
        span_id = str(span_id) if span_id is not None else None
        failed = _event_failed(ev)
        chain.append(
            {
                "step": step,
                "span_id": span_id,
                "parent_span_id": (
                    str(ev.get("parent_span_id"))
                    if ev.get("parent_span_id") is not None
                    else None
                ),
                "event_type": ev.get("event_type"),
                "name": ev.get("name"),
                "outcome": ev.get("outcome"),
                "error_type": _event_error_type(ev),
                "implicated": failed,
            }
        )
        if failed and span_id and span_id not in implicated:
            implicated.append(span_id)
    return {
        "causal_chain": chain,
        "implicated_span_ids": implicated,
        "root_cause_span_id": implicated[0] if implicated else None,
        "span_count": len(chain),
    }


@router.get("/{trace_id}/chain")
async def rca_chain(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    """Per-trace RCA chain: implicated span_ids + ordered causal chain.

    Reuses the same ``RootCauseAnalyzer`` engine as ``/analyze`` for the
    failure category/confidence, then overlays the deep-linkable span chain
    derived from the trace's telemetry events so a UI can jump straight to
    the implicated spans.
    """
    events = await _fetch_trace_events(org_id, trace_id)
    if not events:
        return _not_found_envelope(_rca.name, trace_id=trace_id)

    # Reuse the engine for classification (category / confidence / signals).
    categorized = await _rca.categorize(org_id, trace_id)
    cat_data = categorized.get("data") or {}

    chain = _build_causal_chain(events)
    return _ok_envelope(
        _rca.name,
        {
            "trace_id": trace_id,
            "category": cat_data.get("category"),
            "confidence": cat_data.get("confidence"),
            "signals": cat_data.get("signals", []),
            **chain,
        },
    )


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
