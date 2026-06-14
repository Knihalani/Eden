"""API latency middleware (§11.1).

Records end-to-end request latency per (method, route) and exposes
the histogram via ``get_metrics_snapshot()`` for the alerts engine
(§9.5.1) and the latency dashboard.

Modeled on ``correlation_id.py`` + ``api_version.py``: starlette
BaseHTTPMiddleware with a perf_counter delta. The middleware itself
is dependency-free (no Prometheus client) so it ships without a new
third-party dep; the ``MetricsExporter`` protocol is a thin facade
that callers can replace with a Prometheus backend later.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from threading import Lock
from typing import Any, Protocol, cast

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# MetricsExporter — pluggable sink. Default is the in-memory
# LatencyHistogram; tests and the alerts engine read from there.
# ─────────────────────────────────────────────────────────────────────────────

class MetricsExporter(Protocol):
    def observe(self, method: str, route: str, status: int, latency_ms: float) -> None: ...
    def snapshot(self) -> dict: ...


# Bucket boundaries in ms. Designed for the §11.1 SLO: p95 < 200ms,
# p99 < 500ms. We use a log-scale-ish layout that gives good
# resolution at both 50ms and 1s.
_BUCKETS_MS = (5, 10, 25, 50, 100, 200, 500, 1000, 2500, 5000, 10000)


class LatencyHistogram:
    """In-memory per-(method, route) latency histogram."""

    def __init__(self) -> None:
        self._lock = Lock()
        # { (method, route_template) : { bucket_upper_ms : count, "+Inf": count, "_sum": float, "_count": int } }
        self._data: dict[tuple[str, str], dict[str, float]] = defaultdict(
            lambda: {f"{b}": 0.0 for b in _BUCKETS_MS} | {"+Inf": 0.0, "_sum": 0.0, "_count": 0.0}
        )

    def observe(self, method: str, route: str, status: int, latency_ms: float) -> None:
        with self._lock:
            row = self._data[(method, route)]
            row["_sum"] += latency_ms
            row["_count"] += 1
            row["+Inf"] += 1
            for b in _BUCKETS_MS:
                if latency_ms <= b:
                    row[f"{b}"] += 1

    def snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of the histogram."""
        with self._lock:
            return {
                "buckets_ms": list(_BUCKETS_MS),
                "rows": [
                    {
                        "method": m,
                        "route": r,
                        "buckets": {k: v for k, v in row.items() if k != "_sum" and k != "_count"},
                        "sum_ms": row["_sum"],
                        "count": row["_count"],
                    }
                    for (m, r), row in sorted(self._data.items())
                ],
            }


# Process-wide singleton. Tests can monkey-patch ``get_metrics_snapshot``
# to swap this out.
_histogram = LatencyHistogram()


def get_metrics_snapshot() -> dict:
    return _histogram.snapshot()


def reset_metrics_snapshot() -> None:
    """Reset the in-memory histogram. Tests only."""
    global _histogram
    _histogram = LatencyHistogram()


# ─────────────────────────────────────────────────────────────────────────────
# Middleware
# ─────────────────────────────────────────────────────────────────────────────

def _route_template(request: Request) -> str:
    """Return the route template (``/v1/jobs/{job_id}``) rather than
    the literal path, so the histogram doesn't blow up with one row
    per job-id."""
    route = request.scope.get("route")
    if route is not None and getattr(route, "path", None):
        return cast(str, route.path)
    return request.url.path


class LatencyMiddleware(BaseHTTPMiddleware):
    """Starlette middleware that times every request and updates the
    histogram. Runs AFTER ``CorrelationIdMiddleware`` so the
    correlation ID is in scope (and BEFORE the route, so we measure
    the full request lifecycle)."""

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        t0 = time.perf_counter()
        try:
            response: Response = await call_next(request)
        except Exception:
            latency_ms = (time.perf_counter() - t0) * 1000
            _histogram.observe(request.method, _route_template(request), 500, latency_ms)
            raise
        latency_ms = (time.perf_counter() - t0) * 1000
        _histogram.observe(request.method, _route_template(request), response.status_code, latency_ms)
        # Echo the latency as a response header for client-side
        # diagnostics. Cheap; doesn't go through any middleware chain.
        response.headers["X-Response-Time-Ms"] = f"{latency_ms:.1f}"
        return response
