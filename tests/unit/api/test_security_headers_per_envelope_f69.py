"""F69 — Security headers on per-route / per-middleware JSONResponse envelopes.

F67 added the ``SecurityHeadersMiddleware`` (outermost user middleware) and
``apply_security_headers()`` helper for the global exception handlers.
That covers every response that flows through the chain.

F69 closes the remaining gap: per-route + per-middleware
``JSONResponse(..., headers=...)`` builders that RETURN a response
without going through the global exception handler path. These
construct their headers inline and could drop the security block
if a future refactor reorders the middleware stack. The fix is
defense-in-depth: add ``apply_security_headers()`` to the
``headers=`` kwarg so each envelope carries the block independently
of the middleware chain order.

Envelopes covered:

* ``DefaultDenyAuthMiddleware`` — 401 ``unauthorized``
* ``IdempotencyMiddleware`` — 400 missing key + 200 replay
* ``QuotaEnforcementMiddleware`` — 429 ``quota_exceeded`` (×2)
* ``auth.py`` — 202 signup / signup-from-invite (×3)
* ``media.py`` — 200 blob response (Cache-Control preserved)
"""

from __future__ import annotations

import inspect

import pytest

# ─────────────────────────────────────────────────────────────────────────────
# Source-level pin: the helper is imported in every patched module.
# ─────────────────────────────────────────────────────────────────────────────


class TestF69SourceLevelImports:
    """Every module that builds a per-route / per-middleware envelope
    MUST import ``apply_security_headers`` so a refactor that moves
    the helper (or renames the function) updates the import AND the
    call sites together."""

    @pytest.mark.parametrize(
        "module_path",
        [
            "eden.api.middleware.default_deny",
            "eden.api.middleware.idempotency",
            "eden.api.middleware.quota_enforcement",
            "eden.api.routes.auth",
            "eden.api.routes.media",
        ],
    )
    def test_module_imports_apply_security_headers(self, module_path: str) -> None:
        import importlib

        mod = importlib.import_module(module_path)
        src = inspect.getsource(mod)
        assert "apply_security_headers" in src, (
            f"F69 regression: {module_path} no longer imports or "
            f"calls apply_security_headers. A future refactor that "
            f"reorders the middleware stack will silently drop the "
            f"security header block on this envelope."
        )


# ─────────────────────────────────────────────────────────────────────────────
# Live behaviour: every patched envelope carries the security block.
# ─────────────────────────────────────────────────────────────────────────────


class TestF69DefaultDeny401:
    """The 401 envelope from DefaultDenyAuthMiddleware MUST carry the
    security header block (defense-in-depth: the middleware is
    OUTSIDE the security middleware in the chain, so the block
    fires automatically, but a future reorder must not drop it)."""

    def test_401_envelope_has_security_headers(self) -> None:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from eden.api.middleware.default_deny import DefaultDenyAuthMiddleware
        from eden.api.middleware.security_headers import _STATIC_HEADERS

        app = FastAPI()
        app.add_middleware(DefaultDenyAuthMiddleware)

        @app.get("/secret")
        async def secret() -> dict[str, str]:
            return {"shh": "ok"}

        client = TestClient(app, raise_server_exceptions=True)
        resp = client.get("/secret")
        assert resp.status_code == 401
        # The 401 envelope MUST carry every static header
        # regardless of middleware chain order.
        expected_names = {n.decode() for n, _ in _STATIC_HEADERS}
        actual_names = set(resp.headers.keys())
        missing = expected_names - actual_names
        assert not missing, (
            f"F69 regression: 401 envelope from DefaultDenyAuthMiddleware "
            f"is missing security headers: {missing}"
        )


class TestF69Idempotency400:
    """The 400 envelope from IdempotencyMiddleware (missing key) MUST
    carry the security block."""

    def test_400_envelope_has_security_headers(self) -> None:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from starlette.middleware.base import BaseHTTPMiddleware

        from eden.api.middleware.idempotency import IdempotencyMiddleware
        from eden.api.middleware.security_headers import _STATIC_HEADERS

        app = FastAPI()
        # IdempotencyMiddleware is BaseHTTPMiddleware; wrap the
        # outer app with it. We don't add the security middleware
        # here — this tests the defense-in-depth path.
        app.add_middleware(IdempotencyMiddleware)

        @app.post("/v1/mutate")
        async def mutate() -> dict[str, str]:
            return {"ok": "true"}

        client = TestClient(app, raise_server_exceptions=True)
        # POST to /v1/* without Idempotency-Key → 400 envelope
        resp = client.post("/v1/mutate", json={})
        assert resp.status_code == 400
        expected_names = {n.decode() for n, _ in _STATIC_HEADERS}
        actual_names = set(resp.headers.keys())
        missing = expected_names - actual_names
        assert not missing, (
            f"F69 regression: 400 envelope from IdempotencyMiddleware "
            f"is missing security headers: {missing}"
        )


class TestF69MediaBlobResponse:
    """The 200 blob response from ``media.py`` MUST carry the full
    security header block (HSTS, CSP, etc.) AND preserve the
    existing ``Cache-Control`` / ``X-Sha256`` / ``X-Content-Type-Options``
    headers the route sets."""

    def test_blob_response_has_security_headers(self) -> None:
        # Source-level pin — the route is wrapped in lifespan-managed
        # infra that's hard to test in isolation. We assert at the
        # source level that the merge is correct.
        from eden.api.routes import media

        src = inspect.getsource(media)
        # The blob-return path MUST call apply_security_headers(...)
        # with a dict that contains Cache-Control + X-Sha256.
        assert "apply_security_headers" in src, (
            "F69 regression: media.py no longer applies the security "
            "header block to blob responses"
        )
        # The merge dict MUST preserve Cache-Control
        assert '"Cache-Control"' in src or "'Cache-Control'" in src, (
            "F69 regression: media.py blob response lost Cache-Control"
        )
        assert "X-Sha256" in src, (
            "F69 regression: media.py blob response lost X-Sha256"
        )


class TestF69Auth202Envelopes:
    """The three 202 ``If that email is not already registered``
    envelopes from auth.py MUST carry the security block."""

    def test_auth_202_envelopes_use_apply_security_headers(self) -> None:
        from eden.api.routes import auth

        src = inspect.getsource(auth)
        # 3 callers in auth.py each return a 202 with the "If that
        # email is not already registered" message. F69 added
        # ``apply_security_headers()`` to each. Source-level pin
        # to catch any future regression.
        n = src.count("apply_security_headers(")
        assert n >= 3, (
            f"F69 regression: expected at least 3 apply_security_headers "
            f"call sites in auth.py, found {n}"
        )
