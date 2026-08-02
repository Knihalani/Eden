"""Wave 6 — public Stripe webhook path must not require JWT."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.middleware.default_deny import DEFAULT_PUBLIC_PREFIXES
from eden.api.routes import billing


def test_webhooks_prefix_is_public_allowlist() -> None:
    """default-deny must allow /webhooks/* without Authorization."""
    assert "/webhooks" in DEFAULT_PUBLIC_PREFIXES


def test_stripe_public_webhook_no_jwt_missing_signature_is_400() -> None:
    """POST /webhooks/stripe without JWT reaches the handler (not 401).

    Missing stripe-signature → 400. Proves the path is signature-gated,
    not JWT-gated.
    """
    app = FastAPI()
    app.include_router(billing.webhook_router)
    client = TestClient(app)

    with patch.object(
        billing,
        "get_settings",
        return_value=MagicMock(stripe_webhook_secret="whsec_test"),
    ):
        resp = client.post("/webhooks/stripe", content=b"{}")

    assert resp.status_code == 400
    assert "signature" in resp.text.lower()
    assert resp.status_code != 401


def test_stripe_public_webhook_no_jwt_unconfigured_secret_is_503() -> None:
    """Without webhook secret configured, still no JWT gate — 503."""
    app = FastAPI()
    app.include_router(billing.webhook_router)
    client = TestClient(app)

    with patch.object(
        billing,
        "get_settings",
        return_value=MagicMock(stripe_webhook_secret=""),
    ):
        resp = client.post(
            "/webhooks/stripe",
            content=b"{}",
            headers={"stripe-signature": "t=1,v1=deadbeef"},
        )

    assert resp.status_code == 503
    assert resp.status_code != 401
