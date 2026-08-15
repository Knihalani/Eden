"""S-3 SSO state CSRF protection tests.

The S-3 audit found that ``/sso/login/{provider_id}`` generated a
state nonce but never persisted it, and ``/sso/callback/{provider_id}``
accepted (but never validated) the round-tripped state. These tests
pin the four behaviors the fix ships:

* initiate stores the state nonce in Redis with a TTL
* initiate returns 503 if Redis is down (fail-closed on CSRF)
* callback 400s when state is missing
* callback 400s when state is unknown / expired
* callback 400s when state was minted for a different provider or org
* callback succeeds and consumes the nonce (single-use)
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


# ─── Redis fake ─────────────────────────────────────────────────────────
class _FakeRedis:
    """In-memory Redis with the three ops the SSO routes use.

    Tracks set/get/delete so the tests can assert what was stored
    AND that the callback consumes the nonce (no replay).
    """

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.store: dict[str, str] = {}
        self.set_calls: list[tuple[str, str, int | None]] = []
        self.get_calls: list[str] = []
        self.delete_calls: list[str] = []

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        if self.fail:
            raise RuntimeError("redis down")
        self.set_calls.append((key, value, ex))
        self.store[key] = value

    async def get(self, key: str) -> str | None:
        self.get_calls.append(key)
        return self.store.get(key)

    async def delete(self, key: str) -> int:
        self.delete_calls.append(key)
        return 1 if self.store.pop(key, None) is not None else 0


# ─── Provider fixture ──────────────────────────────────────────────────
def _provider_row(provider_type: str = "okta") -> dict[str, Any]:
    """Row shape from the live JOIN (org_sso_settings × sso_configurations)."""
    auth = None
    if provider_type == "okta":
        auth = "https://example.okta.com"
    elif provider_type == "google":
        auth = "https://accounts.google.com/o/oauth2/v2/auth"
    elif provider_type == "oidc":
        auth = "https://example.com/oauth2/authorize"
    return {
        "id": "prov-1",
        "org_id": "org-1",
        "provider_type": provider_type,
        "name": provider_type,
        "client_id": "client-1",
        "client_secret": "secret-1",
        "authorization_endpoint": auth,
        "token_endpoint": None,
        "userinfo_endpoint": None,
    }


# ─── App builder ──────────────────────────────────────────────────────
def _build_app() -> FastAPI:
    from eden.api.routes import sso as sso_routes

    app = FastAPI(title="eden-sso-test")
    app.include_router(sso_routes.router)
    return app


# ─── initiate tests ──────────────────────────────────────────────────
@pytest.mark.parametrize("provider_type", ["okta", "google", "oidc"])
def test_initiate_persists_state_nonce(provider_type: str) -> None:
    fake = _FakeRedis()
    with patch("eden.api.routes.sso.get_redis_client", AsyncMock(return_value=fake)):
        with patch(
            "eden.api.routes.sso.get_postgres_client",
            AsyncMock(return_value=_pg_with_provider(provider_type)),
        ):
            client = TestClient(_build_app())
            resp = client.get(
                "/sso/login/prov-1?org_id=org-1"
            )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"]
    assert len(body["state"]) >= 32  # token_urlsafe(32)
    # State was persisted under the SSO prefix with the right tuple
    assert len(fake.set_calls) == 1
    key, value, ttl = fake.set_calls[0]
    assert key == f"eden:sso:state:{body['state']}"
    assert value == "prov-1|org-1"
    assert ttl == 600  # _SSO_STATE_TTL_SECONDS


def test_initiate_fails_closed_when_redis_down() -> None:
    fake = _FakeRedis(fail=True)
    with patch("eden.api.routes.sso.get_redis_client", AsyncMock(return_value=fake)):
        with patch(
            "eden.api.routes.sso.get_postgres_client",
            AsyncMock(return_value=_pg_with_provider("okta")),
        ):
            client = TestClient(_build_app())
            resp = client.get("/sso/login/prov-1?org_id=org-1")
    # 503 because we deliberately fail closed on a CSRF-sensitive flow
    # (better to refuse the login than to mint a nonce nobody can check)
    assert resp.status_code == 503
    assert "state store offline" in resp.text.lower() or "temporarily" in resp.text.lower()


# ─── callback tests ──────────────────────────────────────────────────
def test_callback_rejects_missing_state() -> None:
    fake = _FakeRedis()
    with patch("eden.api.routes.sso.get_redis_client", AsyncMock(return_value=fake)):
        with patch(
            "eden.api.routes.sso.get_postgres_client",
            AsyncMock(return_value=_pg_with_provider("okta")),
        ):
            client = TestClient(_build_app())
            resp = client.post(
                "/sso/callback/prov-1?org_id=org-1&code=abc"
            )
    assert resp.status_code == 400
    assert "missing state" in resp.text.lower()


def test_callback_rejects_unknown_state() -> None:
    fake = _FakeRedis()
    with patch("eden.api.routes.sso.get_redis_client", AsyncMock(return_value=fake)):
        with patch(
            "eden.api.routes.sso.get_postgres_client",
            AsyncMock(return_value=_pg_with_provider("okta")),
        ):
            client = TestClient(_build_app())
            resp = client.post(
                "/sso/callback/prov-1?org_id=org-1&code=abc&state=never-issued"
            )
    assert resp.status_code == 400
    assert "invalid or expired" in resp.text.lower()


def test_callback_rejects_state_for_wrong_provider() -> None:
    fake = _FakeRedis()
    fake.store["eden:sso:state:some-state"] = "OTHER-PROV|org-1"
    with patch("eden.api.routes.sso.get_redis_client", AsyncMock(return_value=fake)):
        with patch(
            "eden.api.routes.sso.get_postgres_client",
            AsyncMock(return_value=_pg_with_provider("okta")),
        ):
            client = TestClient(_build_app())
            resp = client.post(
                "/sso/callback/prov-1?org_id=org-1&code=abc&state=some-state"
            )
    assert resp.status_code == 400
    assert "does not match" in resp.text.lower()


def test_callback_consumes_state_and_succeeds() -> None:
    """Valid state is single-use consumed before the IdP handler runs.

    Unsupported provider types still yield a structured 503, but OIDC-
    family providers (okta/google) route into the real OIDC exchange —
    see ``test_oidc_family_provider_routes_to_oidc_handler``.
    """
    fake = _FakeRedis()
    fake.store["eden:sso:state:valid-state"] = "prov-1|org-1"
    with patch("eden.api.routes.sso.get_redis_client", AsyncMock(return_value=fake)):
        with patch(
            "eden.api.routes.sso.get_postgres_client",
            AsyncMock(return_value=_pg_with_provider("ldap")),
        ):
            client = TestClient(_build_app())
            resp = client.post(
                "/sso/callback/prov-1?org_id=org-1&code=abc&state=valid-state"
            )
    assert resp.status_code == 503, resp.text
    body = resp.json()
    detail = body.get("detail") or {}
    assert detail.get("status") == "sso_not_enabled"
    # Nonce is gone — replay must fail
    assert "eden:sso:state:valid-state" not in fake.store
    # Second attempt with the same state → 400
    with patch("eden.api.routes.sso.get_redis_client", AsyncMock(return_value=fake)):
        with patch(
            "eden.api.routes.sso.get_postgres_client",
            AsyncMock(return_value=_pg_with_provider("ldap")),
        ):
            resp2 = client.post(
                "/sso/callback/prov-1?org_id=org-1&code=abc&state=valid-state"
            )
    assert resp2.status_code == 400


def test_callback_oidc_family_does_not_return_sso_not_enabled() -> None:
    """Okta/Google must route to the OIDC handler, not the blanket 503."""
    fake = _FakeRedis()
    fake.store["eden:sso:state:valid-state"] = "prov-1|org-1"
    with patch("eden.api.routes.sso.get_redis_client", AsyncMock(return_value=fake)):
        with patch(
            "eden.api.routes.sso.get_postgres_client",
            AsyncMock(return_value=_pg_with_provider("okta")),
        ):
            with patch(
                "eden.api.routes.sso._handle_oidc_callback",
                AsyncMock(
                    side_effect=HTTPException(
                        status_code=400, detail="Missing authorization code"
                    )
                ),
            ):
                client = TestClient(_build_app())
                resp = client.post(
                    "/sso/callback/prov-1?org_id=org-1&state=valid-state"
                )
    assert resp.status_code == 400, resp.text
    assert "sso_not_enabled" not in resp.text.lower()


# ─── helpers ──────────────────────────────────────────────────────────
def _pg_with_provider(provider_type: str) -> MagicMock:
    """Return a Postgres client mock whose fetchrow returns the
    configured provider row regardless of arguments.
    """
    pg = MagicMock()
    row = _provider_row(provider_type)

    async def _fetchrow(query: str, *args: Any, **kwargs: Any):
        return row

    pg.fetchrow = AsyncMock(side_effect=_fetchrow)
    pg.fetch = AsyncMock(return_value=[])
    pg.execute = AsyncMock(return_value="")
    return pg
