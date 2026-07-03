"""Organization analytics routes for Eden API."""

import logging
from datetime import datetime, timedelta, UTC

from fastapi import APIRouter, Depends, Query

from eden.api.deps import get_current_user, require_org_permission_dep, require_org_permission  # noqa: F401  (monkeypatched by tests/api/test_analytics_routes.py)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/analytics", tags=["analytics"])


@router.get("", response_model=dict)
async def get_org_analytics(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
        _check_audit_view: dict = Depends(require_org_permission_dep('audit:view')),
):
    """Get analytics for an organization.

    Returns usage statistics including job counts over time, reference upload
    trends, member activity, and storage usage.
    """
    # Require audit:view permission (owner/admin)

    client = await get_postgres_client()
    now = datetime.now(UTC)
    start_date = now - timedelta(days=days)

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
        "job_counts_by_day": [],  # jobs feature removed June 2026
        "reference_uploads_by_day": reference_uploads_by_day,
        "active_members_count": active_members_count,
        "total_references": total_references,
        "storage_bytes_used": storage_bytes_used,
        "member_activity": member_activity,
    }


# ───────────────────────────────────────────────────────────────────
# Phase A.1 — sub-routes for the analytics dashboard.
# Each emits one SQL aggregate against ``usage_events`` or
# ``telemetry_events`` scoped to the request's org_id and the
# trailing N-day window (default 30).
# ────────────────────────────────────────────────────────────────────

@router.get("/token-usage", response_model=dict)
async def token_usage(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
):
    """Sum input/output tokens per day from ``usage_events``."""
    start = datetime.now(UTC) - timedelta(days=days)
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT DATE(created_at) AS day,
               SUM(COALESCE((metadata->>'input_tokens')::int, 0))  AS input_tokens,
               SUM(COALESCE((metadata->>'output_tokens')::int, 0)) AS output_tokens
        FROM usage_events
        WHERE org_id = $1
          AND event_type = 'llm_call'
          AND created_at >= $2
        GROUP BY DATE(created_at)
        ORDER BY day
        """,
        org_id, start,
    )
    return {
        "by_day": [
            {"day": r["day"].isoformat() if hasattr(r["day"], "isoformat") else r["day"],
             "input_tokens": int(r["input_tokens"]),
             "output_tokens": int(r["output_tokens"])}
            for r in rows
        ]
    }


@router.get("/latency", response_model=dict)
async def latency(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
):
    """Per-day latency percentiles from ``telemetry_events``."""
    start = datetime.now(UTC) - timedelta(days=days)
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT DATE(timestamp) AS day,
               percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
               percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_ms
        FROM telemetry_events
        WHERE tenant_id = $1
          AND duration_ms IS NOT NULL
          AND timestamp >= $2
        GROUP BY DATE(timestamp)
        ORDER BY day
        """,
        org_id, start,
    )
    return {
        "by_day": [
            {"day": r["day"].isoformat() if hasattr(r["day"], "isoformat") else r["day"],
             "p50_ms": float(r["p50_ms"]) if r["p50_ms"] is not None else None,
             "p95_ms": float(r["p95_ms"]) if r["p95_ms"] is not None else None,
             "p99_ms": float(r["p99_ms"]) if r["p99_ms"] is not None else None}
            for r in rows
        ]
    }


@router.get("/throughput", response_model=dict)
async def throughput(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
):
    """Request counts per (weekday, hour-of-day) bucket for heatmap viz."""
    start = datetime.now(UTC) - timedelta(days=days)
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT EXTRACT(HOUR FROM timestamp)::int AS hour,
               EXTRACT(DOW FROM timestamp)::int AS weekday,
               COUNT(*) AS requests
        FROM telemetry_events
        WHERE tenant_id = $1
          AND timestamp >= $2
        GROUP BY EXTRACT(HOUR FROM timestamp), EXTRACT(DOW FROM timestamp)
        ORDER BY weekday, hour
        """,
        org_id, start,
    )
    return {
        "by_hour": [
            {"hour": int(r["hour"]), "weekday": int(r["weekday"]),
             "requests": int(r["requests"])}
            for r in rows
        ]
    }


@router.get("/top-agents", response_model=dict)
async def top_agents(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
):
    """Top 25 models by spend over the window. ``agent`` is the
    canonical proxy for "what model was called" until we get a
    proper agent_id column on ``usage_events``."""
    start = datetime.now(UTC) - timedelta(days=days)
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT model AS agent,
               COUNT(*) AS requests,
               COALESCE(SUM(cost_usd), 0) AS cost_usd,
               COALESCE(AVG((metadata->>'latency_ms')::float), 0) AS avg_latency_ms
        FROM usage_events
        WHERE org_id = $1
          AND event_type = 'llm_call'
          AND model IS NOT NULL
          AND created_at >= $2
        GROUP BY model
        ORDER BY cost_usd DESC
        LIMIT 25
        """,
        org_id, start,
    )
    return {
        "agents": [
            {"agent": r["agent"],
             "requests": int(r["requests"]),
             "cost_usd": float(r["cost_usd"]),
             "avg_latency_ms": float(r["avg_latency_ms"])}
            for r in rows
        ]
    }
