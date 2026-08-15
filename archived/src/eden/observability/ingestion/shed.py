"""Ingest load-shed gate (SOTA Wave 9).

When the in-process ingest queue / buffer depth exceeds a threshold,
new requests receive HTTP 429 with Retry-After instead of accepting
more work. Distinct from per-tenant RPM limits.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger(__name__)

_shed_stats: dict[str, float] = {
    "checks": 0.0,
    "shed_total": 0.0,
    "last_depth": 0.0,
    "last_shed_at": 0.0,
}


def get_shed_stats() -> dict[str, float]:
    return dict(_shed_stats)


def record_shed(*, depth: int) -> None:
    _shed_stats["shed_total"] += 1.0
    _shed_stats["last_depth"] = float(depth)
    _shed_stats["last_shed_at"] = time.time()


def current_ingest_depth() -> int:
    """Best-effort depth from collector CH buffer + quality lag proxy."""
    depth = 0
    try:
        import eden.observability.telemetry_collector as tc

        collector = getattr(tc, "_telemetry_collector", None)
        if collector is not None:
            buf = getattr(collector, "_ch_telemetry_buffer", None)
            if buf is not None:
                depth += len(buf)
    except Exception:
        pass
    try:
        from eden.observability.platform_activation import get_platform_activation_metrics

        metrics = get_platform_activation_metrics()
        lag = float(metrics.get("eden_quality_worker_lag_seconds", 0.0) or 0.0)
        # Treat sustained lag as pressure: 1 unit per 10s lag.
        depth += int(lag // 10)
    except Exception:
        pass
    return depth


def check_ingest_shed(org_id: str | None = None) -> None:
    """Raise 429 when shed is enabled and depth exceeds the threshold."""
    _shed_stats["checks"] += 1.0
    try:
        from eden.config import get_settings

        settings = get_settings()
    except Exception:
        return

    if not bool(getattr(settings, "ingestion_shed_enabled", True)):
        return

    max_depth = int(getattr(settings, "ingestion_shed_max_depth", 5000) or 5000)
    if max_depth <= 0:
        return

    depth = current_ingest_depth()
    _shed_stats["last_depth"] = float(depth)
    if depth < max_depth:
        return

    record_shed(depth=depth)
    retry_after = int(getattr(settings, "ingestion_shed_retry_after_seconds", 5) or 5)
    logger.warning(
        "ingest shed: depth=%s max=%s org=%s",
        depth,
        max_depth,
        org_id or "-",
    )
    raise HTTPException(
        status_code=429,
        detail={
            "error": "ingest_shed",
            "message": "Ingest temporarily shed due to backpressure",
            "depth": depth,
            "max_depth": max_depth,
        },
        headers={"Retry-After": str(max(1, retry_after))},
    )


def shed_snapshot() -> dict[str, Any]:
    return {
        **get_shed_stats(),
        "depth": current_ingest_depth(),
    }
