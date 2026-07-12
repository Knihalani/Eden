"""Unit tests for the Clerk JWT verification helper.

Regression coverage for the bug where every portal request returned 401
because the FastAPI side of the auth chain couldn't verify Clerk
session JWTs — Northflank had no Clerk env vars configured, and
``_derive_jwks_url()`` raised ``RuntimeError`` when
``CLERK_JWKS_URL`` was empty instead of falling through gracefully.

These tests pin down three contracts:

1. ``verify_clerk_token`` returns ``None`` when neither
   ``CLERK_SECRET_KEY`` nor ``CLERK_JWT_KEY`` is configured (legacy
   Eden-cookie callers still work; Clerk callers are gracefully
   rejected rather than crashing the request thread).

2. ``_derive_jwks_url`` auto-derives the JWKS URL from a Clerk live
   secret key whose last ``$``-delimited segment is the instance
   domain (``sk_live_…$edenobservability.com$`` →
   ``https://clerk.edenobservability.com/.well-known/jwks.json``).

3. ``verify_clerk_token`` rejects garbage tokens instead of crashing
   (kid lookup is None-safe, malformed JWTs return None).
"""

from __future__ import annotations

import pytest

from eden.api.utils import clerk_auth


@pytest.fixture
def clerk_settings(monkeypatch):
    """Patch the cached ``_settings`` object on clerk_auth.

    The helper reads ``get_settings()`` at import time and caches the
    result on the module — patching ``clerk_auth._settings`` directly
    is the only reliable way to exercise both the "no keys" path and
    the "with secret key" path without spinning up a real Clerk
    instance.
    """

    def _set(**overrides):
        for key, value in overrides.items():
            monkeypatch.setattr(clerk_auth._settings, key, value)

    return _set


class TestDeriveJwksUrl:
    def test_explicit_url_wins(self, clerk_settings):
        clerk_settings(
            clerk_jwks_url="https://clerk.example.test/.well-known/jwks.json",
            clerk_publishable_key="pk_live_anything",
        )
        assert (
            clerk_auth._derive_jwks_url()
            == "https://clerk.example.test/.well-known/jwks.json"
        )

    def test_auto_derive_from_publishable_key(self, clerk_settings):
        # The publishable key encodes the Clerk frontend-API host in
        # its base64 payload. This shape matches the live key for
        # edenobservability.com (``clerk.edenobservability.com$``).
        clerk_settings(
            clerk_jwks_url="",
            clerk_publishable_key="pk_live_Y2xlcmsuZWRlbm9ic2VydmFiaWxpdHkuY29tJA",
        )
        assert (
            clerk_auth._derive_jwks_url()
            == "https://clerk.edenobservability.com/.well-known/jwks.json"
        )

    def test_returns_none_when_unconfigured(self, clerk_settings):
        clerk_settings(
            clerk_jwks_url="",
            clerk_publishable_key="",
            clerk_jwt_key="",
        )
        assert clerk_auth._derive_jwks_url() is None

    def test_returns_none_for_unparseable_publishable_key(self, clerk_settings):
        clerk_settings(
            clerk_jwks_url="",
            clerk_publishable_key="pk_live_!!!not_base64!!!",
        )
        assert clerk_auth._derive_jwks_url() is None


class TestVerifyClerkToken:
    @pytest.mark.asyncio
    async def test_returns_none_when_no_keys_configured(self, clerk_settings, caplog):
        # B-6 (Session 23): verify_clerk_token is async; await it.
        clerk_settings(
            clerk_secret_key="",
            clerk_jwt_key="",
            clerk_jwks_url="",
            clerk_publishable_key="",
        )
        with caplog.at_level("WARNING"):
            assert await clerk_auth.verify_clerk_token("anything") is None

    @pytest.mark.asyncio
    async def test_returns_none_for_malformed_token(self, clerk_settings):
        # B-6 (Session 23): verify_clerk_token is async; await it.
        # secret_key is set so the early-return doesn't trigger; the
        # malformed token must still be rejected cleanly without
        # raising into the request thread.
        clerk_settings(
            clerk_secret_key="sk_live_anything",
            clerk_jwt_key="",
            clerk_publishable_key="",
        )
        assert await clerk_auth.verify_clerk_token("not-a-jwt") is None

    def test_extract_user_id_falls_through_claim_chain(self):
        # Standard Clerk payload uses ``sub``; some accounts mint
        # tokens with ``user_id`` or ``uid``. The helper accepts all
        # three shapes without a settings dep.
        assert clerk_auth.extract_user_id({"sub": "u1"}) == "u1"
        assert clerk_auth.extract_user_id({"user_id": "u2"}) == "u2"
        assert clerk_auth.extract_user_id({"uid": "u3"}) == "u3"
        assert clerk_auth.extract_user_id({}) is None

    def test_clerk_payload_detection(self):
        dev = {"iss": "https://modest-bug-7.clerk.accounts.dev$"}
        prod = {"iss": "https://clerk.edenobservability.com"}
        other = {"iss": "https://example.com"}
        assert clerk_auth.is_clerk_payload(dev) is True
        assert clerk_auth.is_clerk_payload(prod) is True
        assert clerk_auth.is_clerk_payload(other) is False

    def test_public_key_from_jwk_accepts_jwks_dict(self):
        # Minimal RSA public JWK (PyJWT test vector). Passing the raw
        # dict to jwt.decode raises TypeError on PyJWT 2.13+.
        jwk = {
            "kty": "RSA",
            "kid": "test",
            "use": "sig",
            "n": (
                "0vx7agoebGcQSuuPiLJXZptN9nndrQckP"
                "VkbSSzAoiUbI3G0F7CXi8syBi5zTgY6K1"
                "TCnzMokNW6zT3BnYg6hVJDUin18zjF3"
                "rYxuJ8oo1AJaNWQ9w-8Kvw"
            ),
            "e": "AQAB",
        }
        key = clerk_auth._public_key_from_jwk(jwk)
        assert key is not None
