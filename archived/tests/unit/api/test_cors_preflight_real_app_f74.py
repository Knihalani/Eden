"""F74 — Integration test: CORS preflight works against the REAL app.

The unit-level F74 tests (test_cors_preflight_f74.py) use a minimal
mock app with FakeCORSMiddleware to verify the preflight passes
through ``DefaultDenyAuthMiddleware``. This integration test
exercises the REAL production app (``eden.api.app:app``) so we
catch regressions where a future middleware reorder would put
``DefaultDenyAuthMiddleware`` OUTSIDE ``CORSMiddleware`` again.

Why this matters:

* ``CORSMiddleware`` handles the preflight and emits the
  ``Access-Control-Allow-*`` headers.
* ``DefaultDenyAuthMiddleware`` is OUTSIDE ``CORSMiddleware`` in
  the chain — but MUST forward OPTIONS preflights through
  (browsers forbid credentials on preflights, so 401'ing the
  preflight breaks CORS for every cross-origin state-changing
  request).
* ``SecurityHeadersMiddleware`` is the OUTERMOST user middleware
  so the preflight 200 carries the OWASP header block too.

If any of these layers breaks, the preflight fails and the
portal can't talk to the API.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from eden.api.app import app

    return TestClient(app, raise_server_exceptions=False)


class TestF74RealAppPreflight:
    """The production app MUST accept CORS preflights and respond
    with 200 + the full CORS header block."""

    def test_preflight_returns_200(self, client: TestClient) -> None:
        resp = client.options(
            "/auth/login",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        assert resp.status_code == 200, (
            f"F74 regression: real app returned {resp.status_code} on "
            f"preflight for POST /auth/login. DefaultDenyAuthMiddleware "
            f"is rejecting preflights without credentials, which breaks "
            f"CORS for every cross-origin state-changing request."
        )

    def test_preflight_emits_access_control_allow_origin(self, client: TestClient) -> None:
        resp = client.options(
            "/auth/login",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        assert resp.headers.get("access-control-allow-origin") == "http://localhost:3000", (
            f"F74 regression: preflight response missing "
            f"access-control-allow-origin. Got: {dict(resp.headers)}"
        )

    def test_preflight_emits_access_control_allow_methods(self, client: TestClient) -> None:
        resp = client.options(
            "/auth/login",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        methods = resp.headers.get("access-control-allow-methods", "")
        for required in ("POST", "OPTIONS"):
            assert required in methods, (
                f"F74 regression: preflight allow-methods missing '{required}'. "
                f"Got: {methods!r}"
            )

    def test_preflight_carries_security_headers(self, client: TestClient) -> None:
        """The preflight 200 MUST also carry the OWASP security
        header block — SecurityHeadersMiddleware is the OUTERMOST
        user middleware and fires on every response, including
        preflights."""
        resp = client.options(
            "/auth/login",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        lowered = {k.lower() for k in resp.headers}
        for required in (
            "strict-transport-security",
            "x-content-type-options",
            "x-frame-options",
            "content-security-policy",
            "referrer-policy",
        ):
            assert required in lowered, (
                f"F74 regression: required security header '{required}' "
                f"missing from CORS preflight 200 in the real app."
            )

    def test_preflight_works_for_state_changing_endpoints(self, client: TestClient) -> None:
        """Cross-origin state-changing endpoints (POST/PATCH/DELETE)
        are the primary CORS victims — verify a sample of common
        routes accept preflights against the real app."""
        # Each tuple: (path, method)
        cases = [
            ("/auth/login", "POST"),
            ("/auth/signup", "POST"),
            ("/auth/logout", "POST"),
        ]
        for path, method in cases:
            resp = client.options(
                path,
                headers={
                    "Origin": "http://localhost:3000",
                    "Access-Control-Request-Method": method,
                    "Access-Control-Request-Headers": "Authorization, Content-Type",
                },
            )
            assert resp.status_code == 200, (
                f"F74 regression: preflight for {method} {path} returned "
                f"{resp.status_code}. State-changing endpoints MUST accept "
                f"CORS preflights."
            )
