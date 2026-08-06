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

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, get_ingest_auth, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.observability.errors import IngestionUnavailableError
from eden.observability.telemetry_collector import (  # noqa: F401
    TelemetryCollector,
    TelemetryEvent,
    get_telemetry_collector,
)
from eden.util.jsonx import dumps as json_dumps

logger = logging.getLogger(__name__)


# Audit 2026-07-03 — every observability route MUST validate that the
# caller is a member of the ``org_id`` in the path. Previously the
# router only carried ``Depends(get_current_user)`` which validates a
# JWT but never confirms the caller belongs to the requested org;
# defence-in-depth was leaning entirely on the migration-015 RLS
# policies + per-query ``org_id`` filters. Forgetting a single
# ``WHERE org_id = $1`` on a new endpoint would have cross-leaked
# tenant data silently. The dep at the router level makes "you're not
# a member" a hard 403, so a forgotten filter can't leak.
# 2026-07-19 — also require path org == authenticated org (require_org_member
# alone only checks X-Org-Id / JWT org, not the URL path).
router = APIRouter(
    prefix="/orgs/{org_id}/observability",
    tags=["observability"],
    dependencies=[Depends(require_path_org_access)],
)

# Telemetry ingest is SDK/API-key traffic (mirrors ``ingestion.py``).
# Do NOT gate on ``require_path_org_access`` / ``get_current_user``:
# those Clerk deps map a present-but-invalid ``X-Org-Api-Key`` to
# 403 "Not a member" when a session cookie is also present, and 401
# valid key-only callers before ingest auth runs. Use ``get_ingest_auth``.
ingest_router = APIRouter(
    prefix="/orgs/{org_id}/observability",
    tags=["observability"],
)


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
    # FEAT-60 (2026-08 strategic review): these 5 fields already round-trip
    # through TelemetryEvent/TELEMETRY_INSERT_SQL (FEAT-22/23/24) and are
    # already read back out in the SQL below — but this ingest model never
    # declared them, so Pydantic silently stripped them from any inbound
    # SDK/exporter payload before it ever reached the dataclass.
    operation_name: str | None = None
    provider_name: str | None = None
    error_type: str | None = None
    parent_agent_span_id: str | None = None
    child_agent_trace_id: str | None = None


class TelemetryBatchIngest(BaseModel):
    events: list[TelemetryEventIngest]


class TelemetryIngestResponse(BaseModel):
    accepted: int
    deduplicated: int
    rejected: int
    total: int
    #: Events dropped by the N16 tail-sampling gate. Not stored, not
    #: billed, and not an error — so they belong in neither ``accepted``
    #: nor ``rejected``. Defaulted to 0 so clients built against the old
    #: four-field body keep parsing this one unchanged; sampling is off by
    #: default, so for those clients the value is 0 anyway.
    sampled_out: int = 0


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
    duration_ms: float | None = None
    # Cat 23 audit — fields promised by the portal type but missing here.
    # Portal `clients/portal/src/lib/api.ts:2452-2470` reads these; keeping
    # the model honest avoids `undefined` values after the empty stub is
    # replaced with a real query.
    tenant_id: str | None = None
    model: str | None = None
    provider: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_cents: int | None = None
    error: dict[str, Any] | None = None
    streaming_metrics: dict[str, Any] | None = None
    tags: list[str] = Field(default_factory=list)
    # N12 — explicit session id when SDK/attrs carry one.
    session_id: str | None = None
    agent_session_id: str | None = None


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
        operation_name=data.operation_name,
        provider_name=data.provider_name,
        error_type=data.error_type,
        parent_agent_span_id=data.parent_agent_span_id,
        child_agent_trace_id=data.child_agent_trace_id,
    )


async def _get_collector() -> TelemetryCollector:
    return await get_telemetry_collector()


def _assert_ingest_org(auth_ctx: dict, org_id: str) -> str:
    """Reject path/auth org mismatches; return the authenticated org id."""
    auth_org = auth_ctx.get("org_id")
    if not auth_org or str(auth_org) != str(org_id):
        raise HTTPException(
            status_code=403,
            detail="Path org_id does not match authenticated org",
        )
    return str(auth_org)


# ── Telemetry ingest (API-key / session cookie via get_ingest_auth) ───────────


@ingest_router.post("/telemetry/ingest", response_model=TelemetryIngestResponse)
async def ingest_telemetry_event(
    org_id: str = Path(..., description="Organization ID"),
    body: TelemetryEventIngest = Body(...),
    auth_ctx: dict = Depends(get_ingest_auth),
) -> TelemetryIngestResponse:
    """Ingest a single telemetry event."""
    org_id = _assert_ingest_org(auth_ctx, org_id)
    try:
        collector = await _get_collector()
        event = _to_telemetry_event(body, org_id)
        # ``ingest_one`` rather than ``ingest``: a bool cannot distinguish
        # "sampled out" from "rejected", and it also cannot distinguish
        # "deduplicated" from "rejected" — which is why the old body
        # reported a single failed event as *both* deduplicated=1 and
        # rejected=1.
        result = await collector.ingest_one(event)
        return TelemetryIngestResponse(**result)
    except HTTPException:
        raise
    except IngestionUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc.message) if hasattr(exc, "message") else str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    except (ValueError, TypeError, KeyError) as exc:
        logger.warning("Telemetry ingest client error for org %s: %s", org_id, redact_all(str(exc)))
        raise HTTPException(status_code=400, detail=str(exc) or "Invalid telemetry event") from exc
    except Exception as exc:
        from eden.api.utils.safe_error import safe_detail

        logger.warning("Telemetry ingest failed for org %s: %s", org_id, redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                exc,
                fallback="Telemetry ingestion temporarily unavailable",
            ),
            headers={"Retry-After": "5"},
        ) from exc


@ingest_router.post("/telemetry/ingest/batch", response_model=TelemetryIngestResponse)
async def ingest_telemetry_batch(
    org_id: str = Path(..., description="Organization ID"),
    body: TelemetryBatchIngest = Body(...),
    auth_ctx: dict = Depends(get_ingest_auth),
) -> TelemetryIngestResponse:
    """Ingest a batch of telemetry events."""
    org_id = _assert_ingest_org(auth_ctx, org_id)
    try:
        collector = await _get_collector()
        events = [_to_telemetry_event(ev, org_id) for ev in body.events]
        result = await collector.ingest_batch(events)
        return TelemetryIngestResponse(**result)
    except HTTPException:
        raise
    except IngestionUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc.message) if hasattr(exc, "message") else str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    except (ValueError, TypeError, KeyError) as exc:
        logger.warning(
            "Telemetry batch ingest client error for org %s: %s", org_id, redact_all(str(exc))
        )
        raise HTTPException(status_code=400, detail=str(exc) or "Invalid telemetry batch") from exc
    except Exception as exc:
        from eden.api.utils.safe_error import safe_detail

        logger.warning("Telemetry batch ingest failed for org %s: %s", org_id, redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                exc,
                fallback="Batch telemetry ingestion temporarily unavailable",
            ),
            headers={"Retry-After": "5"},
        ) from exc


@router.get("/traces", response_model=TraceListResponse)
async def list_traces(
    org_id: str = Depends(require_path_org_access),
    realm: str | None = Query(None, pattern="^(environment|production)$"),
    outcome: str | None = Query(None),
    agent_id: str | None = Query(None),
    trace_id: str | None = Query(
        None,
        description=(
            "Exact-match a single trace by id — powers deep links "
            "(e.g. /observability?trace_id=...) without the client "
            "having to scan the unfiltered page for a match."
        ),
    ),
    trace_ids: list[str] | None = Query(
        None,
        description=(
            "Batch exact-match by trace id (cap 100). Independent of "
            "the days window, same as single ``trace_id``."
        ),
    ),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    days: int = Query(7, ge=1, le=90),
    user: dict = Depends(get_current_user),
) -> TraceListResponse:
    """List traces for an organization with optional filters.

    Groups ``telemetry_events`` by ``trace_id`` to produce one row
    per trace. Per-trace aggregates:
        - span_count, duration_ms (max event duration, not sum),
          started_at (min timestamp), outcome, error, model, provider,
          token totals, cost (sum cost_usd → cents).
    Filters: realm, outcome, agent_id, trace_id, trace_ids, days.

    Postgres unavailable / query failure → **503** (not a fake empty
    list). Soft-empty hid outages from the portal and broke Wave-1
    correctness for traces hub.
    """
    from datetime import UTC, datetime, timedelta

    try:
        from eden.storage import postgres as _pg_module

        client = await _pg_module.get_postgres_client()
    except Exception as exc:
        logger.warning("list_traces: postgres unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Traces temporarily unavailable",
            headers={"Retry-After": "5"},
        ) from exc
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Traces temporarily unavailable",
            headers={"Retry-After": "5"},
        )

    batch_ids = [t for t in (trace_ids or []) if t][:100]
    if batch_ids:
        # Batch id lookup — independent of the days window (like
        # single ``trace_id``) so deep-linked older traces resolve.
        where = "tenant_id = $1 AND trace_id = ANY($2::text[])"
        args: list[Any] = [org_id, batch_ids]
    elif trace_id:
        # Exact trace lookup — deliberately independent of the
        # `days` window (and the realm/agent_id filters below) so a
        # deep link to an older trace still resolves. Unlike the
        # list view, a single-trace fetch has no reason to silently
        # 404 just because it's outside the default 7-day window.
        where = "tenant_id = $1 AND trace_id = $2"
        args = [org_id, trace_id]
    else:
        since = datetime.now(UTC) - timedelta(days=days)
        where = "tenant_id = $1 AND timestamp >= $2"
        args = [org_id, since]
        if realm:
            where += f" AND realm = ${len(args) + 1}"
            args.append(realm)
        if agent_id:
            where += (
                f" AND (agent_id = ${len(args) + 1}"
                f" OR attributes->>'agent_id' = ${len(args) + 1})"
            )
            args.append(agent_id)
    # outcome filters on the rollup; we drop traces that have no
    # matching outcome event so the count is stable.
    if outcome:
        where += (
            f" AND trace_id IN (SELECT trace_id FROM telemetry_events "
            f"WHERE tenant_id = $1 AND outcome = ${len(args) + 1})"
        )
        args.append(outcome)

    try:
        # Total = distinct traces matching ``where`` (not event rows).
        # ``pg_class.reltuples`` was abandoned — table-level estimate
        # leaks cross-tenant counts. GROUP BY subquery stays filterable
        # by tenant_id + timestamp indexes.
        # Rows query: aggregate spans first (no LATERAL unnest) so
        # count/sum/tokens stay correct, then attach tags only for the
        # page of traces (avoids multiplying every event by tag count).
        lim_idx = len(args) + 1
        off_idx = len(args) + 2
        # Schema note: prod ``telemetry_events`` (mig 009+) has JSONB
        # ``tags``, ``error_type`` (not ``error``), and cost in
        # metrics/payload JSON — not top-level ``cost_usd`` / TEXT[].
        # insights_tools.list_traces already follows that shape; keep
        # this route aligned so list never 503s on UndefinedColumn.
        rows = await client.fetch(
            f"""
            WITH page AS (
                SELECT trace_id,
                       min(timestamp) AS started_at,
                       max(realm) AS realm,
                       coalesce(
                           max(agent_id),
                           max(attributes->>'agent_id')
                       ) AS agent_id,
                       coalesce(
                           max(model),
                           max(model_name),
                           max(attributes->>'model'),
                           max(attributes->>'openai.model'),
                           max(attributes->>'anthropic.model'),
                           max(attributes->>'bedrock.model_id'),
                           max(attributes->>'gen_ai.request.model')
                       ) AS model,
                       coalesce(
                           max(provider_name),
                           max(attributes->>'provider')
                       ) AS provider,
                       coalesce(
                           max(session_id),
                           max(attributes->>'session_id')
                       ) AS session_id,
                       max(attributes->>'agent_session_id') AS attr_agent_session_id,
                       max(outcome) AS outcome,
                       max(error_type) AS error_type,
                       max(attributes->>'error') AS attr_error,
                       sum(
                           coalesce(
                               (NULLIF(payload->>'input_tokens', ''))::numeric,
                               usage_prompt_tokens,
                               0
                           )
                       ) AS input_tokens,
                       sum(
                           coalesce(
                               (NULLIF(payload->>'output_tokens', ''))::numeric,
                               usage_completion_tokens,
                               0
                           )
                       ) AS output_tokens,
                       sum(
                           coalesce(
                               NULLIF(metrics->>'cost_usd', '')::float,
                               NULLIF(payload->>'cost_usd', '')::float,
                               NULLIF(attributes->>'cost_usd', '')::float
                           )
                       ) AS cost_usd,
                       count(*) AS span_count,
                       max(duration_ms) AS duration_ms
                FROM telemetry_events
                WHERE {where}
                GROUP BY trace_id
                ORDER BY started_at DESC
                LIMIT ${lim_idx} OFFSET ${off_idx}
            )
            SELECT p.trace_id,
                   p.started_at,
                   p.realm,
                   p.agent_id,
                   p.model,
                   p.provider,
                   p.session_id,
                   p.outcome,
                   p.error_type,
                   p.attr_error,
                   p.input_tokens,
                   p.output_tokens,
                   p.cost_usd,
                   p.span_count,
                   p.duration_ms,
                   (
                       SELECT array_agg(DISTINCT tag)
                       FROM telemetry_events e2
                       CROSS JOIN LATERAL jsonb_array_elements_text(
                           CASE
                               WHEN jsonb_typeof(e2.tags) = 'array' THEN e2.tags
                               ELSE '[]'::jsonb
                           END
                       ) AS tag
                       WHERE e2.tenant_id = $1
                         AND e2.trace_id = p.trace_id
                         AND tag IS NOT NULL
                   ) AS tags,
                   coalesce(
                       p.attr_agent_session_id,
                       (
                           SELECT split_part(tag, ':', 2)
                           FROM telemetry_events e3
                           CROSS JOIN LATERAL jsonb_array_elements_text(
                               CASE
                                   WHEN jsonb_typeof(e3.tags) = 'array' THEN e3.tags
                                   ELSE '[]'::jsonb
                               END
                           ) AS tag
                           WHERE e3.tenant_id = $1
                             AND e3.trace_id = p.trace_id
                             AND tag LIKE 'agent_session_id:%'
                           LIMIT 1
                       )
                   ) AS agent_session_id
            FROM page p
            ORDER BY p.started_at DESC
            """,
            *args,
            limit,
            offset,
        )
        # Skip the expensive distinct-trace COUNT when this page is
        # clearly the last (or only) page — common for small tenants
        # and deep-link single-trace lookups.
        if len(rows) < limit:
            total = offset + len(rows)
        else:
            total = await client.fetchval(
                f"""
                SELECT count(*) FROM (
                    SELECT trace_id FROM telemetry_events
                    WHERE {where}
                    GROUP BY trace_id
                ) AS _traces
                """,
                *args,
            )
    except Exception as exc:
        logger.warning("list_traces: query failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Traces temporarily unavailable",
            headers={"Retry-After": "5"},
        ) from exc

    items = [
        TraceListItem(
            trace_id=r["trace_id"],
            tenant_id=org_id,
            realm=r["realm"] or "production",
            agent_id=r["agent_id"],
            started_at=r["started_at"].isoformat() if r["started_at"] else None,
            outcome=r["outcome"],
            span_count=int(r["span_count"] or 0),
            duration_ms=(float(r["duration_ms"]) if r["duration_ms"] is not None else None),
            model=r["model"],
            provider=r["provider"],
            input_tokens=int(r["input_tokens"] or 0) if r["input_tokens"] else None,
            output_tokens=int(r["output_tokens"] or 0) if r["output_tokens"] else None,
            cost_cents=(
                int(round(float(r["cost_usd"]) * 100)) if r["cost_usd"] is not None else None
            ),
            error=(
                {"type": r["error_type"]}
                if r.get("error_type")
                else ({"message": r["attr_error"]} if r.get("attr_error") else None)
            ),
            streaming_metrics=None,
            tags=list(r["tags"] or []),
            session_id=r["session_id"] if r.get("session_id") else None,
            agent_session_id=r["agent_session_id"] if r.get("agent_session_id") else None,
        )
        for r in rows
    ]
    return TraceListResponse(traces=items, total=int(total or 0), limit=limit, offset=offset)


@router.get("/traces/{trace_id}/tree", response_model=TraceTreeResponse)
async def get_trace_tree_route(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(..., description="Trace ID"),
    hydrate_bodies: bool = Query(
        False,
        description=(
            "When true, reconstruct full request/response bodies via "
            "message_store (expensive). Default false returns span "
            "structure with inline JSONB previews only."
        ),
    ),
    user: dict = Depends(get_current_user),
) -> TraceTreeResponse:
    """Retrieve a hierarchical trace tree for visualization."""
    collector = await _get_collector()
    tree = await collector.get_trace_tree(
        org_id, trace_id, hydrate_bodies=hydrate_bodies,
    )
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
    org_id: str = Depends(require_path_org_access),
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
    org_id: str = Depends(require_path_org_access),
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
    org_id: str = Depends(require_path_org_access),
    body: ComparativeRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> ComparativeResponse:
    """Compare an environment trace with a production trace."""
    collector = await _get_collector()
    summary = await collector.get_comparative_summary(org_id, body.env_trace_id, body.prod_trace_id)
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
    org_id: str = Depends(require_path_org_access),
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
        # Compact orjson — same fields as stdlib dumps(default=str).
        lines = [json_dumps(span) for _span_id, span in tree.span_map.items()]
        data = "\n".join(lines)
    elif fmt == "csv":
        import csv
        import io

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(
            ["span_id", "parent_span_id", "name", "event_type", "duration_ms", "outcome"]
        )
        for _span_id, span in tree.span_map.items():
            writer.writerow(
                [
                    span.get("span_id", ""),
                    span.get("parent_span_id", ""),
                    span.get("name", ""),
                    span.get("event_type", ""),
                    span.get("duration_ms", 0),
                    span.get("outcome", ""),
                ]
            )
        data = buf.getvalue()
    else:
        # Pretty JSON for human download — keep indent=2 for format contract.
        import json as _json

        data = _json.dumps(
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
    fallback: bool = False


class SpanSuggestResponse(BaseModel):
    suggestions: list[SpanSearchHit] = []
    took_ms: float = 0.0


@router.get("/spans/search", response_model=SpanSearchResponse)
async def search_spans_route(
    org_id: str = Depends(require_path_org_access),
    q: str = Query(
        "", description="Full-text query (matches input/output text + tool names + agent id)"
    ),
    agent: str | None = Query(None, description="Filter to one agent_id"),
    tool: str | None = Query(None, description="Filter to one tool name"),
    outcome: str | None = Query(
        None, description="Filter to one outcome (success/failure/partial/timeout/crash)"
    ),
    event_type: str | None = Query(None, description="Filter to one event_type"),
    from_ts: int | None = Query(None, description="Lower bound on created_at (epoch seconds)"),
    to_ts: int | None = Query(None, description="Upper bound on created_at (epoch seconds)"),
    per_page: int = Query(20, ge=1, le=100),
    page: int = Query(1, ge=1),
    include_facets: bool = Query(
        False,
        description=(
            "Also compute facet counts for the sidebar filter panel "
            "(agent_id/tool_names/outcome/event_type/model). Costs extra "
            "compute per Typesense request, so it's opt-in — pass this "
            "only when the filter panel is actually open, not on every "
            "keystroke/page-load search (OPT-4)."
        ),
    ),
    user: dict = Depends(get_current_user),
) -> SpanSearchResponse:
    """Full-text search across every span for this org (Laminar parity).

    Returns hits and total count. Facet counts for the sidebar
    filter UI are only computed when ``include_facets=true`` is
    passed (see :meth:`SearchService.facets`, which caches results
    for a short TTL). ``q`` may be empty (returns all spans matching
    the filters, useful for "show me all failures in the last hour").
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
    facet_counts = resp.facet_counts
    if include_facets:
        facet_counts = await service.facets(
            tenant_id=org_id,
            query=q,
            agent_id=agent,
            tool=tool,
            outcome=outcome,
            event_type=event_type,
            from_ts=from_ts,
            to_ts=to_ts,
        )
    return SpanSearchResponse(
        hits=[SpanSearchHit(**h.to_dict()) for h in resp.hits],
        total=resp.total,
        facet_counts=facet_counts,
        took_ms=resp.took_ms,
        query=resp.query,
        fallback=resp.fallback,
    )


@router.get("/spans/search/suggest", response_model=SpanSuggestResponse)
async def suggest_spans_route(
    org_id: str = Depends(require_path_org_access),
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


# ───────────────────────────────────────────────────────────────────
# GET /orgs/{org_id}/observability/summary
# ───────────────────────────────────────────────────────────────────
# Deeper-fingerprint rollup over a sliding window. Returns the
# tenant's call/error mix, latency percentiles, top failure modes,
# top tools, hot paths, and per-model cost breakdown — the same
# fields the portal's "Observability" summary card renders.


@router.get("/summary", response_model=dict)
async def observability_summary(
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user),  # Audit 2026-06-22 B1.6 — require login
    window_hours: int = Query(24, ge=1, le=720),
    agent_id: str | None = Query(None),
    compare_previous: bool = Query(
        False,
        description=(
            "Also compute total_traces/error_rate/p95_ms/total_cost_usd "
            "for the immediately preceding, non-overlapping window of "
            "the same length (returned under `previous`). Powers "
            "dashboard delta badges without the client subtracting two "
            "overlapping windows (which is wrong for non-additive "
            "metrics like p95/error_rate)."
        ),
    ),
):
    """Top-of-dashboard summary for an org.

    Issues one query per shape, all of them concurrently (see the
    ``asyncio.gather`` below): seven in the base case, nine with
    ``compare_previous``, across two sequential round trips rather
    than seven-to-nine. This wording used to read as a sequential loop (totals, percentiles, failure modes,
    tools, hot paths, models) and assembles the response. Each
    subquery is a single GROUP BY / aggregate over ``telemetry_events``
    scoped to the org + window.
    """
    from datetime import UTC, datetime, timedelta

    from eden.storage import postgres as _pg_module

    client = await _pg_module.get_postgres_client()
    since = datetime.now(UTC) - timedelta(hours=window_hours)
    common_where = "tenant_id = $1 AND timestamp >= $2"
    common_args = [org_id, since]
    if agent_id:
        common_args.append(agent_id)
        common_where += f" AND attributes->>'agent_id' = ${len(common_args)}"

    # The all-zeros `empty` payload that used to live here is gone: it
    # existed only to be returned when the database was unreachable,
    # which is the fabrication this endpoint no longer commits.
    if client is None:
        # This returned `empty` at HTTP 200 — total_traces 0, error_rate
        # 0.0 — so the observability product's own summary reported a
        # clean, healthy, zero-error dashboard when what it actually
        # meant was "we could not reach the database".
        #
        # list_traces in this same module already raises 503 for exactly
        # this condition, so the two disagreed about what an unreachable
        # Postgres means. "Zero errors" and "we don't know" must never
        # render identically on a monitoring dashboard — that is the one
        # product where a confident wrong answer does the most damage.
        raise HTTPException(
            status_code=503,
            detail="Metrics are temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )

    # 1-7 fire in parallel via asyncio.gather — six 50ms queries
    # collapse into a single round-trip latency instead of 6×.
    # return_exceptions so a missing judge_scores table (etc.) cannot
    # 500 the whole dashboard summary.
    gathered = await asyncio.gather(
        client.fetchrow(
            f"SELECT count(*) AS total_events, "
            f"count(DISTINCT trace_id) AS total_traces, "
            f"sum(CASE WHEN error_type IS NOT NULL "
            f"OR (attributes ? 'error') THEN 1 ELSE 0 END) AS errors "
            f"FROM telemetry_events WHERE {common_where}",
            *common_args,
        ),
        client.fetchrow(
            f"SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50, "
            f"percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95, "
            f"percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99, "
            f"coalesce(sum(coalesce("
            f"  NULLIF(metrics->>'cost_usd','')::float,"
            f"  NULLIF(payload->>'cost_usd','')::float,"
            f"  NULLIF(attributes->>'cost_usd','')::float,"
            f"  0)), 0) AS cost "
            f"FROM telemetry_events WHERE {common_where}",
            *common_args,
        ),
        client.fetch(
            f"SELECT coalesce(error_type, attributes->>'error', event_type) AS name, "
            f"count(*) AS count, "
            f"array_agg(distinct trace_id) FILTER (WHERE trace_id IS NOT NULL) AS sample_trace_ids "
            f"FROM telemetry_events WHERE {common_where} "
            f"  AND (error_type IS NOT NULL OR (attributes ? 'error')) "
            f"GROUP BY 1 ORDER BY count DESC LIMIT 10",
            *common_args,
        ),
        client.fetch(
            f"SELECT coalesce(payload->>'tool_name', attributes->>'tool_name', name, event_type) AS name, "
            f"count(*) AS count "
            f"FROM telemetry_events WHERE {common_where} "
            f"  AND event_type IN ('tool_call', 'tool_result') "
            f"GROUP BY 1 ORDER BY count DESC LIMIT 10",
            *common_args,
        ),
        client.fetch(
            f"SELECT event_type AS name, count(*) AS count, "
            f"avg(duration_ms) AS avg_duration_ms "
            f"FROM telemetry_events WHERE {common_where} "
            f"GROUP BY 1 ORDER BY count DESC LIMIT 10",
            *common_args,
        ),
        client.fetch(
            f"SELECT coalesce(model, model_name, attributes->>'model', attributes->>'openai.model', attributes->>'anthropic.model') AS model, "
            f"count(*) AS calls, "
            f"coalesce(sum(coalesce("
            f"  NULLIF(metrics->>'cost_usd','')::float,"
            f"  NULLIF(payload->>'cost_usd','')::float,"
            f"  NULLIF(attributes->>'cost_usd','')::float,"
            f"  0)), 0) AS cost_usd "
            f"FROM telemetry_events WHERE {common_where} "
            f"  AND event_type = 'llm_call' "
            f"GROUP BY 1",
            *common_args,
        ),
        client.fetchrow(
            f"""
                WITH traces AS (
                    SELECT DISTINCT trace_id
                      FROM telemetry_events
                     WHERE {common_where}
                ),
                judged AS (
                    SELECT DISTINCT js.trace_id
                      FROM judge_scores js
                      JOIN traces t ON t.trace_id = js.trace_id
                     WHERE js.tenant_id = $1
                       AND js.scored_at >= $2
                )
                SELECT
                  (SELECT count(*) FROM traces) AS total_traces,
                  (SELECT count(*) FROM judged) AS judged_traces
                """,
            *common_args,
        ),
        return_exceptions=True,
    )

    def _ok_row(value: Any) -> Any:
        return None if isinstance(value, BaseException) else value

    def _ok_rows(value: Any) -> list[Any]:
        return [] if isinstance(value, BaseException) else list(value or [])

    totals = _ok_row(gathered[0])
    pct = _ok_row(gathered[1])
    failure_modes = _ok_rows(gathered[2])
    top_tools = _ok_rows(gathered[3])
    hot_paths = _ok_rows(gathered[4])
    model_breakdown = _ok_rows(gathered[5])
    eval_coverage_row = _ok_row(gathered[6])
    degraded_panels: list[int] = []
    for idx, part in enumerate(gathered):
        if isinstance(part, BaseException):
            degraded_panels.append(idx)
            logger.warning(
                "observability_summary subquery[%s] failed org=%s: %s",
                idx,
                org_id,
                part,
            )

    # gathered[0] carries total_events / total_traces / errors — every
    # headline number on the dashboard. When it raises, the arithmetic
    # below silently yields total_traces 0 and error_rate 0.0, i.e. a
    # confident "zero errors" that actually means "the query failed".
    #
    # The other six degrade a single panel and are reported via
    # `degraded_panels` rather than faked; only the headline is fatal.
    if isinstance(gathered[0], BaseException):
        logger.error(
            "observability_summary: headline totals query failed for "
            "org=%s; refusing to report a zero-error dashboard: %s",
            org_id,
            gathered[0],
        )
        raise HTTPException(
            status_code=503,
            detail="Metrics are temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )
    total_events = int((totals or {}).get("total_events") or 0)
    total_traces = int((totals or {}).get("total_traces") or 0)
    errors = int((totals or {}).get("errors") or 0)
    error_rate = (errors / total_events) if total_events else 0.0
    eval_total = int((eval_coverage_row or {}).get("total_traces") or 0)
    eval_judged = int((eval_coverage_row or {}).get("judged_traces") or 0)
    eval_coverage_pct = (eval_judged / eval_total) if eval_total else 0.0

    result: dict[str, Any] = {
        "window_hours": window_hours,
        "agent_id": agent_id,
        "total_events": total_events,
        "total_traces": total_traces,
        "error_rate": error_rate,
        "p50_ms": float(pct["p50"]) if pct and pct["p50"] is not None else None,
        "p95_ms": float(pct["p95"]) if pct and pct["p95"] is not None else None,
        "p99_ms": float(pct["p99"]) if pct and pct["p99"] is not None else None,
        "total_cost_usd": float(pct["cost"]) if pct and pct["cost"] is not None else 0.0,
        "eval_coverage_pct": eval_coverage_pct,
        "top_failure_modes": [dict(r) for r in failure_modes],
        "top_tools": [dict(r) for r in top_tools],
        "hot_paths": [dict(r) for r in hot_paths],
        "model_breakdown": [dict(r) for r in model_breakdown],
    }

    if compare_previous:
        # Same-length, non-overlapping window immediately preceding
        # `since` — i.e. hours [2×window_hours ago, window_hours ago).
        # Deliberately re-queried rather than derived from `totals`/
        # `pct` above: subtracting a wider overlapping window from
        # the current one is only valid for additive counts (traces,
        # cost) and silently wrong for percentiles/rates (p95,
        # error_rate aren't additive), which is the bug this
        # parameter replaces.
        prev_until = since
        prev_since = since - timedelta(hours=window_hours)
        prev_where = "tenant_id = $1 AND timestamp >= $2 AND timestamp < $3"
        prev_args: list[Any] = [org_id, prev_since, prev_until]
        if agent_id:
            prev_args.append(agent_id)
            prev_where += f" AND attributes->>'agent_id' = ${len(prev_args)}"

        try:
            prev_gathered = await asyncio.gather(
                client.fetchrow(
                    f"SELECT count(*) AS total_events, "
                    f"count(DISTINCT trace_id) AS total_traces, "
                    f"sum(CASE WHEN error_type IS NOT NULL "
                    f"OR (attributes ? 'error') THEN 1 ELSE 0 END) AS errors "
                    f"FROM telemetry_events WHERE {prev_where}",
                    *prev_args,
                ),
                client.fetchrow(
                    f"SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95, "
                    f"coalesce(sum(coalesce("
                    f"  NULLIF(metrics->>'cost_usd','')::float,"
                    f"  NULLIF(payload->>'cost_usd','')::float,"
                    f"  NULLIF(attributes->>'cost_usd','')::float,"
                    f"  0)), 0) AS cost "
                    f"FROM telemetry_events WHERE {prev_where}",
                    *prev_args,
                ),
                return_exceptions=True,
            )
            prev_totals = _ok_row(prev_gathered[0])
            prev_pct = _ok_row(prev_gathered[1])
            for idx, part in enumerate(prev_gathered):
                if isinstance(part, BaseException):
                    logger.warning(
                        "observability_summary previous[%s] failed org=%s: %s",
                        idx,
                        org_id,
                        part,
                    )
            prev_total_events = int(prev_totals["total_events"] or 0) if prev_totals else 0
            prev_total_traces = int(prev_totals["total_traces"] or 0) if prev_totals else 0
            prev_errors = int(prev_totals["errors"] or 0) if prev_totals else 0
            result["previous"] = {
                "total_traces": prev_total_traces,
                "error_rate": (prev_errors / prev_total_events) if prev_total_events else 0.0,
                "p95_ms": float(prev_pct["p95"])
                if prev_pct and prev_pct["p95"] is not None
                else None,
                "total_cost_usd": float(prev_pct["cost"])
                if prev_pct and prev_pct["cost"] is not None
                else 0.0,
            }
        except Exception as exc:
            logger.warning(
                "observability_summary compare_previous failed org=%s: %s",
                org_id,
                redact_all(str(exc)),
            )
            # None, not zeros. A zeroed previous window is not a neutral
            # default — the UI divides by it to render delta badges, so
            # a failed comparison query became a confident "+100%
            # growth" on a dashboard. Null means "unknown" and the
            # caller can render a dash.
            result["previous"] = None
            result["previous_unavailable"] = True

    # Panels whose source query raised. Present so the UI can mark them
    # as unknown instead of drawing an empty chart that reads as zero.
    if degraded_panels:
        result["degraded_panels"] = degraded_panels

    return result
