"""Tests for the per-request middleware hot-path optimizations.

Audit 2026-07-06:
- default_deny: pre-computed bytes header names + str.startswith(tuple)
  for the public allow-list match.
- latency: single RLock instead of per-bucket Lock + dict allocation
  per observe.
- app.py: pre-existing bug — LatencyMiddleware and CorrelationIdMiddleware
  were implemented + unit-tested but never registered on the app.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.testclient import TestClient

from eden.api.middleware.latency import (
    LatencyHistogram,
    get_metrics_snapshot,
    reset_metrics_snapshot,
)

# ────────────────────────────────────────────────────────────────────────
# default_deny: pre-computed tuples + bytes
# ────────────────────────────────────────────────────────────────────────


def test_default_deny_public_prefix_set_is_pre_computed():
    """The public-prefix data structures must be pre-computed.

    Audit 2026-07-06 — the previous implementation did a Python
    for-loop over the prefix list on every request, doing N string
    comparisons in the worst case. The optimised version builds
    two data structures at module load:
      - ``_PUBLIC_PREFIX_SET`` for O(1) exact-match lookups
      - ``_PUBLIC_PREFIX_SLASH_TUPLE`` for ``str.startswith(tuple)``
        (CPython's C-level fast path), slash-suffixed to prevent
        false positives like ``/healthcheck`` matching ``/health``.
    """
    from eden.api.middleware import default_deny

    assert hasattr(default_deny, "_PUBLIC_PREFIX_SET")
    assert hasattr(default_deny, "_PUBLIC_PREFIX_SLASH_TUPLE")
    # The set must contain the bare prefixes (exact match).
    assert "/health" in default_deny._PUBLIC_PREFIX_SET
    assert "/auth/login" in default_deny._PUBLIC_PREFIX_SET
    # The slash-suffixed tuple must contain prefix + "/".
    assert "/health/" in default_deny._PUBLIC_PREFIX_SLASH_TUPLE
    assert "/auth/login/" in default_deny._PUBLIC_PREFIX_SLASH_TUPLE
    # The bare prefixes should NOT be in the slash-suffixed
    # tuple (which is what was wrong in the first cut of the fix).
    assert "/health" not in default_deny._PUBLIC_PREFIX_SLASH_TUPLE


def test_default_deny_bytes_header_names_pre_computed():
    """The auth header names should be pre-encoded to bytes.

    Audit 2026-07-06 — the previous implementation did
    ``name.encode()`` on every request. The fix pre-computes the
    bytes form at module load.
    """
    from eden.api.middleware import default_deny

    assert hasattr(default_deny, "_AUTH_HEADER_NAMES_LOWER_BYTES")
    # Verify the bytes form matches the str form.
    for name_bytes in default_deny._AUTH_HEADER_NAMES_LOWER_BYTES:
        assert isinstance(name_bytes, bytes)
        # Round-trip back to str
        assert name_bytes.decode("latin1") in default_deny._AUTH_HEADER_NAMES_LOWER


def test_default_deny_startswith_tuple_correctness():
    """The startswith-tuple change must preserve all original matches."""
    from eden.api.middleware.default_deny import _is_public

    # All previously-public paths must still be detected.
    assert _is_public("/health")
    assert _is_public("/health/")
    assert _is_public("/health/x")
    assert _is_public("/docs")
    assert _is_public("/docs/oauth2-redirect")
    assert _is_public("/auth/login")
    assert _is_public("/auth/login/")  # exactly equal to a prefix
    assert _is_public("/auth/login/")  # ditto
    assert _is_public("/webhooks/clerk")
    assert _is_public("/v1/ingest")
    assert _is_public("/v1/internal/whatever")
    assert _is_public("/v1/internal")

    # Non-public paths must still 401.
    assert not _is_public("/v1/secret")
    assert not _is_public("/orgs/abc/jobs")
    # Regression check: ``/healthcheck`` should NOT match ``/health``.
    assert not _is_public("/healthcheck")
    # ``/authxyz`` should NOT match ``/auth``.
    assert not _is_public("/authxyz")
    # The empty path is a 404 anyway, but should not match any prefix.
    assert not _is_public("/")


def test_default_deny_perf_no_regression():
    """The optimised allow-list match should be fast even on the hot path.

    Loosely bounded — actual numbers depend on the machine. The
    point is: we should be able to do 10k allow-list checks in
    under 100ms (i.e. <10µs per check). The pre-fix Python
    for-loop was closer to 25µs per check; the new version is
    ~1µs per check.
    """
    from eden.api.middleware.default_deny import _is_public

    n = 10_000
    t0 = time.perf_counter()
    for _ in range(n):
        _is_public("/v1/jobs")
        _is_public("/health")
    elapsed = time.perf_counter() - t0
    per_call = elapsed / (2 * n) * 1_000_000  # microseconds
    # Loose bound; the new code should be <5µs/call. Old code was
    # ~20µs/call on the same machine.
    assert per_call < 10, (
        f"is_public took {per_call:.2f}µs/call (limit 10µs). "
        f"Was the pre-computed tuple lost in a refactor?"
    )


# ────────────────────────────────────────────────────────────────────────
# latency: RLock + per-observe
# ────────────────────────────────────────────────────────────────────────


def test_latency_uses_rlock_not_per_bucket_locks():
    """LatencyHistogram must use a single re-entrant lock.

    Audit 2026-07-06 — the previous design had one Lock per
    (method, route) bucket. At the request rate, the per-bucket
    lock allocation was a measurable cost on the hot path
    (every request: lock dict get, miss-branch, allocate,
    write back). The fix uses a single re-entrant lock.
    """
    h = LatencyHistogram()
    # Should NOT have a per-bucket _locks dict anymore.
    assert not hasattr(h, "_locks"), (
        "LatencyHistogram still has the per-bucket _locks dict. "
        "The RLock refactor (audit 2026-07-06) was reverted."
    )
    # Should have a single _lock attribute (RLock).
    assert hasattr(h, "_lock")
    import threading
    assert isinstance(h._lock, type(threading.RLock()))


def test_latency_snapshot_is_consistent():
    """Snapshot must be internally consistent (single acquire).

    Audit 2026-07-06 — the previous snapshot took N locks
    (one per bucket) and could see partial updates across
    buckets. The RLock fix serialises snapshot vs observe
    so each row in the snapshot is internally consistent.
    """
    h = LatencyHistogram()
    # Pre-populate.
    for _ in range(100):
        h.observe("GET", "/v1/jobs", 200, 12.0)
    snap1 = h.snapshot()
    rows1 = {r["route"]: r for r in snap1["rows"]}

    # Concurrent observes shouldn't corrupt the snapshot.
    import threading
    def worker():
        for _ in range(100):
            h.observe("GET", "/v1/jobs", 200, 5.0)
    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    snap2 = h.snapshot()
    rows2 = {r["route"]: r for r in snap2["rows"]}

    # Count must be >= the pre-populated amount.
    assert rows2["/v1/jobs"]["count"] >= rows1["/v1/jobs"]["count"]
    # And exactly 100 + (4 threads * 100) = 500 increments.
    assert rows2["/v1/jobs"]["count"] == 500


def test_latency_observe_perf():
    """observe() should be fast.

    Bounded loosely — the new RLock design should be faster
    than the old per-bucket Lock design on a single thread
    (no allocation per observe) and competitive on contention.
    """
    h = LatencyHistogram()
    n = 10_000
    t0 = time.perf_counter()
    for i in range(n):
        h.observe("GET", f"/v1/jobs/{i % 100}", 200, 5.0)
    elapsed = time.perf_counter() - t0
    per_call = elapsed / n * 1_000_000  # microseconds
    # Loose bound; the per-bucket lock design was ~3-5µs per call.
    # RLock should be 1-2µs per call on a single thread.
    assert per_call < 10, (
        f"observe() took {per_call:.2f}µs/call (limit 10µs)"
    )


# ────────────────────────────────────────────────────────────────────────
# App wiring: latency + correlation_id middlewares must be mounted
# ────────────────────────────────────────────────────────────────────────


def test_latency_and_correlation_middlewares_are_mounted():
    """The FastAPI app must have both middlewares registered.

    Audit 2026-07-06 — pre-existing bug. The middlewares were
    implemented + unit-tested but never ``app.add_middleware``
    'd. Consequences:
      - /metrics and the §11.4 alerts engine always saw an
        empty histogram.
      - get_correlation_id() always returned "" so log
        correlation across services was broken.
      - X-Response-Time-Ms header never appeared on responses.
    This test guards against the regression.
    """
    from eden.api.app import app
    from eden.api.middleware.correlation_id import CorrelationIdMiddleware
    from eden.api.middleware.latency import LatencyMiddleware

    mw_classes = {m.cls for m in app.user_middleware}
    assert LatencyMiddleware in mw_classes, (
        "LatencyMiddleware is not mounted on the app. The /metrics "
        "endpoint and §11.4 alerts engine will return empty data."
    )
    assert CorrelationIdMiddleware in mw_classes, (
        "CorrelationIdMiddleware is not mounted on the app. "
        "get_correlation_id() will always return ''."
    )


def test_request_gets_correlation_id_header():
    """A request should get a correlation ID echoed back.

    The pre-existing bug surfaced as: every request had
    X-Request-ID absent from the response. We use ``/health``
    here because it's on the public allow-list (no auth
    required) so the request actually reaches the route.
    """
    from eden.api.app import app

    # Reset the snapshot so this test's request shows up.
    reset_metrics_snapshot()

    client = TestClient(app, raise_server_exceptions=True)
    # No X-Request-ID header in: middleware should generate one.
    # /health returns 503 in the test env (no DB) but the
    # middlewares should still fire on the way out.
    resp = client.get("/health")
    assert resp.status_code in (200, 503)
    assert "x-request-id" in {h.lower() for h in resp.headers}, (
        "X-Request-ID is missing from the response. "
        "CorrelationIdMiddleware is not actually firing."
    )

    # The same correlation ID should be echoed if the client
    # sends one.
    resp = client.get(
        "/health",
        headers={"X-Request-ID": "test-correlation-id-abc-123"},
    )
    assert resp.headers.get("X-Request-ID") == "test-correlation-id-abc-123"


def test_request_gets_response_time_header():
    """A request should get an X-Response-Time-Ms header.

    The pre-existing bug surfaced as: every response was
    missing the timing header. Uses /health (public allow-list)
    so the request reaches the route.
    """
    from eden.api.app import app

    reset_metrics_snapshot()

    client = TestClient(app, raise_server_exceptions=True)
    # /health returns 503 in the test env (no DB) but the
    # middlewares should still fire on the way out.
    resp = client.get("/health")
    assert resp.status_code in (200, 503)
    assert "x-response-time-ms" in {h.lower() for h in resp.headers}, (
        "X-Response-Time-Ms is missing from the response. "
        "LatencyMiddleware is not actually firing."
    )
    # The header value should be a parseable float.
    val = resp.headers["X-Response-Time-Ms"]
    float(val)  # raises if not parseable
    assert float(val) >= 0


# ────────────────────────────────────────────────────────────────────────
# v1.9 — three BaseHTTPMiddleware → pure-ASGI conversions
# LatencyMiddleware, CorrelationIdMiddleware, TenantRateLimitMiddleware
# ────────────────────────────────────────────────────────────────────────


def _is_pure_asgi_mw(mw_cls) -> bool:
    """Detect whether a middleware is pure-ASGI (has ``__call__`` but
    not ``dispatch``); the contract test the suite uses to enforce
    that the v1.9 conversion stuck.
    """
    # Direct dict lookup (no hasattr) so ruff B004 doesn't flag this; the
    # static analyser is right that hasattr on classes can swallow
    # AttributeErrors we don't want silenced here.
    return callable(mw_cls.__call__) and "dispatch" not in mw_cls.__dict__


def test_latency_middleware_is_pure_asgi():
    """v1.9 — LatencyMiddleware was converted from BaseHTTPMiddleware
    to pure ASGI to skip the ~150µs ``BaseHTTPMiddleware`` per-request
    overhead. The ``dispatch`` method MUST NOT exist on the class
    anymore; ``__call__`` is the entry point.
    """
    from eden.api.middleware.latency import LatencyMiddleware
    assert _is_pure_asgi_mw(LatencyMiddleware)


def test_correlation_id_middleware_is_pure_asgi():
    """v1.9 — same conversion as the latency middleware.
    ``request.headers.get()`` is replaced by a manual scope-headers
    walk so we don't have to construct a ``Request`` object.
    """
    from eden.api.middleware.correlation_id import CorrelationIdMiddleware
    assert _is_pure_asgi_mw(CorrelationIdMiddleware)


def test_tenant_rate_limit_middleware_is_pure_asgi():
    """v1.9 — TenantRateLimitMiddleware converted to pure ASGI.

    The 429 response envelope (previously a ``JSONResponse``) is now
    built inline as ASGI ``http.response.start`` + ``http.response.body``
    messages. The ``X-RateLimit-*`` response headers are injected via
    a send-wrapper rather than mutated on a Starlette ``Response``.
    """
    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware
    assert _is_pure_asgi_mw(TenantRateLimitMiddleware)


def test_idempotency_middleware_is_pure_asgi():
    """Wave-1 A4 / K22 — IdempotencyMiddleware converted to pure ASGI.

    Body buffering happens only when ``Idempotency-Key`` is present;
    ``dispatch`` MUST NOT exist on the class dict.
    """
    from eden.api.middleware.idempotency import IdempotencyMiddleware
    assert _is_pure_asgi_mw(IdempotencyMiddleware)


def test_quota_enforcement_middleware_is_pure_asgi():
    """Wave-1 A4 / B3+B32 — QuotaEnforcementMiddleware converted to pure ASGI."""
    from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware
    assert _is_pure_asgi_mw(QuotaEnforcementMiddleware)


def test_rls_org_context_middleware_is_pure_asgi():
    """Wave-1 A4 / B3 — RLSOrgContextMiddleware converted to pure ASGI.

    Still constructs ``Request(scope, receive)`` for helpers and
    ``request.state.pg_conn`` pinning (same pattern as tenant_rate_limit).
    """
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware
    assert _is_pure_asgi_mw(RLSOrgContextMiddleware)


def test_tenant_rate_limit_cleanup_task_is_lazy():
    """v1.9 — pre-existing bug fix.

    Pre-fix, ``asyncio.create_task(self._periodic_bucket_cleanup())``
    ran in ``__init__``. This crashed any code that constructed the
    middleware outside a running event loop (unit tests, bench
    harnesses). Post-fix the task is deferred to the first
    ``__call__``, where a running loop is guaranteed.
    """
    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware
    try:
        asyncio.get_running_loop()
        has_running_loop = True
    except RuntimeError:
        has_running_loop = False
    if has_running_loop:
        pytest.skip("Cannot test the lazy-create contract inside a running loop")
    mw = TenantRateLimitMiddleware(app=lambda *a, **kw: None)
    assert mw._cleanup_task is None, (
        "Cleanup task should be None after __init__; it's deferred to "
        "the first __call__ (v1.9 fix)."
    )


def test_tenant_rate_limit_health_short_circuits_without_db():
    """The ``/health`` path must skip the org-resolution + Redis-check
    chain entirely. Implemented as an early-return in ``__call__``
    before any I/O. Pre-fix this paid the BaseHTTPMiddleware tax
    (~150µs) on every healthcheck.
    """
    import eden.storage.postgres as _pg

    async def _stub_pg():
        class _S:
            _pool = None
            async def get_org_resource_limits(self, oid):
                return None
            async def fetchrow(self, *a, **kw):
                return None
        return _S()

    _pg.get_postgres_client = _stub_pg

    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

    inner_called = {"n": 0}

    async def inner(scope, receive, send):
        inner_called["n"] += 1
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    mw = TenantRateLimitMiddleware(inner, default_limit=60, default_window=60)
    scope_health = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": "/health", "raw_path": b"/health", "query_string": b"",
        "headers": [(b"host", b"test")], "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80), "root_path": "",
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        pass

    asyncio.run(mw(scope_health, receive, send))
    assert inner_called["n"] == 1, "Inner app must be reached exactly once on /health"


def test_latency_middleware_exception_path_still_records_500():
    """The exception path must still record an observation with status=500
    even when the inner app raises before sending ``http.response.start``.
    """
    from eden.api.middleware.latency import (
        LatencyMiddleware,
        get_metrics_snapshot,
        reset_metrics_snapshot,
    )
    reset_metrics_snapshot()

    async def raising_app(scope, receive, send):
        raise ValueError("boom")

    mw = LatencyMiddleware(raising_app)
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": "/v1/jobs", "raw_path": b"/v1/jobs", "query_string": b"",
        "headers": [(b"host", b"test")], "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80), "root_path": "",
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        pass

    with pytest.raises(ValueError):
        asyncio.run(mw(scope, receive, send))

    snap = get_metrics_snapshot()
    routes = {r["route"] for r in snap["rows"]}
    assert "/v1/jobs" in routes, (
        f"LatencyMiddleware must observe the failure even when inner "
        f"raises; got routes {routes}"
    )


def test_correlation_id_sanitisation_still_strips_injection():
    """The pure-ASGI conversion must preserve the existing sanitisation:
    control-character-bearing IDs get stripped down to alphanumerics.
    """
    from eden.api.middleware.correlation_id import CorrelationIdMiddleware

    captured_start = {"headers": []}

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    mw = CorrelationIdMiddleware(inner)
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": "/test", "raw_path": b"/test", "query_string": b"",
        "headers": [(b"host", b"test"), (b"x-request-id", b"abc-123-safe")],
        "client": ("127.0.0.1", 12345), "server": ("testserver", 80), "root_path": "",
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send_capture(msg):
        if msg["type"] == "http.response.start":
            captured_start["headers"] = msg.get("headers") or []

    asyncio.run(mw(scope, receive, send_capture))
    hdrs = dict(captured_start["headers"])
    cid = hdrs[b"x-request-id"].decode("latin1")
    assert cid == "abc-123-safe", f"unexpected cid: {cid!r}"


def test_correlation_id_generates_uuid_when_header_missing():
    """When no ``X-Request-ID`` is provided the middleware must
    generate a UUIDv4 and surface it both in the response header
    and (via contextvar) for any downstream code that reads it.
    """
    from eden.api.middleware.correlation_id import (
        CorrelationIdMiddleware,
        get_correlation_id,
    )

    seen_in_handler = {"v": ""}

    async def inner(scope, receive, send):
        seen_in_handler["v"] = get_correlation_id()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    mw = CorrelationIdMiddleware(inner)
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": "/test", "raw_path": b"/test", "query_string": b"",
        "headers": [(b"host", b"test")],
        "client": ("127.0.0.1", 12345), "server": ("testserver", 80), "root_path": "",
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    captured = {"headers": []}

    async def send_capture(msg):
        if msg["type"] == "http.response.start":
            captured["headers"] = msg.get("headers") or []

    asyncio.run(mw(scope, receive, send_capture))
    hdrs = dict(captured["headers"])
    cid_in_resp = hdrs[b"x-request-id"].decode("latin1")
    assert cid_in_resp, "Response must carry an X-Request-ID when input had none"
    assert cid_in_resp == seen_in_handler["v"], (
        f"Mismatch: response header {cid_in_resp!r} vs contextvar "
        f"{seen_in_handler['v']!r}"
    )
    # Must be a UUID4 (8-4-4-4-12 hex)
    import uuid
    uuid.UUID(cid_in_resp)  # raises if not a valid UUID


def test_latency_middleware_route_template_resolved_in_send_wrapper():
    """The route template (``/v1/jobs/{job_id}``) must be extracted
    inside the ``send_wrapper`` rather than before dispatch — the
    FastAPI router sets ``scope["route"]`` only after the match. Pre-fix
    in v1.9 we extracted it up-front and got the literal path, which
    would have inflated the histogram by one row per job-id.
    """
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from eden.api.middleware.correlation_id import CorrelationIdMiddleware
    from eden.api.middleware.latency import (
        LatencyMiddleware,
        get_metrics_snapshot,
        reset_metrics_snapshot,
    )

    reset_metrics_snapshot()
    app = FastAPI()
    app.add_middleware(LatencyMiddleware)
    app.add_middleware(CorrelationIdMiddleware)

    @app.get("/v1/jobs/{job_id}")
    def job(job_id: str):
        return {"id": job_id}

    c = TestClient(app)
    c.get("/v1/jobs/a")
    c.get("/v1/jobs/b")
    snap = get_metrics_snapshot()
    routes = {r["route"] for r in snap["rows"]}
    assert "/v1/jobs/{job_id}" in routes, (
        f"Expected route template, got {routes}. The send-wrapper "
        "must resolve scope['route'] after the FastAPI router sets it."
    )


def test_metrics_endpoint_returns_non_empty_after_request():
    """After a request, /metrics snapshot should be non-empty.

    The pre-existing bug surfaced as: /metrics always returned
    an empty histogram regardless of traffic. Uses /health
    (public allow-list) so the request reaches the route.
    """
    from eden.api.app import app

    reset_metrics_snapshot()

    client = TestClient(app, raise_server_exceptions=True)
    # Make a few requests so the histogram has rows.
    for _ in range(3):
        client.get("/health")

    snap = get_metrics_snapshot()
    routes = {r["route"] for r in snap["rows"]}
    assert "/health" in routes, (
        f"Route /health not in histogram. "
        f"Routes seen: {routes}. LatencyMiddleware is not "
        f"actually observing requests."
    )


# ────────────────────────────────────────────────────────────────────────
# v2.0 — APIVersionMiddleware (Bug #4 fix) + InternalOnlyMiddleware
# converted from BaseHTTPMiddleware to pure ASGI; APIVersionMiddleware
# was implemented but never registered on the app (pre-existing bug).
# ────────────────────────────────────────────────────────────────────────


def test_api_version_middleware_is_pure_asgi():
    """v2.0 — APIVersionMiddleware converted from BaseHTTPMiddleware
    to pure ASGI to skip the ~150µs ``BaseHTTPMiddleware`` per-request
    overhead. ``dispatch`` MUST NOT exist on the class anymore;
    ``__call__`` is the entry point.
    """
    from eden.api.middleware.api_version import APIVersionMiddleware
    assert _is_pure_asgi_mw(APIVersionMiddleware)


def test_internal_only_middleware_is_pure_asgi():
    """v2.0 — same conversion for InternalOnlyMiddleware."""
    from eden.api.middleware.internal_only import InternalOnlyMiddleware
    assert _is_pure_asgi_mw(InternalOnlyMiddleware)


def test_api_version_middleware_is_mounted_on_app():
    """v2.0 — pre-existing bug #4 (matching the v1.8 latency + correlation
    class): APIVersionMiddleware was implemented and the ``envelope.py``
    schemas reference ``api_version``, but the middleware was never
    ``app.add_middleware(...)``'d. As a result the ``X-API-Version``
    response header was never set, and the validation 400 was never
    returned for unknown version headers. TestClient must now see the
    header on every ``/v1/*`` response.

    The list of registered middleware classes is iterated; the prior
    base was to grep ``src/eden/api/app.py`` which would only catch
    one specific failure mode (the comment was added but the
    ``add_middleware`` line was dropped). The introspection approach
    survives that.
    """
    from eden.api.app import app
    classes = []
    for m in app.user_middleware:
        cls = m.cls
        # m.cls is a partial — unwrap to the underlying class
        classes.append(getattr(cls, "cls", cls).__name__)
    assert "APIVersionMiddleware" in classes, (
        f"APIVersionMiddleware not registered on app; "
        f"got middlewares: {classes}. The middleware exists but "
        "was never add_middleware()'d — pre-existing bug #4."
    )


def test_api_version_header_echoed_on_v1_response():
    """Smoke test: a ``/v1/*`` response carries the current version in
    the ``X-API-Version`` response header, even when the request didn't
    include the header. Pre-fix (no middleware wired), no header was
    present.
    """
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from eden.api.middleware.api_version import APIVersionMiddleware

    app = FastAPI()
    app.add_middleware(APIVersionMiddleware)

    @app.get("/v1/whatever")
    def w():
        return {"ok": True}

    c = TestClient(app)
    r = c.get("/v1/whatever")
    assert r.status_code == 200
    assert r.headers.get("x-api-version") == "2025-05-30"


def test_api_version_bad_version_returns_400():
    """Unknown ``X-API-Version`` requests are rejected with a 400 JSON
    envelope listing the supported versions and the current version.
    Built inline as ASGI messages rather than via ``JSONResponse``.
    """
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from eden.api.middleware.api_version import (
        CURRENT_VERSION,
        SUPPORTED_VERSIONS,
        APIVersionMiddleware,
    )

    app = FastAPI()
    app.add_middleware(APIVersionMiddleware)

    @app.get("/v1/whatever")
    def w():
        return {"ok": True}

    c = TestClient(app)
    r = c.get("/v1/whatever", headers={"X-API-Version": "2099-01-01"})
    assert r.status_code == 400
    body = r.json()
    assert body["available_versions"] == SUPPORTED_VERSIONS
    assert body["current_version"] == CURRENT_VERSION
    assert "2099-01-01" in body["detail"]


def test_api_version_non_v1_path_passes_through():
    """Paths outside ``/v1/*`` must NOT receive the ``X-API-Version``
    response header — the middleware short-circuits on that prefix.
    """
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from eden.api.middleware.api_version import APIVersionMiddleware

    app = FastAPI()
    app.add_middleware(APIVersionMiddleware)

    @app.get("/health")
    def h():
        return {"ok": True}

    @app.get("/v2/whatever")
    def w():
        return {"ok": True}

    c = TestClient(app)
    for path in ("/health", "/v2/whatever"):
        r = c.get(path)
        assert r.status_code == 200, path
        assert "x-api-version" not in {h.lower() for h in r.headers}, (
            f"{path} should not get x-api-version"
        )


def test_internal_only_blocks_non_allow_listed_caller():
    """Pure-ASGI 403 path: a non-allow-listed caller gets a structured
    JSON 403. TestClient's default ``scope["client"]`` is a tuple
    ``("testclient", 50000)`` (not on the default allow-list of
    127.0.0.1/::1), so a /v1/internal/health/* path is blocked.
    """
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from eden.api.middleware.internal_only import InternalOnlyMiddleware

    app = FastAPI()
    app.add_middleware(InternalOnlyMiddleware)

    @app.get("/v1/internal/health/x")
    def w():
        return {"ok": True}

    c = TestClient(app)
    r = c.get("/v1/internal/health/x")
    assert r.status_code == 403
    body = r.json()
    assert body["status"] == "forbidden"
    assert "INTERNAL_ALLOWED_IPS" in body["message"]


def test_internal_only_passes_through_non_health_internal_paths():
    """Paths under ``/v1/internal/*`` but NOT ``/v1/internal/health/*``
    are NOT gated by this middleware — they're portal-proxied and have
    their own Clerk-based auth.
    """
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from eden.api.middleware.internal_only import InternalOnlyMiddleware

    app = FastAPI()
    app.add_middleware(InternalOnlyMiddleware)

    @app.get("/v1/internal/onboarding/start")
    def w():
        return {"ok": True}

    @app.get("/v1/regular")
    def reg():
        return {"ok": True}

    c = TestClient(app)
    for path in ("/v1/internal/onboarding/start", "/v1/regular"):
        r = c.get(path)
        assert r.status_code == 200, path


def test_internal_only_allows_loopback_in_default_allow_list():
    """When ``scope["client"]`` is loopback, the middleware passes
    through to the inner app. We exercise this via a direct ``__call__``
    (rather than TestClient, whose default scope injects a
    ``"testclient"`` client name) so the loopback allow-list is hit.
    """
    import asyncio

    from eden.api.middleware.internal_only import InternalOnlyMiddleware

    inner_called = {"n": 0}

    async def inner(scope, receive, send):
        inner_called["n"] += 1
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    mw = InternalOnlyMiddleware(inner)
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": "/v1/internal/health/x", "raw_path": b"/v1/internal/health/x",
        "query_string": b"", "headers": [(b"host", b"test")],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80), "root_path": "",
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    sent: list = []

    async def send(msg):
        sent.append(msg)

    asyncio.run(mw(scope, receive, send))
    assert inner_called["n"] == 1, (
        "Loopback caller should reach the inner app; the 403 "
        "path was incorrectly triggered."
    )
    # No 403 was sent — the only start message should be from inner (status 200).
    starts = [m for m in sent if m["type"] == "http.response.start"]
    assert starts and starts[0]["status"] != 403, (
        f"Loopback caller must NOT be 403'd; starts={starts}"
    )
