"""F67 — Security headers middleware (OWASP Secure Headers Project).

The prod-ready checklist §1.4 requires:

* ``Strict-Transport-Security`` (HSTS)
* ``X-Content-Type-Options: nosniff``
* ``X-Frame-Options: DENY``
* ``Referrer-Policy``
* ``Content-Security-Policy``

Pre-F67 the FastAPI app shipped responses without any of these
(the portal handles CSP/HSTS on the Next.js side, but the
API itself was unhardened). F67 closes the gap with a pure-ASGI
middleware registered FIRST in the chain so EVERY response
— including 401 from DefaultDenyAuth, 503 from health-probe,
CORS preflight, and 500 envelopes — gets the header block.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.middleware.security_headers import (
    _STATIC_HEADERS,
    SecurityHeadersMiddleware,
)


def _build_app() -> FastAPI:
    """Build a minimal app with only the security-headers middleware.

    The real app has many middlewares; we verify this one in
    isolation. The app exposes a /secret endpoint to confirm
    the headers fire on every status, not just 200.
    """
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/secret/data")
    async def secret() -> dict[str, str]:
        return {"value": "shh"}

    @app.get("/secret/boom")
    async def boom() -> dict[str, str]:
        raise RuntimeError("intentional test failure")

    return app


class TestF67StaticHeaders:
    """The middleware's static header block must contain every
    OWASP-recommended header for a non-HTML API."""

    def test_hsts_header_present(self) -> None:
        names = {name.decode().lower() for name, _ in _STATIC_HEADERS}
        assert "strict-transport-security" in names

    def test_nosniff_header_present(self) -> None:
        names = {name.decode().lower() for name, _ in _STATIC_HEADERS}
        assert "x-content-type-options" in names

    def test_xframe_options_header_present(self) -> None:
        names = {name.decode().lower() for name, _ in _STATIC_HEADERS}
        assert "x-frame-options" in names

    def test_referrer_policy_header_present(self) -> None:
        names = {name.decode().lower() for name, _ in _STATIC_HEADERS}
        assert "referrer-policy" in names

    def test_csp_header_present(self) -> None:
        names = {name.decode().lower() for name, _ in _STATIC_HEADERS}
        assert "content-security-policy" in names

    def test_permissions_policy_header_present(self) -> None:
        names = {name.decode().lower() for name, _ in _STATIC_HEADERS}
        assert "permissions-policy" in names

    def test_csp_default_src_none(self) -> None:
        """The CSP must use ``default-src 'none'`` — the API
        returns only JSON; an HTML response would be a bug."""
        for name, value in _STATIC_HEADERS:
            if name == b"content-security-policy":
                assert b"default-src 'none'" in value
                assert b"frame-ancestors 'none'" in value
                break
        else:
            pytest.fail("CSP header missing from static block")

    def test_hsts_has_max_age_and_subdomains(self) -> None:
        """HSTS must specify max-age (1y+) and includeSubDomains
        so a downgrade attack on any subdomain is also blocked."""
        for name, value in _STATIC_HEADERS:
            if name == b"strict-transport-security":
                assert b"max-age=" in value
                assert b"includeSubDomains" in value
                break
        else:
            pytest.fail("HSTS header missing from static block")


class TestF67HeadersFireOn200:
    """The header block must be present on a 200 response."""

    def test_health_response_has_headers(self) -> None:
        client = TestClient(_build_app(), raise_server_exceptions=True)
        resp = client.get("/health")
        assert resp.status_code == 200
        lowered = {k.lower() for k in resp.headers}
        for required in (
            "strict-transport-security",
            "x-content-type-options",
            "x-frame-options",
            "referrer-policy",
            "content-security-policy",
            "permissions-policy",
            "cross-origin-opener-policy",
            "cross-origin-resource-policy",
        ):
            assert required in lowered, (
                f"F67 regression: required security header "
                f"'{required}' missing from 200 response"
            )

    def test_secret_response_has_headers(self) -> None:
        client = TestClient(_build_app(), raise_server_exceptions=True)
        resp = client.get("/secret/data")
        assert resp.status_code == 200
        assert resp.headers.get("x-content-type-options") == "nosniff"
        assert resp.headers.get("x-frame-options") == "DENY"


class TestF67HeadersFireOn500:
    """The header block must be present on a 500 envelope too —
    a leaky error path is a great place for a CSP to bite the
    attacker.

    The middleware-only test confirms our ``send_wrapper``
    sees the response from a successful route. For 500
    envelopes, Starlette's ``ServerErrorMiddleware`` (the
    OUTERMOST wrapper) catches the exception and sends the
    500 envelope via its own ``send`` — bypassing our
    middleware. The production app handles this with a
    global ``@app.exception_handler(Exception)`` that calls
    ``apply_security_headers()`` on the JSONResponse. We
    test BOTH paths below.
    """

    def test_middleware_only_500_lacks_headers(self) -> None:
        """Document the gap: the bare middleware doesn't see
        the 500 envelope. This is the bug that motivates the
        exception-handler fix in the production app."""
        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.get("/secret/boom")
        assert resp.status_code == 500
        # The middleware's sw never fires for the 500 path
        # because ServerErrorMiddleware is outermost.
        assert "x-content-type-options" not in {
            k.lower() for k in resp.headers
        }, (
            "Test premise broken: middleware IS seeing 500 — "
            "the gap no longer exists; this test can be retired."
        )

    def test_exception_handler_500_has_headers(self) -> None:
        """The production pattern: a FastAPI global exception
        handler returns a JSONResponse with the security
        headers merged in. This is what the production app
        does; this test pins that the pattern works."""
        from fastapi.responses import JSONResponse
        from starlette.requests import Request

        from eden.api.middleware.security_headers import (
            apply_security_headers,
        )

        app = FastAPI()
        app.add_middleware(SecurityHeadersMiddleware)

        @app.get("/boom")
        async def boom() -> dict[str, str]:
            raise RuntimeError("intentional test failure")

        @app.exception_handler(Exception)
        async def _h(request: Request, exc: Exception) -> JSONResponse:
            return JSONResponse(
                status_code=500,
                content={"error": "internal_error"},
                headers=apply_security_headers(),
            )

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/boom")
        assert resp.status_code == 500
        lowered = {k.lower() for k in resp.headers}
        for required in (
            "x-content-type-options",
            "x-frame-options",
            "content-security-policy",
            "strict-transport-security",
            "referrer-policy",
            "permissions-policy",
        ):
            assert required in lowered, (
                f"F67 regression: required security header "
                f"'{required}' missing from 500 response "
                f"(exception handler didn't apply it)"
            )


class TestF67DoesNotClobber:
    """A downstream middleware that pre-sets a header (e.g. a
    CORS layer or a per-route override) must not be clobbered."""

    def test_existing_xframe_options_is_preserved(self) -> None:
        """If a downstream handler / middleware sets its own
        X-Frame-Options, the security-headers middleware must
        NOT overwrite it.

        The ``SecurityHeadersMiddleware`` is the OUTERMOST
        middleware (registered LAST in the production app).
        When the response flows back up, our ``send_wrapper``
        runs LAST — so if a downstream (inner) middleware
        already set X-Frame-Options, our existing-keys check
        must skip our default to preserve the downstream
        value.

        In FastAPI's ``add_middleware``, the LAST registered
        middleware ends up at index 0 of ``user_middleware``
        and becomes the OUTERMOST in the chain. So to make
        ``OverrideMiddleware`` INNER, we register it FIRST.
        """

        from starlette.types import ASGIApp, Receive, Scope, Send

        captured: dict[str, str] = {}

        class OverrideMiddleware:
            def __init__(self, app: ASGIApp) -> None:
                self.app = app

            async def __call__(
                self, scope: Scope, receive: Receive, send: Send
            ) -> None:
                async def send_wrapper(message):
                    if message["type"] == "http.response.start":
                        headers = list(message.get("headers") or [])
                        headers.append(
                            (b"x-frame-options", b"SAMEORIGIN")
                        )
                        message["headers"] = headers
                        captured["xfo"] = "SAMEORIGIN"
                    await send(message)

                await self.app(scope, receive, send_wrapper)

        # Register Override FIRST so it ends up INNER in the
        # chain (FastAPI inserts at index 0; the last
        # registered is outermost). Then SecurityHeaders is
        # registered SECOND → OUTERMOST. When the response
        # flows back, Override's sw runs first (adds
        # SAMEORIGIN), then Security's sw runs and sees the
        # existing X-Frame-Options → skips its default.
        app = FastAPI()
        app.add_middleware(OverrideMiddleware)
        app.add_middleware(SecurityHeadersMiddleware)

        @app.get("/x")
        async def x() -> dict[str, bool]:
            return {"ok": True}

        client = TestClient(app, raise_server_exceptions=True)
        resp = client.get("/x")
        # The override must win (SAMEORIGIN, not DENY).
        assert resp.headers.get("x-frame-options") == "SAMEORIGIN", (
            f"F67 regression: SecurityHeadersMiddleware overwrote "
            f"a downstream X-Frame-Options override. Got "
            f"{resp.headers.get('x-frame-options')!r}, expected "
            f"'SAMEORIGIN'."
        )
        assert captured.get("xfo") == "SAMEORIGIN"


class TestF67AppWiring:
    """The production app MUST register SecurityHeadersMiddleware.
    A future refactor that removes it must fail this test."""

    def test_app_uses_security_headers_middleware(self) -> None:
        from eden.api.app import app
        from eden.api.middleware import SecurityHeadersMiddleware

        # FastAPI stores middleware classes in
        # ``app.user_middleware`` as a list of
        # ``starlette.middleware.Middleware`` wrappers; we
        # inspect the ``cls`` attribute.
        middleware_classes = {m.cls for m in app.user_middleware}
        assert SecurityHeadersMiddleware in middleware_classes, (
            "F67 regression: SecurityHeadersMiddleware is no "
            "longer registered on the production app"
        )

    def test_security_headers_middleware_is_outermost(self) -> None:
        """The security headers middleware should be the
        OUTERMOST user middleware (closest to
        ServerErrorMiddleware) so even CORS preflight and
        401 envelopes get the headers.

        FastAPI's ``add_middleware`` does ``insert(0, ...)``
        so the LAST registered middleware ends up at index 0
        in ``user_middleware``. Starlette's
        ``build_middleware_stack`` iterates ``reversed(...)``,
        wrapping with the LAST element of the original list
        first → that element becomes the INNERMOST user
        middleware. Conversely, the FIRST element of
        ``user_middleware`` (index 0) is the LAST to be
        wrapped → OUTERMOST user middleware.
        """
        from eden.api.app import app
        from eden.api.middleware import SecurityHeadersMiddleware

        if not app.user_middleware:
            pytest.fail("app has no user_middleware registered")
        # Index 0 = the LAST registered = OUTERMOST user middleware.
        assert app.user_middleware[0].cls is SecurityHeadersMiddleware, (
            f"F67 regression: SecurityHeadersMiddleware is no "
            f"longer the outermost middleware on the app. "
            f"user_middleware[0] is {app.user_middleware[0].cls.__name__}."
        )
