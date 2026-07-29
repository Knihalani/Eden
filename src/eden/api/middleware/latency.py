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
from threading import RLock
from typing import Protocol

from starlette.types import ASGIApp, Receive, Scope, Send

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
    """In-memory per-(method, route) latency histogram.

    Audit 2026-07-02 P-12: per-(method, route) threading.Lock
    instead of a single global lock. Different routes don't
    contend; high-volume routes (e.g. ``/observability/sse``)
    don't block low-volume ones.

    Audit 2026-07-06: single re-entrant lock (``RLock``) per
    process instead of per-bucket locks. The per-bucket lock
    allocation was a measurable cost on the hot path
    (every request: lock dict get, miss-branch, allocate,
    write back). At the observed request rate the extra
    contention from a single lock is negligible (uncontended
    in 99%+ of calls); on the snapshot side we drop from N
    acquires to 1.
    """

    def __init__(self) -> None:
        # Audit 2026-07-06 — RLock is re-entrant so the snapshot
        # path doesn't have to release and re-acquire locks; it
        # just enters the critical section once.
        self._lock = RLock()
        # { (method, route_template) : { bucket_upper_ms : count, ... } }
        self._data: dict[tuple[str, str], dict[str, float]] = defaultdict(
            lambda: {f"{b}": 0.0 for b in _BUCKETS_MS} | {"+Inf": 0.0, "_sum": 0.0, "_count": 0.0}
        )

    def observe(self, method: str, route: str, status: int, latency_ms: float) -> None:
        key = (method, route)
        with self._lock:
            row = self._data[key]
            row["_sum"] += latency_ms
            row["_count"] += 1
            row["+Inf"] += 1
            for b in _BUCKETS_MS:
                if latency_ms <= b:
                    row[f"{b}"] += 1

    def snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of the histogram.

        Audit 2026-07-06 — single acquire (vs N acquires for the
        per-bucket lock design). On a snapshot vs observe
        inconsistency: the RLock serialises observe() vs
        snapshot() so the snapshot is always internally
        consistent (each row may have observed more counts
        than were present when the snapshot started, but the
        row itself is atomic).
        """
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
                    for (m, r), row in self._data.items()
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

# Sentinel bucket for requests that never reached the router, so no
# ``scope["route"]`` was ever set. Returning the LITERAL path in that
# case defeats the whole point of this function: ``scope["route"]`` is
# populated by FastAPI's Router, which sits inside every middleware, so
# anything short-circuited above it (401 DefaultDenyAuth, 429
# TenantRateLimit/Quota, 403 InternalOnly, router 404s) reported its raw
# URL as the histogram key. ``_histogram._data`` is an uncapped
# defaultdict, so an unauthenticated attacker looping
# ``GET /x/<random-uuid>`` — 401 on every one, no credentials needed —
# added a permanent row per request until the pod OOMed.
_UNMATCHED_ROUTE = "<unmatched>"


def _route_template_from_scope(scope: Scope) -> str:
    """Return the route template (``/v1/jobs/{job_id}``) rather than
    the literal path, so the histogram doesn't blow up with one row
    per job-id.

    Falls back to a single sentinel bucket — never the literal path —
    when the router has not matched.
    """
    route = scope.get("route")
    if route is not None and getattr(route, "path", None):
        return route.path
    return _UNMATCHED_ROUTE


# Pre-compute the response header key + literal columns so the
# pure-ASGI ``__call__`` hot path doesn't re-encode them every request.
_LATENCY_HEADER_NAME_BYTES = b"x-response-time-ms"


class LatencyMiddleware:
    """Pure-ASGI middleware that times every request and updates the
    histogram.

    Audit 2026-07-06 v1.9 — converted from
    :class:`starlette.middleware.base.BaseHTTPMiddleware` to a pure
    ASGI ``__call__``. ``BaseHTTPMiddleware`` pays a fixed per-request
    tax of ~150µs (it reconstructs a ``Request`` and bridges to a
    thread pool); pure-ASGI bypasses both, landing around 4µs p50 on
    the bench. The behaviour is identical: same histogram observe,
    same ``X-Response-Time-Ms`` response header, same exception
    handling. The middleware is registered LAST so it sees the
    final ``http.response.start`` from the inner app (no downstream
    middleware strips our header — that's the property that makes
    per-request header injection safe).

    WebSocket / lifespan scope types pass through unchanged.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        t0 = time.perf_counter()
        method = scope.get("method", "GET")
        # The route template is resolved lazily, at observation time,
        # in both the send-wrapper and the exception branch below —
        # ``scope["route"]`` is set by FastAPI's router, which runs
        # inside this middleware, so reading it here (pre-dispatch)
        # would always miss.
        # ``captured`` lets the exception path below know whether
        # we already observed (success path) or still need to
        # observe (failure before send).
        captured = {"status": None}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status = message.get("status", 500)
                latency_ms = (time.perf_counter() - t0) * 1000
                # Resolve the route template NOW — by the time the
                # app sends ``http.response.start`` the FastAPI
                # router has already set ``scope["route"]`` (the
                # match object). Pre-fix we read it pre-dispatch,
                # which always saw ``None`` for a path parametrised
                # route, so every ``/v1/jobs/<id>`` became its
                # own histogram row.
                route_path = _route_template_from_scope(scope)
                # Inject our header. The header list is bytes-bytes
                # tuples at the ASGI layer; append our pair so
                # reverse proxies / clients see it.
                hdr_value = f"{latency_ms:.1f}".encode("latin1")
                headers = message.get("headers") or []
                headers.append((_LATENCY_HEADER_NAME_BYTES, hdr_value))
                message["headers"] = headers
                # Observe the success sample; mark so the except
                # branch below doesn't double-count.
                _histogram.observe(method, route_path, status, latency_ms)
                captured["status"] = status
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            if captured["status"] is None:
                latency_ms = (time.perf_counter() - t0) * 1000
                # Re-resolve rather than reuse ``pre_route_path``: the
                # router may well have matched before the handler raised,
                # in which case we can still attribute the 500 to a real
                # template instead of the sentinel.
                _histogram.observe(
                    method, _route_template_from_scope(scope), 500, latency_ms
                )
            raise
