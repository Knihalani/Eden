"""FEAT-1: real OIDC authorization-code exchange in ``sso_callback``.

Covers the success path (mocked IdP token endpoint + discovery + JWKS,
real RS256 signature verification against a real keypair) and the
main failure modes: IdP rejects the code, ID token signed by an
unrecognized/wrong key, ID token missing the ``email`` claim.

Only the outbound-HTTP boundary (``httpx.AsyncClient``) is mocked —
``eden.api.routes.sso._oidc_verify_id_token`` and its JWKS-matching /
signature-verification logic run for real against a real key, so a
bug in the actual crypto would fail these tests.
"""

from __future__ import annotations

import base64
import json
import time as time_module
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient

ORG = "org-1"
PROVIDER_ID = "prov-1"
CLIENT_ID = "client-1"
ISSUER = "https://idp.example.com"


def _rsa_keypair() -> tuple[Any, Any]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


def _jwk_from_public_key(public_key: Any, kid: str) -> dict[str, Any]:
    numbers = public_key.public_numbers()

    def _b64(n: int) -> str:
        raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    return {
        "kty": "RSA",
        "kid": kid,
        "use": "sig",
        "alg": "RS256",
        "n": _b64(numbers.n),
        "e": _b64(numbers.e),
    }


def _sign_id_token(private_key: Any, kid: str, claims: dict[str, Any]) -> str:
    pem = private_key.private_bytes(
        encoding=Encoding.PEM,
        format=PrivateFormat.PKCS8,
        encryption_algorithm=NoEncryption(),
    )
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": kid})


def _provider_row() -> dict[str, Any]:
    return {
        "id": PROVIDER_ID,
        "org_id": ORG,
        "provider_type": "oidc",
        "name": "oidc",
        "client_id": CLIENT_ID,
        "client_secret": "sekret",
        "authorization_endpoint": f"{ISSUER}/authorize",
        "token_endpoint": f"{ISSUER}/token",
        "userinfo_endpoint": None,
        "certificate": None,
    }


def _pg_with_provider() -> MagicMock:
    """Query-routing Postgres mock — tracks JIT-provisioned users/
    memberships in-process so ``_get_or_create_sso_user`` /
    ``_ensure_sso_org_membership`` see real "not found yet" ->
    "found" transitions instead of a single canned row for every
    query (which would make the provider-lookup row masquerade as a
    users/org_members row and crash on ``existing["role"]``).
    """
    pg = MagicMock()
    provider_row = _provider_row()
    users: dict[str, dict[str, Any]] = {}
    memberships: set[tuple[str, str]] = set()

    async def _fetchrow(query: str, *args: Any, **kwargs: Any):
        q = " ".join(query.split()).lower()
        if "from org_sso_settings" in q or "join sso_configurations" in q:
            return provider_row
        if "select id from users where email" in q:
            email = args[0]
            row = users.get(email)
            return {"id": row["id"]} if row else None
        if "update users" in q and "returning token_version" in q:
            user_id = args[0]
            for row in users.values():
                if row["id"] == user_id:
                    row["token_version"] = row.get("token_version", 0) + 1
                    return {"token_version": row["token_version"]}
            return {"token_version": 1}
        if "select id, role from org_members" in q:
            org_id, user_id = args[0], args[1]
            if (org_id, user_id) in memberships:
                return {"id": "member-1", "role": "member"}
            return None
        return None

    async def _execute(query: str, *args: Any, **kwargs: Any):
        q = " ".join(query.split()).lower()
        if "insert into users" in q:
            user_id, email = args[0], args[1]
            users[email] = {"id": user_id, "email": email}
            return "INSERT 0 1"
        if "insert into org_members" in q:
            org_id, user_id = args[0], args[1]
            memberships.add((org_id, user_id))
            return "INSERT 0 1"
        return ""

    pg.fetchrow = AsyncMock(side_effect=_fetchrow)
    pg.fetch = AsyncMock(return_value=[])
    pg.execute = AsyncMock(side_effect=_execute)

    @asynccontextmanager
    async def _noop_transaction():
        yield pg

    pg.transaction = _noop_transaction
    return pg


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.store[key] = value

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def delete(self, key: str) -> int:
        return 1 if self.store.pop(key, None) is not None else 0


def _build_app_with_state(state: str = "valid-state") -> tuple[FastAPI, _FakeRedis, MagicMock]:
    from eden.api.routes import sso as sso_routes

    app = FastAPI()
    app.include_router(sso_routes.router)
    redis = _FakeRedis()
    redis.store[f"eden:sso:state:{state}"] = f"{PROVIDER_ID}|{ORG}"
    pg = _pg_with_provider()
    return app, redis, pg


class _FakeHTTPResponse:
    def __init__(self, status_code: int, json_body: dict[str, Any] | None = None, text: str = ""):
        self.status_code = status_code
        self._json_body = json_body or {}
        self.text = text or json.dumps(self._json_body)

    def json(self) -> dict[str, Any]:
        return self._json_body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _make_fake_async_client(discovery_doc: dict, jwks_doc: dict, token_response: _FakeHTTPResponse):
    """Build a fake ``httpx.AsyncClient`` context manager whose GET
    serves discovery/JWKS and whose POST serves the token exchange —
    routed by URL, exactly mirroring what a real IdP triplet would
    respond with.
    """

    class _FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url: str, *args: Any, **kwargs: Any):
            if "openid-configuration" in url:
                return _FakeHTTPResponse(200, discovery_doc)
            if url == discovery_doc.get("jwks_uri"):
                return _FakeHTTPResponse(200, jwks_doc)
            raise AssertionError(f"unexpected GET {url}")

        async def post(self, url: str, *args: Any, **kwargs: Any):
            assert url == discovery_doc["token_endpoint"] or url == _provider_row()["token_endpoint"]
            return token_response

    return _FakeClient


@pytest.fixture(autouse=True)
def _reset_oidc_caches():
    from eden.api.routes import sso as sso_routes

    sso_routes._OIDC_DISCOVERY_CACHE.clear()
    sso_routes._OIDC_JWKS_CACHE.clear()
    yield
    sso_routes._OIDC_DISCOVERY_CACHE.clear()
    sso_routes._OIDC_JWKS_CACHE.clear()


def _discovery_and_jwks(public_key: Any, kid: str) -> tuple[dict, dict]:
    discovery = {
        "issuer": ISSUER,
        "token_endpoint": f"{ISSUER}/token",
        "jwks_uri": f"{ISSUER}/jwks.json",
    }
    jwks = {"keys": [_jwk_from_public_key(public_key, kid)]}
    return discovery, jwks


def test_oidc_callback_success_mints_session_and_provisions_user() -> None:
    private_key, public_key = _rsa_keypair()
    kid = "key-1"
    discovery, jwks = _discovery_and_jwks(public_key, kid)
    id_token = _sign_id_token(
        private_key,
        kid,
        {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "sub": "user-sub-1",
            "email": "person@example.com",
            "name": "Person Example",
            "exp": time_module.time() + 300,
            "iat": time_module.time(),
        },
    )
    token_response = _FakeHTTPResponse(200, {"id_token": id_token, "access_token": "at-1"})
    fake_client_cls = _make_fake_async_client(discovery, jwks, token_response)

    app, redis, pg = _build_app_with_state()
    from eden.api.routes import sso as sso_routes

    with (
        patch.object(sso_routes, "get_redis_client", AsyncMock(return_value=redis)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
        patch("httpx.AsyncClient", fake_client_cls),
    ):
        client = TestClient(app)
        resp = client.post(
            f"/sso/callback/{PROVIDER_ID}?org_id={ORG}&code=real-code&state=valid-state"
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["email"] == "person@example.com"
    assert body["org_id"] == ORG
    assert resp.cookies.get("authorization")

    # User was JIT-provisioned and added to the org.
    insert_calls = list(pg.execute.await_args_list)
    joined_sql = " ".join(
        " ".join(str(c.args[0]).split()).lower() for c in insert_calls
    )
    assert "insert into users" in joined_sql
    assert "insert into org_members" in joined_sql


def test_oidc_callback_rejects_bad_token_signature() -> None:
    """ID token signed by a DIFFERENT key than the one JWKS advertises
    must be rejected — proves the callback actually verifies the
    signature rather than trusting claims blindly."""
    private_key, public_key = _rsa_keypair()
    wrong_private_key, _ = _rsa_keypair()
    kid = "key-1"
    discovery, jwks = _discovery_and_jwks(public_key, kid)
    # Signed with the WRONG private key, but claims the right kid.
    bad_id_token = _sign_id_token(
        wrong_private_key,
        kid,
        {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "sub": "user-sub-1",
            "email": "person@example.com",
            "exp": time_module.time() + 300,
            "iat": time_module.time(),
        },
    )
    token_response = _FakeHTTPResponse(200, {"id_token": bad_id_token})
    fake_client_cls = _make_fake_async_client(discovery, jwks, token_response)

    app, redis, pg = _build_app_with_state()
    from eden.api.routes import sso as sso_routes

    with (
        patch.object(sso_routes, "get_redis_client", AsyncMock(return_value=redis)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
        patch("httpx.AsyncClient", fake_client_cls),
    ):
        client = TestClient(app)
        resp = client.post(
            f"/sso/callback/{PROVIDER_ID}?org_id={ORG}&code=real-code&state=valid-state"
        )

    assert resp.status_code == 401, resp.text
    assert "invalid id token" in resp.text.lower()


def test_oidc_callback_surfaces_idp_rejection_not_generic_503() -> None:
    """Token endpoint rejecting the code must surface as an honest
    4xx with a specific reason — never the old blanket 503
    "sso_not_enabled"."""
    private_key, public_key = _rsa_keypair()
    discovery, jwks = _discovery_and_jwks(public_key, "key-1")
    token_response = _FakeHTTPResponse(400, {"error": "invalid_grant"})
    fake_client_cls = _make_fake_async_client(discovery, jwks, token_response)

    app, redis, pg = _build_app_with_state()
    from eden.api.routes import sso as sso_routes

    with (
        patch.object(sso_routes, "get_redis_client", AsyncMock(return_value=redis)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
        patch("httpx.AsyncClient", fake_client_cls),
    ):
        client = TestClient(app)
        resp = client.post(
            f"/sso/callback/{PROVIDER_ID}?org_id={ORG}&code=bad-code&state=valid-state"
        )

    assert resp.status_code == 401, resp.text
    assert "rejected" in resp.text.lower()
    assert "sso_not_enabled" not in resp.text.lower()


def test_oidc_callback_rejects_id_token_without_email_claim() -> None:
    private_key, public_key = _rsa_keypair()
    kid = "key-1"
    discovery, jwks = _discovery_and_jwks(public_key, kid)
    id_token = _sign_id_token(
        private_key,
        kid,
        {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "sub": "user-sub-1",
            "exp": time_module.time() + 300,
            "iat": time_module.time(),
        },
    )
    token_response = _FakeHTTPResponse(200, {"id_token": id_token})
    fake_client_cls = _make_fake_async_client(discovery, jwks, token_response)

    app, redis, pg = _build_app_with_state()
    from eden.api.routes import sso as sso_routes

    with (
        patch.object(sso_routes, "get_redis_client", AsyncMock(return_value=redis)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
        patch("httpx.AsyncClient", fake_client_cls),
    ):
        client = TestClient(app)
        resp = client.post(
            f"/sso/callback/{PROVIDER_ID}?org_id={ORG}&code=real-code&state=valid-state"
        )

    assert resp.status_code == 400, resp.text
    assert "email" in resp.text.lower()
