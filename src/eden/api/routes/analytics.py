"""Organization analytics routes for Eden API."""

import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query

from eden.api.deps import get_current_user, require_org_permission
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/analytics", tags=["analytics"])


@router.get("", response_model=dict)
async def get_org_analytics(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
):
    """Get analytics for an organization.

    Returns usage statistics including job counts over time, reference upload
    trends, member activity, and storage usage.
    """
    # Require audit:view permission (owner/admin)
    await require_org_permission("audit:view", org_id)

    client = await get_postgres_client()
    now = datetime.utcnow()
    start_date = now - timedelta(days=days)

    # Job counts by day
    job_counts_query = """
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM jobs
        WHERE org_id = $1 AND created_at >= $2
        GROUP BY DATE(created_at)
        ORDER BY day ASC
    """
    job_counts_rows = await client.fetch(job_counts_query, org_id, start_date)
    job_counts_by_day = [
        {"date": row["day"].isoformat(), "count": row["count"]}
        for row in job_counts_rows
    ]

    # Reference uploads by day
    ref_uploads_query = """
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM code_references
        WHERE org_id = $1 AND created_at >= $2
        GROUP BY DATE(created_at)
        ORDER BY day ASC
    """
    ref_uploads_rows = await client.fetch(ref_uploads_query, org_id, start_date)
    reference_uploads_by_day = [
        {"date": row["day"].isoformat(), "count": row["count"]}
        for row in ref_uploads_rows
    ]

    # Active members count (members with activity in the period)
    active_members_query = """
        SELECT COUNT(DISTINCT user_id) as count
        FROM org_members
        WHERE org_id = $1 AND last_active_at >= $2
    """
    active_members_count = await client.fetchval(active_members_query, org_id, start_date) or 0

    # Total references count
    total_references_query = """
        SELECT COUNT(*) as count
        FROM code_references
        WHERE org_id = $1
    """
    total_references = await client.fetchval(total_references_query, org_id) or 0

    # Storage bytes used (estimated from content length)
    storage_query = """
        SELECT COALESCE(SUM(LENGTH(content)), 0) as bytes
        FROM code_references
        WHERE org_id = $1
    """
    storage_bytes_used = await client.fetchval(storage_query, org_id) or 0

    # Member activity (last_active_at for all members)
    member_activity_query = """
        SELECT om.user_id, om.role, om.joined_at, om.last_active_at,
               u.email, u.name
        FROM org_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1
        ORDER BY om.last_active_at DESC NULLS LAST
    """
    member_activity_rows = await client.fetch(member_activity_query, org_id)
    member_activity = [
        {
            "user_id": str(row["user_id"]),
            "email": row["email"],
            "name": row["name"],
            "role": row["role"],
            "joined_at": row["joined_at"].isoformat() if row.get("joined_at") else None,
            "last_active_at": row["last_active_at"].isoformat() if row.get("last_active_at") else None,
        }
        for row in member_activity_rows
    ]

    return {
        "job_counts_by_day": job_counts_by_day,
        "reference_uploads_by_day": reference_uploads_by_day,
        "active_members_count": active_members_count,
        "total_references": total_references,
        "storage_bytes_used": storage_bytes_used,
        "member_activity": member_activity,
    }


@router.get("/token-usage", response_model=dict)
async def get_token_usage(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
):
    """Per-day token usage (input + output) from ``usage_events``.

    Reads rows where ``event_type = 'llm_call'`` and groups by day. The
    response shape matches what the portal's ``getTokenUsage`` API client
    method expects: ``{by_day: [{date, input_tokens, output_tokens}]}``.
    """
    await require_org_permission("audit:view", org_id)

    client = await get_postgres_client()
    now = datetime.utcnow()
    start_date = now - timedelta(days=days)

    # quantity is a NUMERIC column storing the token count; for llm_call
    # events the resource is "tokens". We split input vs output via the
    # metadata JSONB column (callers write prompt/completion counts there).
    query = """
        SELECT DATE(created_at) AS day,
               COALESCE(SUM((metadata->>'input_tokens')::numeric), 0) AS input_tokens,
               COALESCE(SUM((metadata->>'output_tokens')::numeric), 0) AS output_tokens
        FROM usage_events
        WHERE org_id = $1
          AND event_type = 'llm_call'
          AND created_at >= $2
        GROUP BY DATE(created_at)
        ORDER BY day ASC
    """
    rows = await client.fetch(query, org_id, start_date)
    by_day = [
        {
            "date": row["day"].isoformat(),
            "input_tokens": int(row["input_tokens"] or 0),
            "output_tokens": int(row["output_tokens"] or 0),
        }
        for row in rows
    ]
    return {"by_day": by_day}


@router.get("/latency", response_model=dict)
async def get_latency_percentiles(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
):
    """Per-day latency percentiles (p50 / p95 / p99) from ``telemetry_events``.

    Reads spans with a non-null ``duration_ms`` and aggregates via
    ``percentile_cont`` (continuous percentile via ordered-set aggregates).
    Response shape: ``{by_day: [{date, p50_ms, p95_ms, p99_ms}]}``.
    """
    await require_org_permission("audit:view", org_id)

    client = await get_postgres_client()
    now = datetime.utcnow()
    start_date = now - timedelta(days=days)

    query = """
        SELECT DATE(timestamp) AS day,
               percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
               percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_ms
        FROM telemetry_events
        WHERE tenant_id = $1
          AND duration_ms IS NOT NULL
          AND timestamp >= $2
        GROUP BY DATE(timestamp)
        ORDER BY day ASC
    """
    rows = await client.fetch(query, org_id, start_date)
    by_day = [
        {
            "date": row["day"].isoformat(),
            "p50_ms": float(row["p50_ms"] or 0.0),
            "p95_ms": float(row["p95_ms"] or 0.0),
            "p99_ms": float(row["p99_ms"] or 0.0),
        }
        for row in rows
    ]
    return {"by_day": by_day}


@router.get("/throughput", response_model=dict)
async def get_throughput_by_hour(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
):
    """Per-hour-of-day request throughput from ``telemetry_events``.

    Aggregates request count by (hour-of-day, day-of-week) so the heatmap
    can render a 7×24 grid. Response shape:
    ``{by_hour: [{hour, weekday, requests}]}``.
    """
    await require_org_permission("audit:view", org_id)

    client = await get_postgres_client()
    now = datetime.utcnow()
    start_date = now - timedelta(days=days)

    query = """
        SELECT EXTRACT(HOUR FROM timestamp)::int AS hour,
               EXTRACT(DOW FROM timestamp)::int AS weekday,
               COUNT(*) AS requests
        FROM telemetry_events
        WHERE tenant_id = $1
          AND timestamp >= $2
        GROUP BY hour, weekday
        ORDER BY hour ASC, weekday ASC
    """
    rows = await client.fetch(query, org_id, start_date)
    by_hour = [
        {
            "hour": int(row["hour"]),
            "weekday": int(row["weekday"]),
            "requests": int(row["requests"]),
        }
        for row in rows
    ]
    return {"by_hour": by_hour}


@router.get("/top-agents", response_model=dict)
async def get_top_agents_by_cost(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
):
    """Top agents by total cost from ``usage_events``.

    Groups by ``model`` (the agent name lives in the metadata for now;
    this matches the existing usage_events schema where ``model`` carries
    the agent identifier). Response shape:
    ``{agents: [{agent, cost_usd, requests, avg_latency_ms}]}``.
    """
    await require_org_permission("audit:view", org_id)

    client = await get_postgres_client()
    now = datetime.utcnow()
    start_date = now - timedelta(days=days)

    query = """
        SELECT model AS agent,
               COUNT(*) AS requests,
               COALESCE(SUM(cost_usd), 0) AS cost_usd,
               COALESCE(AVG((metadata->>'latency_ms')::numeric), 0) AS avg_latency_ms
        FROM usage_events
        WHERE org_id = $1
          AND event_type = 'llm_call'
          AND model IS NOT NULL
          AND created_at >= $2
        GROUP BY model
        ORDER BY cost_usd DESC
        LIMIT 25
    """
    rows = await client.fetch(query, org_id, start_date)
    agents = [
        {
            "agent": row["agent"],
            "requests": int(row["requests"]),
            "cost_usd": float(row["cost_usd"] or 0.0),
            "avg_latency_ms": float(row["avg_latency_ms"] or 0.0),
        }
        for row in rows
    ]
    return {"agents": agents}
