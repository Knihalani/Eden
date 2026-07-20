"""Billing route tests — focus on the audit-fixed stub paths
(``billing.py`` invoices: unconfigured Stripe returns ``[]``;
missing ``stripe`` package returns 503).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_org_permission_dep
from eden.api.routes import billing


def _billing_client(monkeypatch, *, stripe_secret_key: str) -> TestClient:
    """Minimal app with billing:view authz satisfied."""
    monkeypatch.setattr(
        billing,
        "settings",
        MagicMock(stripe_secret_key=stripe_secret_key),
        raising=False,
    )

    async def _get_user():
        return {"id": "u-test", "email": "t@test.io", "org_id": "test-org"}

    async def _billing_view():
        return {"id": "test-org", "role": "owner"}

    app = FastAPI()
    app.include_router(billing.router)
    app.dependency_overrides[get_current_user] = _get_user
    app.dependency_overrides[billing.get_current_user] = _get_user
    # require_org_permission_dep returns a new closure each call;
    # override every Depends call on the invoices route.
    view_dep = require_org_permission_dep("billing:view")
    app.dependency_overrides[view_dep] = _billing_view
    for route in app.routes:
        dependant = getattr(route, "dependant", None)
        if dependant is None:
            continue
        for dep in dependant.dependencies:
            if dep.call is get_current_user or dep.call is billing.get_current_user:
                continue
            if dep.call is not None:
                app.dependency_overrides[dep.call] = _billing_view
    return TestClient(app)


class TestBillingStubsRaise:
    def test_invoices_free_only_returns_503(self, monkeypatch):
        """While PAID_PLANS_ENABLED is False, invoices must 503 (not [])."""
        client = _billing_client(monkeypatch, stripe_secret_key="")
        r = client.get("/orgs/test-org/billing/invoices")
        assert r.status_code == 503, r.text
        assert "Paid plans are not available" in r.json()["detail"]

    def test_invoices_stripe_import_missing_returns_503(self, monkeypatch):
        """When paid plans are on but stripe package is missing, invoices 503."""
        import builtins

        from eden.api.routes import billing as billing_mod

        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "stripe" or name.startswith("stripe."):
                raise ImportError("simulated missing stripe")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        monkeypatch.setattr(
            billing_mod,
            "get_postgres_client",
            AsyncMock(
                return_value=MagicMock(
                    fetchrow=AsyncMock(
                        return_value={"settings": {"stripe_customer_id": "cus_x"}},
                    ),
                ),
            ),
        )
        monkeypatch.setattr(billing_mod, "PAID_PLANS_ENABLED", True)
        monkeypatch.setattr(
            billing_mod,
            "get_settings",
            lambda: MagicMock(stripe_secret_key="sk_test_x"),
        )

        client = _billing_client(monkeypatch, stripe_secret_key="sk_test_x")
        try:
            r = client.get("/orgs/test-org/billing/invoices")
            assert r.status_code == 503, r.text
        finally:
            monkeypatch.setattr(billing_mod, "PAID_PLANS_ENABLED", False)
