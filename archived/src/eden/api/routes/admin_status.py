"""F84 — org admin status, flags debugger, synthetics."""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from eden.api.deps import require_org_admin, require_path_org_access
from eden.api.utils.redact import redact_all

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/admin",
    tags=["admin-status"],
    dependencies=[Depends(require_path_org_access)],
)


def _assert_path_org(org_id: str, org: dict) -> None:
    if str(org.get("org_id")) != str(org_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Organization mismatch",
        )


async def _quality_worker_lag() -> float | None:
    try:
        from eden.observability.platform_activation import get_platform_activation_metrics

        metrics = get_platform_activation_metrics()
        return float(metrics.get("eden_quality_worker_lag_seconds", 0.0))
    except Exception as exc:
        logger.debug("admin_status: quality lag probe failed: %s", redact_all(str(exc)))
        return None


def _typesense_index_lag() -> float | None:
    """Average Typesense event-age lag (seconds), or None if no samples."""
    try:
        from eden.observability.search_service import get_search_stats

        stats = get_search_stats()
        count = float(stats.get("index_lag_count", 0) or 0)
        if count <= 0:
            return None
        return float(stats.get("index_lag_sum_s", 0.0) or 0.0) / count
    except Exception as exc:
        logger.debug("admin_status: typesense lag failed: %s", redact_all(str(exc)))
        return None


async def _webhook_dlq_depth(org_id: str) -> int:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return 0
        val = await client.fetchval(
            "SELECT count(*)::int FROM webhook_dlq WHERE org_id = $1",
            org_id,
        )
        return int(val or 0)
    except Exception as exc:
        logger.debug("admin_status: dlq depth failed: %s", redact_all(str(exc)))
        return 0


async def _worker_heartbeats(org_id: str) -> dict[str, Any]:
    try:
        from eden.self_obs.heartbeats import latest_heartbeats, probe_and_record_workers

        await probe_and_record_workers(org_id)
        rows = await latest_heartbeats(org_id=org_id, limit=20)
        from eden.observability.platform_activation import get_platform_activation_metrics
        from eden.workers.background import (
            background_evolution_loop_running,
            background_workers_running,
        )

        pa = get_platform_activation_metrics()
        return {
            "status": "healthy" if background_workers_running() else "degraded",
            "background_workers_running": background_workers_running(),
            "evolution_loop_running": background_evolution_loop_running(),
            "quality_worker_running": pa.get("eden_quality_worker_running", 0),
            "heartbeats": rows,
        }
    except Exception as exc:
        logger.debug("admin_status: worker heartbeat failed: %s", redact_all(str(exc)))
        return {"status": "unknown", "error": redact_all(str(exc))}


def _org_feature_flags() -> dict[str, Any]:
    """Debugger view of key boolean settings for an org admin."""
    from eden.config import get_settings

    s = get_settings()
    keys = (
        "experiments_v1",
        "typesense_enabled",
        "typesense_search_v1",
        "ingestion_layer_enabled",
        "ingestion_shed_enabled",
        "late_span_policy_enabled",
        "content_dedupe_enabled",
        "sampling_enabled",
        "evolution_loop_enabled",
        "promotion_loop_enabled",
        "agent_issues_v0",
    )
    flags: dict[str, Any] = {}
    for key in keys:
        if hasattr(s, key):
            flags[key] = getattr(s, key)
    return flags


GOLDEN_PROBES = (
    "sign_in_home",
    "traces_list",
    "issues_list",
    "gateway_health",
    "detect_to_issue",
)


@router.get("/eden-status")
async def eden_status(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Worker health, queue depths, ingest lag — portal Settings status tab."""
    _assert_path_org(org_id, org)
    t0 = time.perf_counter()
    lag = await _quality_worker_lag()
    ts_lag = _typesense_index_lag()
    dlq = await _webhook_dlq_depth(org_id)
    workers = await _worker_heartbeats(org_id)

    ingest_status = "healthy"
    if (lag is not None and lag >= 60) or (ts_lag is not None and ts_lag >= 60):
        ingest_status = "degraded"

    try:
        from eden.observability.ingestion.shed import shed_snapshot

        shed = shed_snapshot()
    except Exception:
        shed = {}

    components: dict[str, Any] = {
        "ingest": {
            "status": ingest_status,
            "quality_worker_lag_seconds": lag,
            "typesense_index_lag_seconds": ts_lag,
            "shed": shed,
        },
        "workers": workers,
        "webhook_dlq": {"depth": dlq, "status": "healthy" if dlq < 50 else "degraded"},
        "postgres": {
            "status": "healthy",
            "note": "Cluster query stats are not exposed to tenants",
        },
    }
    worst = "healthy"
    for c in components.values():
        st = c.get("status", "healthy")
        if st in ("unhealthy", "error"):
            worst = "unhealthy"
            break
        if st == "degraded" and worst == "healthy":
            worst = "degraded"

    return {
        "status": worst,
        "org_id": org_id,
        "components": components,
        "request_id_note": "Portal 5xx responses include request_id for log correlation.",
        "probe_ms": round((time.perf_counter() - t0) * 1000, 2),
        "timestamp": time.time(),
    }


@router.get("/flags")
async def admin_flags(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Feature-flag debugger for org admins (F84)."""
    _assert_path_org(org_id, org)
    return {
        "org_id": org_id,
        "flags": _org_feature_flags(),
        "note": "Boolean / config flags visible to org admins for dogfood debugging.",
    }


@router.get("/slow-queries")
async def slow_queries(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Tenant-safe stub — cluster query stats are not exposed (Wave 1)."""
    _assert_path_org(org_id, org)
    return {
        "org_id": org_id,
        "slow_query_count": None,
        "available": False,
        "note": "Cluster query stats are not exposed to tenants",
    }


def _percentile_from_buckets(
    buckets_ms: list[int | float],
    row_buckets: dict[str, float],
    count: float,
    q: float,
) -> float | None:
    """Derive the q-th percentile (0 < q < 1) from cumulative histogram buckets.

    The latency middleware records Prometheus-style cumulative bucket
    counts (``{"5": n, ..., "10000": n, "+Inf": n}``); percentiles are
    NOT precomputed, so we linearly interpolate within the first bucket
    whose cumulative count reaches ``q * count`` (same estimator as
    ``histogram_quantile``). Observations landing in the ``+Inf`` bucket
    clamp to the highest finite bound — an honest upper-bound estimate,
    not a fabricated value.
    """
    if count <= 0:
        return None
    target = q * count
    prev_bound = 0.0
    prev_cum = 0.0
    for b in buckets_ms:
        cum = row_buckets.get(str(b), 0.0)
        if cum >= target:
            if cum == prev_cum:
                return float(b)
            return round(
                prev_bound + (float(b) - prev_bound) * (target - prev_cum) / (cum - prev_cum),
                2,
            )
        prev_bound, prev_cum = float(b), cum
    # Falls in the +Inf bucket: no finite upper bound exists.
    return float(buckets_ms[-1])


@router.get("/latency-histograms")
async def latency_histograms(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Per-(method, route) API latency percentiles for org admins (§11.1).

    Reads the in-memory latency histogram recorded by
    ``LatencyMiddleware`` and derives p50/p95/p99 from the cumulative
    buckets. Process-global (route templates only — no tenant data).
    """
    _assert_path_org(org_id, org)
    from eden.api.middleware.latency import get_metrics_snapshot

    snap = get_metrics_snapshot()
    buckets_ms = snap.get("buckets_ms", [])
    routes = [
        {
            "method": row["method"],
            "route": row["route"],
            "count": int(row["count"]),
            "p50_ms": _percentile_from_buckets(buckets_ms, row["buckets"], row["count"], 0.50),
            "p95_ms": _percentile_from_buckets(buckets_ms, row["buckets"], row["count"], 0.95),
            "p99_ms": _percentile_from_buckets(buckets_ms, row["buckets"], row["count"], 0.99),
        }
        for row in snap.get("rows", [])
    ]
    routes.sort(key=lambda r: (r["route"], r["method"]))
    return {
        "org_id": org_id,
        "buckets_ms": buckets_ms,
        "routes": routes,
        "note": (
            "Process-global API latency since worker start; percentiles are "
            "derived from histogram buckets (linear interpolation, +Inf "
            "clamped to the highest finite bound)."
        ),
    }


@router.post("/synthetics/run")
async def run_synthetics(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Run golden-path synthetics (deterministic; no paid LLM)."""
    _assert_path_org(org_id, org)
    from eden.self_obs.synthetics import run_golden_probes

    return await run_golden_probes(org_id, probes=GOLDEN_PROBES)


@router.get("/synthetics/last")
async def last_synthetics(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    _assert_path_org(org_id, org)
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return {"runs": []}
        # Read this org's rows plus the shared sentinel's. The two
        # org-independent probes (sign_in_home, gateway_health) hit
        # fixed URLs, so their result is identical for every org and is
        # now written once per tick under _SHARED_ORG_ID rather than
        # once per org — see eden.self_obs.synthetics._SHARED_ORG_ID.
        # Without the sentinel in this query those two probes would
        # silently vanish from every org's dashboard.
        from eden.self_obs.synthetics import _SHARED_ORG_ID

        rows = await client.fetch(
            """
            SELECT probe, status, detail, created_at
              FROM eden_synthetic_runs
             WHERE org_id = $1 OR org_id = $2::uuid
             ORDER BY created_at DESC
             LIMIT 20
            """,
            org_id,
            _SHARED_ORG_ID,
        )
        return {
            "runs": [
                {
                    "probe": r["probe"],
                    "status": r["status"],
                    "detail": r["detail"],
                    "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                }
                for r in rows
            ]
        }
    except Exception as exc:
        logger.debug("admin_status: synthetics history unavailable: %s", redact_all(str(exc)))
        return {"runs": [], "note": "eden_synthetic_runs table not migrated"}


__all__ = ["router"]
