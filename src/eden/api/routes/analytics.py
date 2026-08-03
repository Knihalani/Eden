"""Organization analytics routes for Eden API."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query

from eden.api.deps import (  # noqa: F401  (monkeypatched by tests/api/test_analytics_routes.py)
    get_current_user,
    require_org_permission,
    require_org_permission_dep,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import raise_mapped_db_error
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/analytics", tags=["analytics"], dependencies=[Depends(require_path_org_access)])


async def _analytics_client():
    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="database unavailable")
    return client


def _reraise_analytics(exc: Exception, *, fallback: str) -> NoReturn:
    logger.warning("analytics query failed: %s", redact_all(str(exc)))
    raise_mapped_db_error(
        exc,
        fallback=fallback,
        uuid_detail="Invalid organization id",
        fk_detail="Organization not found",
    )


async def _telemetry_from_clickhouse(
    org_id: str,
    *,
    days: int,
    kind: str,
) -> list[dict[str, Any]] | None:
    """Prefer CH/Tinybird ``telemetry_events_ch`` aggregates; soft-fail to None.

    Same pattern as Home KPI in ``wave6_online``: reachability is not
    populatedness — an empty CH answer falls through to Postgres.
    ``telemetry_events_query_api.pipe`` is a raw-row ENDPOINT (filters +
    LIMIT, no percentile/heatmap aggregates), so latency/throughput use
    ``/v0/sql`` via ``ClickHouseSink._execute``.
    """
    try:
        from eden.config import get_settings
        from eden.data_platform.clickhouse_sink import get_clickhouse_sink

        url = getattr(get_settings(), "clickhouse_url", "") or ""
        if not url.strip():
            return None
        sink = await get_clickhouse_sink()
        if kind == "latency":
            rows = await sink.query_latency_by_day(org_id, days=days)
        elif kind == "throughput":
            rows = await sink.query_throughput_heatmap(org_id, days=days)
        else:
            return None
        return rows if rows else None
    except Exception as exc:
        logger.debug(
            "analytics %s CH read failed; using PG: %s",
            kind,
            redact_all(str(exc)),
        )
        return None


@router.get("", response_model=dict)
async def get_org_analytics(
    org_id: str = Depends(require_path_org_access),
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
        _check_audit_view: dict = Depends(require_org_permission_dep('audit:view'))
):
    """Get analytics for an organization.

    Returns usage statistics including job counts over time, reference upload
    trends, member activity, and storage usage.
    """
    # Require audit:view permission (owner/admin)

    client = await _analytics_client()
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
    try:
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

        # Member activity (last_active_at) — bounded so a large roster
        # cannot dump the full org_members × users join on every analytics
        # page load. UI shows a "recent activity" table, not a full census.
        member_activity_query = """
            SELECT om.user_id, om.role, om.joined_at, om.last_active_at,
                   u.email, u.name
            FROM org_members om
            JOIN users u ON u.id = om.user_id
            WHERE om.org_id = $1
            ORDER BY om.last_active_at DESC NULLS LAST
            LIMIT 100
        """
        member_activity_rows = await client.fetch(member_activity_query, org_id)
    except Exception as exc:
        _reraise_analytics(exc, fallback="analytics unavailable")
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
    org_id: str = Depends(require_path_org_access),
    days: int = Query(default=30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
):
    """Sum input/output tokens per day from ``usage_events``."""
    start = datetime.now(UTC) - timedelta(days=days)
    client = await _analytics_client()
    try:
        rows = await client.fetch(
            """
            SELECT DATE(created_at) AS day,
                   SUM(COALESCE((NULLIF(metadata->>'input_tokens', ''))::numeric, 0))
                     AS input_tokens,
                   SUM(COALESCE((NULLIF(metadata->>'output_tokens', ''))::numeric, 0))
                     AS output_tokens
            FROM usage_events
            WHERE org_id = $1
              AND event_type = 'llm_call'
              AND created_at >= $2
            GROUP BY DATE(created_at)
            ORDER BY day
            """,
            org_id, start,
        )
    except Exception as exc:
        _reraise_analytics(exc, fallback="token usage unavailable")
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
    org_id: str = Depends(require_path_org_access),
    days: int = Query(default=30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
):
    """Per-day latency percentiles from ``telemetry_events_ch`` (PG fallback)."""
    ch_rows = await _telemetry_from_clickhouse(org_id, days=days, kind="latency")
    if ch_rows is not None:
        return {
            "by_day": [
                {
                    "day": r["day"],
                    "p50_ms": float(r["p50_ms"]) if r.get("p50_ms") is not None else None,
                    "p95_ms": float(r["p95_ms"]) if r.get("p95_ms") is not None else None,
                    "p99_ms": float(r["p99_ms"]) if r.get("p99_ms") is not None else None,
                }
                for r in ch_rows
            ],
            "data_source": "clickhouse",
        }

    start = datetime.now(UTC) - timedelta(days=days)
    client = await _analytics_client()
    try:
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
    except Exception as exc:
        _reraise_analytics(exc, fallback="latency analytics unavailable")
    return {
        "by_day": [
            {"day": r["day"].isoformat() if hasattr(r["day"], "isoformat") else r["day"],
             "p50_ms": float(r["p50_ms"]) if r["p50_ms"] is not None else None,
             "p95_ms": float(r["p95_ms"]) if r["p95_ms"] is not None else None,
             "p99_ms": float(r["p99_ms"]) if r["p99_ms"] is not None else None}
            for r in rows
        ],
        "data_source": "postgres",
    }


@router.get("/throughput", response_model=dict)
async def throughput(
    org_id: str = Depends(require_path_org_access),
    days: int = Query(default=30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
):
    """Request counts per (weekday, hour-of-day); CH preferred, PG fallback."""
    ch_rows = await _telemetry_from_clickhouse(org_id, days=days, kind="throughput")
    if ch_rows is not None:
        return {
            "by_hour": [
                {
                    "hour": int(r["hour"]),
                    "weekday": int(r["weekday"]),
                    "requests": int(r["requests"]),
                }
                for r in ch_rows
            ],
            "data_source": "clickhouse",
        }

    start = datetime.now(UTC) - timedelta(days=days)
    client = await _analytics_client()
    try:
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
    except Exception as exc:
        _reraise_analytics(exc, fallback="throughput analytics unavailable")
    return {
        "by_hour": [
            {"hour": int(r["hour"]), "weekday": int(r["weekday"]),
             "requests": int(r["requests"])}
            for r in rows
        ],
        "data_source": "postgres",
    }


@router.get("/top-agents", response_model=dict)
async def top_agents(
    org_id: str = Depends(require_path_org_access),
    days: int = Query(default=30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
):
    """Top 25 models by spend over the window. ``agent`` is the
    canonical proxy for "what model was called" until we get a
    proper agent_id column on ``usage_events``."""
    start = datetime.now(UTC) - timedelta(days=days)
    client = await _analytics_client()
    try:
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
    except Exception as exc:
        _reraise_analytics(exc, fallback="top-agents analytics unavailable")
    return {
        "agents": [
            {"agent": r["agent"],
             "requests": int(r["requests"]),
             "cost_usd": float(r["cost_usd"]),
             "avg_latency_ms": float(r["avg_latency_ms"])}
            for r in rows
        ]
    }
