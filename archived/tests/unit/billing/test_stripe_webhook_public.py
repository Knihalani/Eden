"""Public Stripe webhook — no org-path auth; signature + idempotency."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.routes import billing


def _public_client() -> TestClient:
    app = FastAPI()
    app.include_router(billing.webhook_router)
    return TestClient(app)


class TestStripeWebhookPublicAuth:
    def test_missing_signature_returns_400(self, monkeypatch) -> None:
        monkeypatch.setattr(
            billing,
            "get_settings",
            lambda: MagicMock(stripe_webhook_secret="whsec_test"),
        )
        client = _public_client()
        r = client.post("/webhooks/stripe", content=b"{}")
        assert r.status_code == 400
        assert "signature" in r.json()["detail"].lower()

    def test_route_has_no_org_path_dependency(self) -> None:
        """Stripe cannot present JWT / org path access — path must be public."""
        routes = [
            r
            for r in billing.webhook_router.routes
            if getattr(r, "path", "") in ("/stripe", "/webhooks/stripe")
        ]
        assert routes, "expected POST /webhooks/stripe on webhook_router"
        # Router itself must not carry require_path_org_access.
        dep_calls = [
            getattr(d, "dependency", d)
            for d in (billing.webhook_router.dependencies or [])
        ]
        assert billing.require_path_org_access not in dep_calls
        assert not billing.webhook_router.dependencies

    def test_deprecated_org_webhook_returns_410(self, monkeypatch) -> None:
        async def _org():
            return "org_test"

        app = FastAPI()
        app.include_router(billing.router)
        app.dependency_overrides[billing.require_path_org_access] = _org
        # Override every Depends(require_path_org_access) on the router.
        for route in app.routes:
            dependant = getattr(route, "dependant", None)
            if dependant is None:
                continue
            for dep in dependant.dependencies:
                if dep.call is billing.require_path_org_access:
                    app.dependency_overrides[dep.call] = _org
        client = TestClient(app)
        r = client.post("/orgs/org_test/billing/webhook", content=b"{}")
        assert r.status_code == 410
        assert "/webhooks/stripe" in r.json()["detail"]


class TestStripeWebhookIdempotency:
    @pytest.mark.asyncio
    async def test_duplicate_event_skips_handler(self, monkeypatch) -> None:
        mock_pg = MagicMock()
        # ON CONFLICT DO NOTHING → no RETURNING row
        mock_pg.fetchrow = AsyncMock(return_value=None)
        monkeypatch.setattr(
            billing, "get_postgres_client", AsyncMock(return_value=mock_pg)
        )
        handled = AsyncMock()
        monkeypatch.setattr(billing, "handle_subscription_event", handled)
        monkeypatch.setattr(billing, "PAID_PLANS_ENABLED", True)

        result = await billing._process_stripe_webhook_event(
            {
                "id": "evt_dup",
                "type": "customer.subscription.updated",
                "data": {"object": {"id": "sub_1"}},
            }
        )
        assert result["duplicate"] is True
        handled.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_paid_disabled_logs_without_plan_sync(self, monkeypatch) -> None:
        mock_pg = MagicMock()
        mock_pg.fetchrow = AsyncMock(return_value={"stripe_event_id": "evt_1"})
        monkeypatch.setattr(
            billing, "get_postgres_client", AsyncMock(return_value=mock_pg)
        )
        handled = AsyncMock()
        monkeypatch.setattr(billing, "handle_subscription_event", handled)
        monkeypatch.setattr(billing, "PAID_PLANS_ENABLED", False)

        result = await billing._process_stripe_webhook_event(
            {
                "id": "evt_1",
                "type": "customer.subscription.updated",
                "data": {"object": {"id": "sub_1"}},
            }
        )
        assert result["received"] is True
        assert result.get("processed") is False
        handled.assert_not_awaited()
