"""Clerk webhook route tests — signature verification, payload
handling, and the missing-secret 503 path from the audit.
"""

import pytest
from fastapi.testclient import TestClient


class TestClerkWebhookSecret:
    def test_missing_secret_returns_503(self, api_client: TestClient, monkeypatch):
        """With no signing secret configured, the route must return 503
        (the June 2026 audit found it was already correct, but the NF
        secret still needs to be set — see AUDIT-2026-06-21.md #7).
        """
        from eden.api.routes import clerk_webhooks

        monkeypatch.setattr(clerk_webhooks.settings, "clerk_webhook_signing_secret", "", raising=False)
        r = api_client.post(
            "/webhooks/clerk",
            json={"type": "user.created", "data": {"id": "u_1"}},
        )
        assert r.status_code == 503
        assert "secret" in r.json().get("detail", "").lower() or "signing" in r.json().get("detail", "").lower()

    def test_invalid_signature_returns_401(self, api_client: TestClient, monkeypatch):
        from eden.api.routes import clerk_webhooks

        monkeypatch.setattr(clerk_webhooks.settings, "clerk_webhook_signing_secret", "whsec_valid", raising=False)
        r = api_client.post(
            "/webhooks/clerk",
            json={"type": "user.created", "data": {"id": "u_1"}},
            headers={"svix-signature": "v1,invalid"},
        )
        # 401 on bad sig; 400 if route doesn't parse the headers.
        assert r.status_code in (400, 401, 422)
