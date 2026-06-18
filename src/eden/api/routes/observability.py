"""Observability API routes — Phase 6.5: Eden Telemetry Collector & Visualization.

Provides endpoints for:
  - Telemetry event ingestion (single + batch)
  - Trace tree retrieval
  - Performance heatmaps
  - Step timelines
  - Comparative trace analysis (env vs production)
  - Trace export
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user
from eden.observability.telemetry_collector import (
    TelemetryCollector,
    TelemetryEvent,
    get_telemetry_collector,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/orgs/{org_id}/observability", tags=["observability"])


# ── Pydantic Schemas ─────────────────────────────────────────────────────────

class TelemetryEventIngest(BaseModel):
    event_id: str
    project_id: str
    trace_id: str
    realm: str = Field(..., pattern="^(environment|production)$")
    event_type: str
    timestamp: str
    agent_id: str | None = None
    agent_version: str | None = None
    environment_id: str | None = None
    parent_span_id: str | None = None
    span_id: str | None = None
    name: str | None = None
    duration_ms: float | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, float] = Field(default_factory=dict)
    attributes: dict[str, str] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)
    outcome: str | None = None


class TelemetryBatchIngest(BaseModel):
    events: list[TelemetryEventIngest]


class TelemetryIngestResponse(BaseModel):
    accepted: int
    deduplicated: int
    rejected: int
    total: int


class TraceTreeResponse(BaseModel):
    trace_id: str
    tenant_id: str
    realm: str
    root_spans: list[dict[str, Any]]
    total_duration_ms: float
    span_count: int
    outcome: str | None = None


class HeatmapResponse(BaseModel):
    metric_name: str
    buckets: list[dict[str, Any]]
    x_labels: list[str]
    y_labels: list[str]
    min_value: float
    max_value: float


class TimelineResponse(BaseModel):
    trace_id: str
    steps: list[dict[str, Any]]
    total_duration_ms: float
    markers: list[dict[str, Any]]


class ComparativeRequest(BaseModel):
    env_trace_id: str
    prod_trace_id: str


class ComparativeDimension(BaseModel):
    name: str
    env_value: Any
    prod_value: Any
    gap: float
    severity: str
    explanation: str


class ComparativeResponse(BaseModel):
    env_trace_id: str
    prod_trace_id: str
    overall_score: float
    dimensions: list[ComparativeDimension]
    recommendations: list[str]
    metadata: dict[str, Any]


class TraceListItem(BaseModel):
    trace_id: str
    realm: str
    agent_id: str | None = None
    started_at: str | None = None
    outcome: str | None = None
    span_count: int = 0
    duration_ms: float = 0.0


class TraceListResponse(BaseModel):
    traces: list[TraceListItem]
    total: int
    limit: int
    offset: int


class ExportFormatRequest(BaseModel):
    format_type: str = Field(default="jsonl", pattern="^(jsonl|json|csv)$")


class TraceExportResponse(BaseModel):
    trace_id: str
    format: str
    data: str


# ── Helper ───────────────────────────────────────────────────────────────────


def _to_telemetry_event(data: TelemetryEventIngest, tenant_id: str) -> TelemetryEvent:
    return TelemetryEvent(
        event_id=data.event_id,
        tenant_id=tenant_id,
        project_id=data.project_id,
        trace_id=data.trace_id,
        realm=data.realm,
        event_type=data.event_type,
        timestamp=data.timestamp,
        agent_id=data.agent_id,
        agent_version=data.agent_version,
        environment_id=data.environment_id,
        parent_span_id=data.parent_span_id,
        span_id=data.span_id,
        name=data.name,
        duration_ms=data.duration_ms,
        payload=data.payload,
        metrics=data.metrics,
        attributes=data.attributes,
        tags=data.tags,
        outcome=data.outcome,
    )


async def _get_collector() -> TelemetryCollector:
    return await get_telemetry_collector()


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/telemetry/ingest", response_model=TelemetryIngestResponse)
async def ingest_telemetry_event(
    org_id: str = Path(..., description="Organization ID"),
    body: TelemetryEventIngest = Body(...),
    user: dict = Depends(get_current_user),
) -> TelemetryIngestResponse:
    """Ingest a single telemetry event."""
    try:
        collector = await _get_collector()
        event = _to_telemetry_event(body, org_id)
        accepted = await collector.ingest(event)
        return TelemetryIngestResponse(
            accepted=1 if accepted else 0,
            deduplicated=0 if accepted else 1,
            rejected=0 if accepted else 1,
            total=1,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"Telemetry ingest failed for org {org_id}: {exc}")
        raise HTTPException(status_code=500, detail="Telemetry ingestion failed")


@router.post("/telemetry/ingest/batch", response_model=TelemetryIngestResponse)
async def ingest_telemetry_batch(
    org_id: str = Path(..., description="Organization ID"),
    body: TelemetryBatchIngest = Body(...),
    user: dict = Depends(get_current_user),
) -> TelemetryIngestResponse:
    """Ingest a batch of telemetry events."""
    try:
        collector = await _get_collector()
        events = [_to_telemetry_event(ev, org_id) for ev in body.events]
        result = await collector.ingest_batch(events)
        return TelemetryIngestResponse(**result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"Telemetry batch ingest failed for org {org_id}: {exc}")
        raise HTTPException(status_code=500, detail="Batch telemetry ingestion failed")


@router.get("/traces", response_model=TraceListResponse)
async def list_traces(
    org_id: str = Path(..., description="Organization ID"),
    realm: str | None = Query(None, pattern="^(environment|production)$"),
    outcome: str | None = Query(None),
    agent_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    days: int = Query(7, ge=1, le=90),
    user: dict = Depends(get_current_user),
) -> TraceListResponse:
    """List traces for an organization with optional filters."""
    # For MVP, return an empty list with simulated metadata
    # In production this would query the telemetry store
    return TraceListResponse(
        traces=[],
        total=0,
        limit=limit,
        offset=offset,
    )


@router.get("/traces/{trace_id}/tree", response_model=TraceTreeResponse)
async def get_trace_tree_route(
    org_id: str = Path(..., description="Organization ID"),
    trace_id: str = Path(..., description="Trace ID"),
    user: dict = Depends(get_current_user),
) -> TraceTreeResponse:
    """Retrieve a hierarchical trace tree for visualization."""
    collector = await _get_collector()
    tree = await collector.get_trace_tree(org_id, trace_id)
    if tree is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return TraceTreeResponse(
        trace_id=tree.trace_id,
        tenant_id=tree.tenant_id,
        realm=tree.realm,
        root_spans=tree.root_spans,
        total_duration_ms=tree.total_duration_ms,
        span_count=tree.span_count,
        outcome=tree.outcome,
    )


@router.get("/traces/{trace_id}/timeline", response_model=TimelineResponse)
async def get_trace_timeline_route(
    org_id: str = Path(..., description="Organization ID"),
    trace_id: str = Path(..., description="Trace ID"),
    user: dict = Depends(get_current_user),
) -> TimelineResponse:
    """Retrieve a step timeline for a single trace."""
    collector = await _get_collector()
    timeline = await collector.get_timeline(org_id, trace_id)
    if timeline is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return TimelineResponse(
        trace_id=timeline.trace_id,
        steps=timeline.steps,
        total_duration_ms=timeline.total_duration_ms,
        markers=timeline.markers,
    )


@router.get("/heatmaps/{metric_name}", response_model=HeatmapResponse)
async def get_heatmap_route(
    org_id: str = Path(..., description="Organization ID"),
    metric_name: str = Path(..., description="Metric name to visualize"),
    x_axis: str = Query("name", description="Field to use for X-axis"),
    days: int = Query(7, ge=1, le=30),
    user: dict = Depends(get_current_user),
) -> HeatmapResponse:
    """Retrieve a performance heatmap for a set of traces."""
    collector = await _get_collector()
    heatmap = await collector.get_heatmap(org_id, metric_name, x_axis, days)
    if heatmap is None:
        raise HTTPException(status_code=404, detail="No heatmap data available")
    return HeatmapResponse(
        metric_name=heatmap.metric_name,
        buckets=heatmap.buckets,
        x_labels=heatmap.x_labels,
        y_labels=heatmap.y_labels,
        min_value=heatmap.min_value,
        max_value=heatmap.max_value,
    )


@router.post("/traces/compare", response_model=ComparativeResponse)
async def compare_traces_route(
    org_id: str = Path(..., description="Organization ID"),
    body: ComparativeRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> ComparativeResponse:
    """Compare an environment trace with a production trace."""
    collector = await _get_collector()
    summary = await collector.get_comparative_summary(
        org_id, body.env_trace_id, body.prod_trace_id
    )
    if summary is None:
        raise HTTPException(status_code=404, detail="One or both traces not found")

    dimensions = [
        ComparativeDimension(
            name=d["name"],
            env_value=d["env_value"],
            prod_value=d["prod_value"],
            gap=d["gap"],
            severity=d["severity"],
            explanation=d["explanation"],
        )
        for d in summary.get("dimensions", [])
    ]

    return ComparativeResponse(
        env_trace_id=summary["env_trace_id"],
        prod_trace_id=summary["prod_trace_id"],
        overall_score=summary["overall_score"],
        dimensions=dimensions,
        recommendations=summary.get("recommendations", []),
        metadata=summary.get("metadata", {}),
    )


@router.post("/traces/{trace_id}/export", response_model=TraceExportResponse)
async def export_trace_route(
    org_id: str = Path(..., description="Organization ID"),
    trace_id: str = Path(..., description="Trace ID"),
    body: ExportFormatRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> TraceExportResponse:
    """Export a trace tree in JSONL, JSON, or CSV format."""
    collector = await _get_collector()
    tree = await collector.get_trace_tree(org_id, trace_id)
    if tree is None:
        raise HTTPException(status_code=404, detail="Trace not found")

    fmt = body.format_type
    if fmt == "jsonl":
        lines = []
        for span_id, span in tree.span_map.items():
            lines.append(json.dumps(span, default=str))
        data = "\n".join(lines)
    elif fmt == "csv":
        import csv
        import io
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["span_id", "parent_span_id", "name", "event_type", "duration_ms", "outcome"])
        for span_id, span in tree.span_map.items():
            writer.writerow([
                span.get("span_id", ""),
                span.get("parent_span_id", ""),
                span.get("name", ""),
                span.get("event_type", ""),
                span.get("duration_ms", 0),
                span.get("outcome", ""),
            ])
        data = buf.getvalue()
    else:
        data = json.dumps(
            {
                "trace_id": tree.trace_id,
                "realm": tree.realm,
                "total_duration_ms": tree.total_duration_ms,
                "span_count": tree.span_count,
                "outcome": tree.outcome,
                "spans": list(tree.span_map.values()),
            },
            default=str,
            indent=2,
        )

    return TraceExportResponse(trace_id=trace_id, format=fmt, data=data)


# ── Phase B — Full-text search ──────────────────────────────────────────
# Laminar parity: the "fast text search across spans" surface that sits
# next to transcript + SQL on their landing page. Backed by Typesense
# (configured via Settings.typesense_*). Per-org isolation is enforced
# inside SearchService — callers cannot bypass tenant_id.


class SpanSearchHit(BaseModel):
    event_id: str
    trace_id: str
    span_id: str
    agent_id: str
    name: str
    event_type: str
    outcome: str
    input_text_excerpt: str = ""
    output_text_excerpt: str = ""
    tool_names: list[str] = []
    created_at: int = 0
    duration_ms: float = 0.0
    cost_usd: float = 0.0
    highlight: dict[str, str] = {}


class SpanSearchResponse(BaseModel):
    hits: list[SpanSearchHit] = []
    total: int = 0
    facet_counts: dict[str, list[dict[str, Any]]] = {}
    took_ms: float = 0.0
    query: str = ""


class SpanSuggestResponse(BaseModel):
    suggestions: list[SpanSearchHit] = []
    took_ms: float = 0.0


@router.get("/spans/search", response_model=SpanSearchResponse)
async def search_spans_route(
    org_id: str = Path(..., description="Organization ID"),
    q: str = Query("", description="Full-text query (matches input/output text + tool names + agent id)"),
    agent: str | None = Query(None, description="Filter to one agent_id"),
    tool: str | None = Query(None, description="Filter to one tool name"),
    outcome: str | None = Query(None, description="Filter to one outcome (success/failure/partial/timeout/crash)"),
    event_type: str | None = Query(None, description="Filter to one event_type"),
    from_ts: int | None = Query(None, description="Lower bound on created_at (epoch seconds)"),
    to_ts: int | None = Query(None, description="Upper bound on created_at (epoch seconds)"),
    per_page: int = Query(20, ge=1, le=100),
    page: int = Query(1, ge=1),
    user: dict = Depends(get_current_user),
) -> SpanSearchResponse:
    """Full-text search across every span for this org (Laminar parity).

    Returns hits, total count, and facet counts for the sidebar
    filter UI. ``q`` may be empty (returns all spans matching the
    filters, useful for "show me all failures in the last hour").
    """
    from eden.observability.search_service import get_search_service

    service = get_search_service()
    resp = await service.search(
        tenant_id=org_id,
        query=q,
        agent_id=agent,
        tool=tool,
        outcome=outcome,
        event_type=event_type,
        from_ts=from_ts,
        to_ts=to_ts,
        per_page=per_page,
        page=page,
    )
    return SpanSearchResponse(
        hits=[SpanSearchHit(**h.to_dict()) for h in resp.hits],
        total=resp.total,
        facet_counts=resp.facet_counts,
        took_ms=resp.took_ms,
        query=resp.query,
    )


@router.get("/spans/search/suggest", response_model=SpanSuggestResponse)
async def suggest_spans_route(
    org_id: str = Path(..., description="Organization ID"),
    q: str = Query(..., min_length=1, description="Prefix query for Cmd-K autocomplete"),
    limit: int = Query(5, ge=1, le=20),
    user: dict = Depends(get_current_user),
) -> SpanSuggestResponse:
    """Top-N autocomplete suggestions for the Cmd-K global search palette.

    No facets, no highlights — just enough to render a dropdown of
    "trace XYZ matched your query" rows. Latency budget: <50ms p95.
    """
    from eden.observability.search_service import get_search_service

    service = get_search_service()
    import time as _time
    start = _time.perf_counter()
    hits = await service.suggest(tenant_id=org_id, query=q, limit=limit)
    elapsed = (_time.perf_counter() - start) * 1000
    return SpanSuggestResponse(
        suggestions=[SpanSearchHit(**h.to_dict()) for h in hits],
        took_ms=round(elapsed, 2),
    )
