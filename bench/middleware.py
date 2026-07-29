"""Per-request middleware hot-path benchmark.

Measures the wall-clock cost of the middlewares that run on every
HTTP request (DefaultDeny, CorrelationId, Latency, etc.) without
the network or DB. Designed to catch regressions in the auth
allow-list and histogram-snapshot paths.

Run with: ``python bench/middleware.py [--json]``
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

from bench.common import BenchResult, bench_async


def _build_scope(
    path: str = "/v1/secret",
    method: str = "GET",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> dict:
    """Build a minimal ASGI scope for the pure-ASGI middlewares."""
    if headers is None:
        headers = [(b"host", b"testserver")]
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("latin1"),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "root_path": "",
    }


async def _noop_app(scope, receive, send):
    """Terminal ASGI app that just sends a 200."""
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b""})


async def _bench_default_deny(n: int = 1000) -> BenchResult:
    """Benchmark the DefaultDenyAuthMiddleware hot path."""
    from eden.api.middleware.default_deny import DefaultDenyAuthMiddleware

    mw = DefaultDenyAuthMiddleware(_noop_app)
    headers_with_auth = [
        (b"host", b"test"),
        (b"authorization", b"Bearer test-token"),
    ]
    scope_auth = _build_scope("/v1/secret", headers=headers_with_auth)
    scope_public = _build_scope("/health", headers=[(b"host", b"test")])

    async def one():
        # Test both paths: authenticated (deep in the allow-list)
        # and public (early-exit)
        for sc in (scope_auth, scope_public):
            sent: list[dict] = []
            async def send(msg):
                sent.append(msg)
            await mw(sc, None, send)

    return await bench_async("default_deny_dispatch", one, n=n)


async def _bench_latency_observe(n: int = 1000) -> BenchResult:
    """Benchmark the LatencyHistogram observe + snapshot hot path."""
    from eden.api.middleware.latency import (
        LatencyHistogram,
        get_metrics_snapshot,
        reset_metrics_snapshot,
    )

    h = LatencyHistogram()
    # Pre-populate a few routes so the snapshot path has work to do.
    for route in ("/v1/jobs", "/v1/environments", "/v1/benchmarks"):
        for _ in range(50):
            h.observe("GET", route, 200, 12.0)

    async def one():
        h.observe("GET", "/v1/jobs", 200, 5.0)
        h.observe("POST", "/v1/environments", 200, 23.0)
        h.observe("GET", "/health", 200, 1.5)
        snap = get_metrics_snapshot()
        # Touch the snapshot to ensure it's not optimised away.
        _ = len(snap["rows"])

    return await bench_async("latency_observe_snapshot", one, n=n)


async def _bench_latency_middleware(n: int = 1000) -> BenchResult:
    """End-to-end LatencyMiddleware dispatch (pure ASGI as of v1.9).

    Targets the ASGI ``__call__`` hot path, not just the histogram
    primitives. This is the cost every authenticated request pays.
    """
    from eden.api.middleware.latency import LatencyMiddleware, reset_metrics_snapshot
    reset_metrics_snapshot()

    mw = LatencyMiddleware(_noop_app)
    scope_auth = _build_scope("/v1/jobs")

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def one():
        sent: list[dict] = []
        async def send(msg):
            sent.append(msg)
        await mw(scope_auth, receive, send)

    return await bench_async("latency_middleware_dispatch", one, n=n)


async def _bench_api_version_dispatch(n: int = 1000) -> BenchResult:
    """APIVersionMiddleware dispatch (pure ASGI as of v2.0).

    Bench a ``/v1/<path>`` request — the common case. The middleware
    walks ``scope["headers"]`` for ``X-API-Version``, resolves to
    ``CURRENT_VERSION``, and injects the response header in the
    send-wrapper. Pre-fix this was on ``BaseHTTPMiddleware`` paying
    ~150µs per request.
    """
    from eden.api.middleware.api_version import APIVersionMiddleware, _VERSION_HEADER_BYTES
    mw = APIVersionMiddleware(_noop_app)
    scope = _build_scope(
        "/v1/whatever",
        headers=[(b"host", b"test"), (_VERSION_HEADER_BYTES, b"2025-05-30")],
    )

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def one():
        sent: list[dict] = []
        async def send(msg):
            sent.append(msg)
        await mw(scope, receive, send)

    return await bench_async("api_version_dispatch", one, n=n)


async def _bench_internal_only_health(n: int = 1000) -> BenchResult:
    """InternalOnlyMiddleware dispatch on a non-health ``/v1/*`` path.

    The benchmark uses a non-gated path so the middleware short-circuits
    without doing any work (the common case — most ``/v1/*`` paths
    bypass the internal health gate entirely).
    """
    from eden.api.middleware.internal_only import InternalOnlyMiddleware
    mw = InternalOnlyMiddleware(_noop_app)
    scope = _build_scope("/v1/regular", method="GET")

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def one():
        sent: list[dict] = []
        async def send(msg):
            sent.append(msg)
        await mw(scope, receive, send)

    return await bench_async("internal_only_dispatch", one, n=n)


async def _bench_tenant_rate_limit_health(n: int = 1000) -> BenchResult:
    """``/health`` short-circuit path through TenantRateLimitMiddleware.

    The ``/health`` endpoint is the single most-hit URL in the
    deployment (``healthcheck`` from every L7 load balancer,
    Kubernetes, etc.). On the old BaseHTTPMiddleware this paid
    ~150µs; on pure ASGI it's ~1µs.
    """
    import eden.storage.postgres as _pg
    async def _stub_pg():
        class _S:
            _pool = None
            async def get_org_resource_limits(self, oid): return None
            async def fetchrow(self, *a, **kw): return None
        return _S()
    # Pre-bind so the dispatch path doesn't re-stub on each call.
    _pg.get_postgres_client = _stub_pg
    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

    mw = TenantRateLimitMiddleware(_noop_app, default_limit=60, default_window=60)
    scope_health = _build_scope("/health")

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def one():
        sent: list[dict] = []
        async def send(msg):
            sent.append(msg)
        await mw(scope_health, receive, send)

    return await bench_async("trl_health_shortcut", one, n=n)


async def _bench_correlation_id_middleware(n: int = 1000) -> BenchResult:
    """End-to-end CorrelationIdMiddleware dispatch (pure ASGI as of v1.9)."""
    from eden.api.middleware.correlation_id import CorrelationIdMiddleware
    mw = CorrelationIdMiddleware(_noop_app)
    scope_with_id = _build_scope(
        "/v1/jobs",
        headers=[(b"host", b"test"), (b"x-request-id", b"abc-123")],
    )

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def one():
        sent: list[dict] = []
        async def send(msg):
            sent.append(msg)
        await mw(scope_with_id, receive, send)

    return await bench_async("correlation_id_dispatch", one, n=n)


async def run(n: int = 1000) -> list[BenchResult]:
    """Dispatch every middleware for real and return the measurements.

    Split out of ``_main`` so ``bench.run_all`` can collect results instead of
    scraping stdout. Every entry here drives an actual middleware's
    ``dispatch``; there is no simulated latency in this suite.
    """
    return [
        await _bench_default_deny(n),
        await _bench_latency_observe(n),
        await _bench_latency_middleware(n),
        await _bench_correlation_id_middleware(n),
        await _bench_tenant_rate_limit_health(n),
        await _bench_api_version_dispatch(n),
        await _bench_internal_only_health(n),
    ]


async def _main():
    parser = argparse.ArgumentParser(description="Middleware hot-path bench")
    parser.add_argument("--n", type=int, default=1000)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    results = await run(args.n)
    if args.json:
        print(json.dumps([r.to_dict() for r in results], indent=2))
        return
    print(f"{'bench':<32} {'p50_us':>10} {'p95_us':>10} {'p99_us':>10} {'n':>6}")
    print("-" * 75)
    for r in results:
        print(
            f"{r.name:<32} "
            f"{r.p50_ms*1000:>10.2f} "
            f"{r.p95_ms*1000:>10.2f} "
            f"{r.p99_ms*1000:>10.2f} "
            f"{r.n:>6}"
        )


if __name__ == "__main__":
    asyncio.run(_main())
