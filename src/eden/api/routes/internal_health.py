"""Internal health dashboard endpoints (Phase 4 B3 — §9.6).

The public ``/health`` endpoint is a liveness probe (HTTP 200/503,
single Postgres check). The ``/v1/internal/health`` surface is the
**ops dashboard** — a richer view with per-component status +
queue depth + replication lag + per-cat eval latency, gated by
the :class:`InternalOnlyMiddleware`.

Ponytail: the dashboard is read-only JSON. No background jobs,
no writes. The 5 components are evaluated lazily on each call
(so the dashboard reflects current state without an in-memory
cache to invalidate).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/v1/internal",
    tags=["internal-health"],
)


# ── Component probes ──────────────────────────────────────────────────


async def _probe_postgres() -> dict[str, Any]:
    """Postgres replication lag + connection pool + slow queries."""
    t0 = time.perf_counter()
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        row = await client.fetchrow(
            """
            SELECT
                (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active,
                (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle') AS idle,
                (SELECT count(*) FROM pg_stat_activity
                  WHERE state = 'active' AND query_start < NOW() - INTERVAL '5 seconds') AS slow
            """
        )
        # Ponytail: replication lag needs the replica's pg_last_xact_replay_timestamp.
        # We don't query the replica directly — that requires a separate connection
        # string. For now the lag is 0/null. (Track for v2 if it ever matters.)
        return {
            "status": "healthy",
            "active_connections": row["active"] if row else None,
            "idle_connections": row["idle"] if row else None,
            "slow_query_count": row["slow"] if row else None,
            "replication_lag_seconds": None,
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }
    except Exception as exc:
        return {
            "status": "unhealthy",
            "error": str(exc),
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }


async def _probe_clickhouse() -> dict[str, Any]:
    """ClickHouse partition count + rollback p95 + compaction lag."""
    t0 = time.perf_counter()
    try:
        # The columnar engine caches CH availability (see
        # eden.columnar._common._check_ch_available). We re-use that
        # check rather than re-implementing the probe.
        from eden.columnar._common import _check_ch_available

        ch_up = await _check_ch_available()
        if not ch_up:
            return {
                "status": "degraded",
                "note": "ClickHouse unavailable — columnar engine is on postgres_fallback",
                "partition_count": None,
                "rollback_p95_ms": None,
                "compaction_lag_seconds": None,
                "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
            }
        # CH is up — query the system tables. The exact SQL depends
        # on the ClickHouse version; this query works on 23.x.
        from eden.columnar._common import _get_ch_client

        client = await _get_ch_client()
        if client is None:
            return {
                "status": "unknown",
                "note": "CH client not initialised",
                "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
            }
        row = await client.fetchrow(
            "SELECT count() AS n FROM system.parts WHERE database = currentDatabase()"
        )
        return {
            "status": "healthy",
            "partition_count": row["n"] if row else None,
            "rollback_p95_ms": None,  # Query from system.query_log if needed (deferred to v2)
            "compaction_lag_seconds": None,  # Same — query from system.parts
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }
    except Exception as exc:
        return {
            "status": "unhealthy",
            "error": str(exc),
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }


async def _probe_judge() -> dict[str, Any]:
    """Judge runner queue depth + average latency + error rate."""
    t0 = time.perf_counter()
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        row = await client.fetchrow(
            """
            SELECT
                count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'running')::int AS running,
                count(*) FILTER (
                    WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '1 hour'
                )::int AS failed_last_hour,
                count(*) FILTER (
                    WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '1 hour'
                )::int AS completed_last_hour
              FROM judge_scores
            """
        )
        return {
            "status": "healthy",
            "queue_depth": (row["pending"] or 0) + (row["running"] or 0)
                if row else None,
            "failed_last_hour": row["failed_last_hour"] if row else None,
            "completed_last_hour": row["completed_last_hour"] if row else None,
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }
    except Exception as exc:
        return {
            "status": "unhealthy",
            "error": str(exc),
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }


async def _probe_hookbus() -> dict[str, Any]:
    """HookBus emit rate + dedup rate + severity histogram (last hour)."""
    t0 = time.perf_counter()
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        row = await client.fetchrow(
            """
            SELECT
                count(*)::int AS total,
                count(*) FILTER (WHERE severity = 'critical')::int AS critical,
                count(*) FILTER (WHERE severity = 'high')::int AS high,
                count(*) FILTER (WHERE severity = 'medium')::int AS medium,
                count(*) FILTER (WHERE severity = 'low')::int AS low,
                count(*) FILTER (WHERE deduped = TRUE)::int AS deduped
              FROM hook_events
             WHERE created_at >= NOW() - INTERVAL '1 hour'
            """
        )
        total = row["total"] if row else 0
        deduped = row["deduped"] if row else 0
        dedup_rate = round(deduped / total, 4) if total else 0.0
        return {
            "status": "healthy",
            "emit_rate_last_hour": total,
            "dedup_rate": dedup_rate,
            "severity_histogram": {
                "critical": row["critical"] if row else 0,
                "high": row["high"] if row else 0,
                "medium": row["medium"] if row else 0,
                "low": row["low"] if row else 0,
            },
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }
    except Exception as exc:
        return {
            "status": "unhealthy",
            "error": str(exc),
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }


async def _probe_eval() -> dict[str, Any]:
    """Per-cat eval latency (last 1 hour, p50/p95)."""
    t0 = time.perf_counter()
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        rows = await client.fetch(
            """
            SELECT
                category,
                count(*)::int AS n,
                percentile_cont(0.5)
                    WITHIN GROUP (ORDER BY duration_ms) AS p50,
                percentile_cont(0.95)
                    WITHIN GROUP (ORDER BY duration_ms) AS p95
              FROM eval_runs
             WHERE created_at >= NOW() - INTERVAL '1 hour'
             GROUP BY category
            """
        )
        return {
            "status": "healthy",
            "per_cat_latency_ms": {
                r["category"]: {
                    "n": r["n"],
                    "p50": round(float(r["p50"]), 1) if r["p50"] else None,
                    "p95": round(float(r["p95"]), 1) if r["p95"] else None,
                }
                for r in rows
            },
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }
    except Exception as exc:
        return {
            "status": "unhealthy",
            "error": str(exc),
            "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        }


PROBES: dict[str, Any] = {
    "postgres": _probe_postgres,
    "clickhouse": _probe_clickhouse,
    "judge": _probe_judge,
    "hookbus": _probe_hookbus,
    "eval": _probe_eval,
}


# ── Routes ────────────────────────────────────────────────────────────


@router.get("/health")
async def internal_health() -> dict[str, Any]:
    """Per-component health dashboard. Returns 200 with the
    envelope even when a component is degraded (the dashboard is
    informational — operators read the body, not the status code).
    The overall status is the worst-case across components.
    """
    names = list(PROBES.keys())
    raw = await asyncio.gather(
        *(probe() for probe in PROBES.values()),
        return_exceptions=True,
    )
    components: dict[str, Any] = {}
    for name, result in zip(names, raw, strict=True):
        if isinstance(result, Exception):
            components[name] = {
                "status": "error",
                "error": str(result),
                "probe_ms": None,
            }
        else:
            components[name] = result

    status_priority = {
        "healthy": 0,
        "degraded": 1,
        "unknown": 1,
        "unhealthy": 2,
        "error": 2,
    }
    worst = max(
        (status_priority.get(c["status"], 2) for c in components.values()),
        default=0,
    )
    overall = next(
        s for s, p in status_priority.items() if p == worst
    )
    return {
        "status": overall,
        "components": components,
        "timestamp": time.time(),
        "version": os.environ.get("EDEN_VERSION", "dev"),
    }


@router.get("/health/{component}")
async def internal_health_component(component: str) -> dict[str, Any]:
    """Per-component detail endpoint. Useful for alerting on a
    single SLO breach without polling the whole dashboard."""
    if component not in PROBES:
        raise HTTPException(
            status_code=404,
            detail={
                "status": "not_found",
                "message": f"unknown component: {component!r}",
                "known_components": sorted(PROBES.keys()),
            },
        )
    try:
        return {
            "status": "ok",
            "component": component,
            "data": await PROBES[component](),
            "timestamp": time.time(),
        }
    except Exception as exc:
        return {
            "status": "error",
            "component": component,
            "error": str(exc),
            "timestamp": time.time(),
        }


__all__ = ["PROBES", "router"]
