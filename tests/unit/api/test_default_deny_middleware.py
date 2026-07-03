"""Tests for the default-deny auth middleware (security 26).

The middleware ensures every request carries SOME auth context
(cookie, bearer, or org-specific header) unless the path is on
the explicit public allow-list. The post-route 401 is the route's
job; this middleware catches routes that ship without an auth
dep at all.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.middleware.default_deny import (
    DEFAULT_PUBLIC_PREFIXES,
    DefaultDenyAuthMiddleware,
    _is_public,
)


def _build_app() -> FastAPI:
    """Build a minimal app with just the default-deny middleware.

    The real app has many middlewares; we only need to verify
    this one in isolation.
    """
    app = FastAPI()
    app.add_middleware(DefaultDenyAuthMiddleware)

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/health/deep")
    async def health_deep():
        return {"ok": True}

    @app.get("/secret/endpoint")
    async def secret():
        return {"secret": "shh"}

    @app.post("/secret/mutate")
    async def mutate():
        return {"ok": True}

    return app


def test_public_prefixes_documented():
    """The allow-list must include the minimum expected entries."""
    assert "/health" in DEFAULT_PUBLIC_PREFIXES
    assert "/auth/login" in DEFAULT_PUBLIC_PREFIXES
    assert "/auth/signup" in DEFAULT_PUBLIC_PREFIXES
    assert "/docs" in DEFAULT_PUBLIC_PREFIXES


def test_is_public_helper():
    """The path classifier recognises the allow-list prefixes."""
    assert _is_public("/health") is True
    assert _is_public("/health/deep") is True
    assert _is_public("/auth/login") is True
    assert _is_public("/auth/signup-from-invite") is True
    # NOT public:
    assert _is_public("/secret/endpoint") is False
    assert _is_public("/api/v1/users") is False


def test_unauthenticated_request_to_private_path_is_401():
    app = _build_app()
    client = TestClient(app)
    response = client.get("/secret/endpoint")
    assert response.status_code == 401
    assert "Authentication required" in response.json()["detail"]


def test_cookie_auth_lets_request_through():
    app = _build_app()
    client = TestClient(app)
    client.cookies.set("authorization", "fake-jwt-for-test")
    response = client.get("/secret/endpoint")
    # The middleware only checks the credential is present; the
    # downstream route is the real verifier. Our test app returns
    # 200, so the middleware is verified to NOT short-circuit.
    assert response.status_code == 200


def test_bearer_header_lets_request_through():
    app = _build_app()
    client = TestClient(app)
    response = client.get(
        "/secret/endpoint",
        headers={"Authorization": "Bearer fake-token"},
    )
    assert response.status_code == 200


def test_x_org_api_key_header_lets_request_through():
    app = _build_app()
    client = TestClient(app)
    response = client.get(
        "/secret/endpoint",
        headers={"X-Org-Api-Key": "fake-key"},
    )
    assert response.status_code == 200


def test_health_endpoint_is_public():
    app = _build_app()
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    response = client.get("/health/deep")
    assert response.status_code == 200


def test_post_without_auth_is_401():
    app = _build_app()
    client = TestClient(app)
    response = client.post("/secret/mutate")
    assert response.status_code == 401