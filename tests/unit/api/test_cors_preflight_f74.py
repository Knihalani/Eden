"""F74 — CORS preflight passes through DefaultDenyAuthMiddleware.

Pre-F74 the ``DefaultDenyAuthMiddleware`` was OUTSIDE
``CORSMiddleware`` in the chain (closer to ServerErrorMiddleware).
When the browser sent an OPTIONS preflight (no auth credentials, just
``Origin`` + ``Access-Control-Request-Method`` + ``Access-Control-Request-Headers``),
``_scope_has_credential(scope)`` returned False, the middleware
rejected the request with a 401 JSON envelope, and the browser
saw:

  * ``HTTP/1.1 401 Unauthorized``
  * NO ``Access-Control-Allow-*`` headers

This broke CORS for every cross-origin fetch from the portal
to any state-changing endpoint (POST /me, PATCH /users/me,
DELETE /webhooks, etc.) — the browser refused the actual
request because the preflight failed.

F74 short-circuits the middleware on ``OPTIONS`` requests:
the preflight is forwarded to ``CORSMiddleware`` which sits
INSIDE this middleware. The preflight is NEVER supposed to
carry credentials (browsers forbid it), so this is safe —
the actual auth check still happens for the real request
that follows the preflight.

The fix preserves all other security guarantees:

* ``SecurityHeadersMiddleware`` (outermost) still fires, so
  the preflight 200 carries HSTS + CSP + X-Frame-Options +
  the rest of the OWASP block.
* ``TenantRateLimitMiddleware`` already short-circuits OPTIONS
  (no point rate-limiting a preflight).
* ``DefaultDenyAuthMiddleware`` still rejects non-OPTIONS
  requests without credentials (the original behavior).
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from eden.api.middleware.default_deny import (
    DefaultDenyAuthMiddleware,
    _scope_has_credential,
)


class TestF74CORSHelper:
    """The ``_scope_has_credential`` helper MUST NOT consider an
    OPTIONS request as credentialed just because the browser sent
    ``Origin`` + ``Access-Control-Request-Method`` headers.
    (This is the symptom of the pre-F74 bug — the helper returned
    False, so the middleware took the rejection path.)"""

    def test_options_request_has_no_credential(self) -> None:
        scope = {
            "type": "http",
            "method": "OPTIONS",
            "headers": [
                (b"origin", b"https://edenobservability.com"),
                (
                    b"access-control-request-method",
                    b"POST",
                ),
                (
                    b"access-control-request-headers",
                    b"authorization,content-type",
                ),
            ],
        }
        # OPTIONS preflight NEVER carries credentials (browsers
        # forbid it). The helper MUST return False so the
        # middleware's preflight passthrough can fire.
        assert _scope_has_credential(scope) is False, (
            "F74 regression: _scope_has_credential now considers "
            "OPTIONS preflight requests as credentialed, which "
            "would break CORS for the preflight path"
        )


class TestF74PreflightPassesThrough:
    """The ``DefaultDenyAuthMiddleware`` MUST pass OPTIONS requests
    through to ``CORSMiddleware`` (which sits INSIDE the
    middleware in the chain). The preflight is never supposed to
    carry credentials; rejecting it is a CORS-breaking bug."""

    def _build_app_with_cors(self) -> FastAPI:
        """Build a minimal FastAPI app with the production-equivalent
        middleware stack: SecurityHeadersMiddleware (outermost user),
        DefaultDenyAuthMiddleware, then a stub that mimics
        CORSMiddleware's preflight response."""
        from eden.api.middleware.security_headers import (
            SecurityHeadersMiddleware,
        )

        # Register SecurityHeaders LAST so it ends up as the
        # OUTERMOST user middleware in the chain (FastAPI's
        # ``add_middleware`` does ``insert(0, ...)``; the LAST
        # registered ends up at index 0 → wrapped LAST in
        # Starlette's ``reversed()`` build loop → outermost).
        app = FastAPI()
        class FakeCORSMiddleware:
            """Mimics Starlette's CORSMiddleware preflight response.

            Real CORSMiddleware returns ``PlainTextResponse("OK",
            status_code=200)`` with the ``Access-Control-Allow-*``
            headers. We don't need the real middleware for this
            test — we just need to verify that OPTIONS reaches
            this layer."""

            def __init__(self, app: ASGIApp) -> None:
                self.app = app

            async def __call__(
                self, scope: Scope, receive: Receive, send: Send
            ) -> None:
                if (
                    scope["type"] == "http"
                    and scope.get("method") == "OPTIONS"
                ):
                    response = PlainTextResponse(
                        "OK",
                        status_code=200,
                        headers={
                            "access-control-allow-origin": "http://localhost:3000",
                            "access-control-allow-methods": "GET, POST",
                            "access-control-allow-credentials": "true",
                        },
                    )
                    await response(scope, receive, send)
                    return
                await self.app(scope, receive, send)

        # Registration order matters: FastAPI's add_middleware does
        # ``insert(0, ...)``; the LAST registered ends up at index 0
        # in ``user_middleware`` → wrapped LAST in Starlette's
        # ``reversed()`` build loop → OUTERMOST. We want the
        # preflight request to flow:
        #   SecurityHeaders (outermost) →
        #     DefaultDeny (OPTIONS passthrough) →
        #       FakeCORS (200 preflight response)
        # so the security headers are added on the way OUT.
        app.add_middleware(FakeCORSMiddleware)
        app.add_middleware(DefaultDenyAuthMiddleware)
        app.add_middleware(SecurityHeadersMiddleware)

        @app.post("/api/v1/me/data")
        async def data() -> dict[str, str]:
            return {"ok": "true"}

        return app

    def test_options_preflight_returns_200(self) -> None:
        app = self._build_app_with_cors()
        client = TestClient(app, raise_server_exceptions=True)
        resp = client.options(
            "/api/v1/me/data",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Authorization, Content-Type",
            },
        )
        assert resp.status_code == 200, (
            f"F74 regression: OPTIONS preflight returned {resp.status_code}, "
            f"expected 200. DefaultDenyAuthMiddleware is still rejecting "
            f"preflights without credentials, which breaks CORS for every "
            f"cross-origin request to state-changing endpoints."
        )
        # The CORS headers from FakeCORSMiddleware MUST be present
        # (proves the preflight reached that middleware).
        assert resp.headers.get("access-control-allow-origin") == "http://localhost:3000"
        assert "POST" in resp.headers.get("access-control-allow-methods", "")

    def test_options_preflight_carries_security_headers(self) -> None:
        app = self._build_app_with_cors()
        client = TestClient(app, raise_server_exceptions=True)
        resp = client.options(
            "/api/v1/me/data",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
            },
        )
        # The preflight 200 MUST also carry the OWASP security
        # header block (SecurityHeadersMiddleware is outermost
        # and fires on every response, including preflights).
        lowered = {k.lower() for k in resp.headers}
        for required in (
            "strict-transport-security",
            "x-content-type-options",
            "x-frame-options",
            "content-security-policy",
            "referrer-policy",
        ):
            assert required in lowered, (
                f"F74 regression: required security header "
                f"'{required}' missing from CORS preflight 200. "
                f"Defense-in-depth gap: a preflight without the "
                f"OWASP block could be replayed by an attacker."
            )

    def test_non_options_still_requires_credential(self) -> None:
        """The fix MUST NOT weaken the default-deny posture for
        real requests. A GET without credentials MUST still 401
        (the original middleware behavior)."""
        app = self._build_app_with_cors()
        client = TestClient(app, raise_server_exceptions=True)
        # GET without credentials — must still 401.
        resp = client.get("/api/v1/me/data")
        assert resp.status_code == 401, (
            f"F74 regression: DefaultDenyAuthMiddleware no longer "
            f"rejects non-credentialed GETs (got {resp.status_code}). "
            f"The OPTIONS passthrough accidentally weakened the "
            f"default-deny posture."
        )


class TestF74PreflightSourceLevel:
    """Source-level pin: the OPTIONS passthrough is in place in
    DefaultDenyAuthMiddleware.__call__. A refactor that removes
    the early-return (e.g. someone merging the two branches)
    breaks CORS for every cross-origin request — fail the test."""

    def test_options_short_circuit_is_present(self) -> None:
        import inspect

        from eden.api.middleware import default_deny

        src = inspect.getsource(default_deny.DefaultDenyAuthMiddleware.__call__)
        # The early-return for OPTIONS MUST be in the source
        # (not "if method == 'OPTIONS': pass" or similar).
        assert 'method == "OPTIONS"' in src, (
            "F74 regression: DefaultDenyAuthMiddleware no longer "
            "short-circuits OPTIONS preflights. This breaks CORS "
            "for every cross-origin state-changing request from "
            "the portal."
        )
        # The short-circuit MUST forward the request to the
        # inner app (CORSMiddleware), not reject it.
        assert (
            'if method == "OPTIONS":\n            await self.app(scope, receive, send)\n            return'
            in src
        ), (
            "F74 regression: the OPTIONS short-circuit no longer "
            "forwards to the inner app. The preflight would be "
            "dropped or rejected instead of reaching CORSMiddleware."
        )
