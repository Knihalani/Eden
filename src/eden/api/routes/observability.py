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


# ── Observability summary (Phase 2: deeper fingerprint) ─────────


class ObservabilitySummary(BaseModel):
    """Aggregated observability surface for the AgentProfile's behavioral
    fingerprint. Consumed by the Eden Agent CLI's AgentProfileProvider
    and rendered into every EdenCoder system prompt.

    Phase 2: extends the legacy summary shape with ``top_tools``
    (per-tool call counts) and ``hot_paths`` (per-span-kind counts)
    so the CLI's behavioral fingerprint is more than a failure-mode
    list — it tells the LLM *what the agent actually does most* and
    *where it spends its time*, not just where it fails.
    """

    window_hours: int = 24
    total_traces: int = 0
    error_rate: float = 0.0
    p50_latency_ms: float = 0.0
    p95_latency_ms: float = 0.0
    p99_latency_ms: float = 0.0
    total_cost_usd: float = 0.0
    top_failure_modes: list[dict] = Field(default_factory=list)
    top_tools: list[dict] = Field(default_factory=list)
    hot_paths: list[dict] = Field(default_factory=list)
    model_breakdown: list[dict] = Field(default_factory=list)


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
        raise HTTPException(status_code=500, detail="Telemetry ingestion failed") from exc


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
        raise HTTPException(status_code=500, detail="Batch telemetry ingestion failed") from exc


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


@router.get("/summary", response_model=ObservabilitySummary)
async def observability_summary(
    org_id: str = Path(..., description="Organization ID"),
    window_hours: int = Query(24, ge=1, le=720),
    agent_id: str | None = Query(None, description="Scope to one agent"),
    user: dict = Depends(get_current_user),
) -> ObservabilitySummary:
    """Aggregated observability surface for the AgentProfile's
    behavioral fingerprint.

    Phase 2: the deeper fields (``top_tools``, ``hot_paths``) let
    the Eden Agent CLI's AgentProfileProvider describe the agent's
    actual behavior, not just its failure modes. The CLI consumes
    this via the existing ``GET /v1/orgs/{org}/observability/summary``
    endpoint.

    When the telemetry store is unreachable, returns an empty summary
    so the CLI degrades cleanly. When the store is reachable but
    empty (no events yet), returns a summary with zero counts.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return ObservabilitySummary(window_hours=window_hours)

    # Build the WHERE clause once, reused across aggregation queries.
    where = "tenant_id = $1 AND timestamp >= NOW() - ($2 || ' hours')::interval"
    params: list = [org_id, str(window_hours)]
    if agent_id:
        where += f" AND agent_id = ${len(params) + 1}"
        params.append(agent_id)

    # Total + error count + per-latency percentiles (via Postgres's
    # percentile_cont aggregate). For now we use a coarse
    # approximation: count + error_count + a few percentile buckets
    # drawn from the latency_ms field on telemetry_events.
    total_row = await client.fetchrow(
        f"""
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE error IS NOT NULL)::int AS errors
        FROM telemetry_events
        WHERE {where}
        """,
        *params,
    )
    total = int(total_row["total"] or 0) if total_row else 0
    errors = int(total_row["errors"] or 0) if total_row else 0
    error_rate = (errors / total) if total else 0.0

    # Latency percentiles — Postgres percentile_cont on duration_ms.
    # If the column is missing on some events, NULL is filtered.
    lat_row = await client.fetchrow(
        f"""
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
                   FILTER (WHERE duration_ms IS NOT NULL) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
                   FILTER (WHERE duration_ms IS NOT NULL) AS p95,
               percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)
                   FILTER (WHERE duration_ms IS NOT NULL) AS p99,
               coalesce(sum(cost_usd), 0)::float AS cost
        FROM telemetry_events
        WHERE {where}
        """,
        *params,
    )

    # Top failure modes: group by error.type or event_type (when
    # error is present), count, and pull a sample of trace_ids.
    top_failure_modes = await client.fetch(
        f"""
        SELECT
            coalesce(error->>'type', error->>'category', event_type) AS name,
            count(*)::int AS count,
            array_agg(DISTINCT trace_id) FILTER (WHERE trace_id IS NOT NULL)
                AS sample_trace_ids
        FROM telemetry_events
        WHERE {where} AND error IS NOT NULL
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 10
        """,
        *params,
    )

    # Top tools: group by tool_name (extracted from payload), count.
    # The schema varies per source_format; we read ``payload->>'tool_name'``
    # which is the common case (Anthropic + OpenAI tool calls).
    top_tools = await client.fetch(
        f"""
        SELECT
            coalesce(
                payload->>'tool_name',
                attributes->>'tool.name',
                event_type
            ) AS name,
            count(*)::int AS count
        FROM telemetry_events
        WHERE {where} AND event_type IN ('tool_call', 'tool_result')
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 10
        """,
        *params,
    )

    # Hot paths: per-span-kind / event_type counts. This is the
    # behavioral-fingerprint version of "what does the agent actually
    # do most in a 24h window". Read directly from telemetry_events
    # event_type.
    hot_paths = await client.fetch(
        f"""
        SELECT event_type AS name,
               count(*)::int AS count,
               round(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL)::numeric, 2)::float
                   AS avg_duration_ms
        FROM telemetry_events
        WHERE {where}
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 10
        """,
        *params,
    )

    # Model breakdown: per-model call counts + cost (when cost_usd
    # is recorded). Useful for cost-allocation + per-model sim
    # generation.
    model_breakdown = await client.fetch(
        f"""
        SELECT
            coalesce(attributes->>'model', payload->>'model') AS model,
            count(*)::int AS calls,
            coalesce(sum(cost_usd), 0)::float AS cost_usd
        FROM telemetry_events
        WHERE {where} AND event_type = 'llm_call'
        GROUP BY 1
        ORDER BY cost_usd DESC NULLS LAST
        LIMIT 10
        """,
        *params,
    )

    return ObservabilitySummary(
        window_hours=window_hours,
        total_traces=total,
        error_rate=error_rate,
        p50_latency_ms=float(lat_row["p50"] or 0.0) if lat_row else 0.0,
        p95_latency_ms=float(lat_row["p95"] or 0.0) if lat_row else 0.0,
        p99_latency_ms=float(lat_row["p99"] or 0.0) if lat_row else 0.0,
        total_cost_usd=float(lat_row["cost"] or 0.0) if lat_row else 0.0,
        top_failure_modes=[dict(r) for r in top_failure_modes],
        top_tools=[dict(r) for r in top_tools],
        hot_paths=[dict(r) for r in hot_paths],
        model_breakdown=[dict(r) for r in model_breakdown],
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
        for _span_id, span in tree.span_map.items():
            lines.append(json.dumps(span, default=str))
        data = "\n".join(lines)
    elif fmt == "csv":
        import csv
        import io
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["span_id", "parent_span_id", "name", "event_type", "duration_ms", "outcome"])
        for _span_id, span in tree.span_map.items():
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
