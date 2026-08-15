"""Regression test — 2026-07-27 auth/RLS middleware ordering fix.

Starlette's ``Starlette.add_middleware()`` does
``self.user_middleware.insert(0, ...)``: the middleware registered
LAST (in source / call order) ends up FIRST in ``app.user_middleware``,
and Starlette's ``build_middleware_stack()`` wraps
``reversed(user_middleware)`` bottom-up, so ``user_middleware[0]``
becomes the OUTERMOST layer — the first one to run on request-in.
In other words: **execution order == the order requests actually
flow through the middleware on the way in**, and it is the REVERSE
of the ``add_middleware(...)`` call order in ``src/eden/api/app.py``.

Every ordering comment in ``app.py`` used to assume source order ==
execution order, which is wrong, and as a direct consequence
``RLSOrgContextMiddleware`` (which trusts an UNAUTHENTICATED
``X-Org-Id`` header/cookie to resolve an org and opens a Postgres
transaction against it) executed BEFORE
``DefaultDenyAuthMiddleware``'s 401 gate on every request.

This test asserts the real, empirically-observed execution order of
the actual ``eden.api.app.app`` instance so a future contributor who
"cleans up" the ``add_middleware`` call order back to looking
source-sequential re-introduces the bug loudly (a failing test),
not silently.
"""

from __future__ import annotations

import asyncio

import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from eden.api.app import app as real_app
from eden.api.middleware.default_deny import DefaultDenyAuthMiddleware
from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware


def _unwrap_cls(mw_cls):
    """``app.user_middleware[i].cls`` is sometimes a ``functools.partial``
    (for middlewares registered with kwargs, e.g. TenantRateLimitMiddleware).
    Unwrap to the underlying class either way.
    """
    return getattr(mw_cls, "cls", mw_cls)


def _middleware_class_order(app) -> list[str]:
    """Return middleware class names in the order Starlette will
    execute them on request-in: ``app.user_middleware[0]`` is
    outermost / first-to-run, so this is a plain left-to-right walk
    of the list — NOT the ``add_middleware`` source-call order.
    """
    return [_unwrap_cls(m.cls).__name__ for m in app.user_middleware]


# ---------------------------------------------------------------------------
# Part 1 — a tiny standalone probe proving the insert(0) reversal itself,
# independent of the real app, so this test doesn't rely solely on
# understanding app.py's plumbing.
# ---------------------------------------------------------------------------


def test_add_middleware_reverses_registration_order_probe():
    """Sanity probe: prove ``add_middleware`` execution order is the
    REVERSE of registration (source) order, using disposable dummy
    middlewares — independent of anything in ``eden.api``.
    """
    seen: list[str] = []

    def make_mw(name: str):
        class _MW:
            def __init__(self, app):
                self.app = app

            async def __call__(self, scope, receive, send):
                if scope["type"] != "http":
                    await self.app(scope, receive, send)
                    return
                seen.append(name)
                await self.app(scope, receive, send)

        _MW.__name__ = f"Probe_{name}"
        return _MW

    async def homepage(request):
        return PlainTextResponse("ok")

    probe_app = Starlette(routes=[Route("/", homepage)])
    registration_order = ["A", "B", "C", "D"]
    for name in registration_order:
        probe_app.add_middleware(make_mw(name))

    client = TestClient(probe_app)
    resp = client.get("/")
    assert resp.status_code == 200

    expected_execution_order = list(reversed(registration_order))
    assert seen == expected_execution_order, (
        f"add_middleware() reversal assumption broke: registered "
        f"{registration_order}, expected execution order "
        f"{expected_execution_order}, got {seen}. If Starlette's "
        f"internals changed, every ordering comment (and the fix) in "
        f"src/eden/api/app.py needs to be revisited."
    )


# ---------------------------------------------------------------------------
# Part 2 — the actual regression guard on eden.api.app.app.
# ---------------------------------------------------------------------------


def test_default_deny_executes_before_rls_org_context_on_real_app():
    """CRITICAL — DefaultDenyAuthMiddleware must EXECUTE (request-in)
    before RLSOrgContextMiddleware on the real app.

    Before the 2026-07-27 fix, RLSOrgContextMiddleware ran first: an
    unauthenticated caller could supply an ``X-Org-Id`` header and
    have RLSOrgContextMiddleware resolve an org and open a Postgres
    ``SET LOCAL app.current_org_id`` transaction against it — all
    before the 401 default-deny gate ever ran.

    ``app.user_middleware[0]`` is the outermost / first-to-execute
    middleware (see module docstring), so a LOWER index means EARLIER
    execution. This test fails if someone reorders the
    ``add_middleware`` calls back to the broken state (or otherwise
    flips these two relative to each other).
    """
    order = _middleware_class_order(real_app)

    assert "DefaultDenyAuthMiddleware" in order, (
        "DefaultDenyAuthMiddleware is not mounted on the app at all "
        "(default_deny_enabled must be True by default)."
    )
    assert "RLSOrgContextMiddleware" in order, (
        "RLSOrgContextMiddleware is not mounted on the app at all "
        "(rls_org_context_enabled must be True by default)."
    )

    deny_index = order.index("DefaultDenyAuthMiddleware")
    rls_index = order.index("RLSOrgContextMiddleware")

    assert deny_index < rls_index, (
        "REGRESSION: DefaultDenyAuthMiddleware must execute BEFORE "
        "RLSOrgContextMiddleware (lower index == earlier execution in "
        "app.user_middleware), but got DefaultDenyAuthMiddleware at "
        f"index {deny_index} and RLSOrgContextMiddleware at index "
        f"{rls_index} — full order: {order}. Someone moved the "
        "add_middleware(DefaultDenyAuthMiddleware) call back to before "
        "add_middleware(RLSOrgContextMiddleware) in src/eden/api/app.py "
        "(remember: add_middleware() reverses source order into "
        "execution order, so 'DefaultDeny executes first' requires its "
        "add_middleware call to be registered AFTER RLSOrgContext's in "
        "source)."
    )


def test_full_real_app_execution_order_matches_documented_chain():
    """Belt-and-braces: assert the complete documented real execution
    order for the middlewares app.py explicitly reasons about, not
    just the two involved in the CRITICAL fix. Guards against a
    reorder that fixes DefaultDeny/RLS but silently breaks e.g.
    TenantRateLimit-vs-CORS or Latency-vs-DefaultDeny.
    """
    order = _middleware_class_order(real_app)

    expected_relevant_order = [
        "SecurityHeadersMiddleware",
        # CORS must run OUTSIDE every middleware that can short-circuit
        # a request, so that 401 (DefaultDenyAuth), 429 (TenantRateLimit,
        # Quota), 403 (InternalOnly) and 400 (Idempotency) responses
        # carry Access-Control-Allow-Origin and are therefore readable by
        # the browser. It was previously registered first, making it the
        # INNERMOST middleware, so only router-produced responses were
        # readable and the portal saw a generic network error instead of
        # the error envelope.
        #
        # It stays INSIDE SecurityHeaders: CORS answers preflight OPTIONS
        # itself without calling downstream, so putting it outermost
        # would strip the OWASP headers off every preflight response.
        "CORSMiddleware",
        "APIVersionMiddleware",
        "CorrelationIdMiddleware",
        "LatencyMiddleware",
        "GZipMiddleware",
        "TenantRateLimitMiddleware",
        "DefaultDenyAuthMiddleware",
        "RLSOrgContextMiddleware",
        "InternalOnlyMiddleware",
        "IdempotencyMiddleware",
        "QuotaEnforcementMiddleware",
    ]

    # Filter the real order down to just the classes we have opinions
    # about (some are settings-gated and may be absent in a given
    # environment; the assert above already guards the two CRITICAL
    # ones being present).
    relevant_present = [name for name in order if name in expected_relevant_order]

    assert relevant_present == expected_relevant_order, (
        "Real execution order of eden.api.app.app diverges from the "
        "documented chain in src/eden/api/app.py.\n"
        f"  expected: {expected_relevant_order}\n"
        f"  actual:   {relevant_present}\n"
        f"  full app.user_middleware order: {order}\n"
        "If this divergence is intentional, update BOTH this test and "
        "the 'Full REAL execution order' comment above "
        "app.add_middleware(SecurityHeadersMiddleware) in app.py."
    )


def test_default_deny_and_rls_are_pure_asgi_and_reachable_directly():
    """Cross-check the two middlewares in isolation (no TestClient
    against the full app, which needs DB/Redis) so the ordering
    finding is not solely an artifact of introspecting
    ``app.user_middleware`` — build a 2-layer chain matching the
    fixed source order and confirm DefaultDeny's 401 short-circuits
    before RLSOrgContext's ``__call__`` ever runs for an
    unauthenticated request carrying a spoofed ``X-Org-Id``.
    """
    calls: list[str] = []

    class _RecordingRLS(RLSOrgContextMiddleware):
        async def __call__(self, scope, receive, send):
            calls.append("RLSOrgContext")
            await super().__call__(scope, receive, send)

    class _RecordingDeny(DefaultDenyAuthMiddleware):
        async def __call__(self, scope, receive, send):
            calls.append("DefaultDenyAuth")
            await super().__call__(scope, receive, send)

    async def inner(scope, receive, send):
        calls.append("route")
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    # Build the chain in the FIXED source order: RLS registered first,
    # DefaultDeny registered second — so DefaultDeny (outer) wraps RLS
    # (inner), matching what app.add_middleware(...) now produces.
    rls_layer = _RecordingRLS(inner)
    deny_layer = _RecordingDeny(rls_layer)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/orgs/some-org/secret",
        "raw_path": b"/orgs/some-org/secret",
        "query_string": b"",
        # Spoofed, UNAUTHENTICATED org header — no cookie, no bearer,
        # no API key. This is exactly the exploit shape from the bug
        # report: an anonymous caller claiming an org via X-Org-Id.
        "headers": [(b"host", b"test"), (b"x-org-id", b"org_evil")],
        "client": ("203.0.113.5", 51234),
        "server": ("testserver", 80),
        "root_path": "",
        "path_params": {},
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    sent: list[dict] = []

    async def send(msg):
        sent.append(msg)

    asyncio.run(deny_layer(scope, receive, send))

    # DefaultDeny must run, reject with 401, and RLSOrgContext / the
    # route must NEVER be reached for this unauthenticated request.
    assert calls == ["DefaultDenyAuth"], (
        f"Expected only DefaultDenyAuth to run for an unauthenticated "
        f"request with a spoofed X-Org-Id header, got call order "
        f"{calls}. RLSOrgContextMiddleware must not execute (and must "
        f"not open a Postgres transaction) before the 401 auth gate."
    )
    starts = [m for m in sent if m["type"] == "http.response.start"]
    assert starts and starts[0]["status"] == 401, (
        f"Expected a 401 from DefaultDenyAuthMiddleware, got {starts}"
    )
