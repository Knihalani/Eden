"""Server-side tests for the new billing payment-method route (Phase A.3):

  - GET /orgs/{org_id}/billing/payment-method

The tests build a minimal FastAPI app with the real routes mounted and
override the postgres client + auth dependency. Stripe is mocked by
monkeypatching the ``stripe`` module inside the route.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from eden.api.routes import billing

# ── Stub postgres client ──────────────────────────────────────────


class _StubPostgresClient:
    """In-memory stub for the SELECT FROM organizations that
    ``get_payment_method`` issues."""

    def __init__(self, settings: dict[str, Any] | None = None) -> None:
        self._settings = settings  # may be None → return no row

    async def fetchrow(self, query: str, *args, **kwargs):
        if "FROM organizations" in query and "settings" in query:
            if self._settings is None:
                return None
            return {"settings": json.dumps(self._settings)}
        return None


# ── Test fixtures ───────────────────────────────────────────────


def _make_stripe_mock(
    *,
    customer_exists: bool = True,
    default_pm_exists: bool = True,
    brand: str = "visa",
    last4: str = "4242",
    exp_month: int = 12,
    exp_year: int = 2027,
) -> MagicMock:
    """Build a mock ``stripe`` module matching the route's call pattern.

    The route does:
        stripe.Customer.retrieve(customer_id)          → .invoice_settings.default_payment_method.id
        stripe.PaymentMethod.retrieve(default_pm_id)   → .card.{brand, last4, exp_month, exp_year}
    """
    pm_obj = MagicMock()
    pm_obj.card.brand = brand
    pm_obj.card.last4 = last4
    pm_obj.card.exp_month = exp_month
    pm_obj.card.exp_year = exp_year

    customer = MagicMock()
    if default_pm_exists:
        customer.invoice_settings.default_payment_method.id = "pm_test_123"
    else:
        # No default payment method
        del customer.invoice_settings.default_payment_method.id
        # Make it raise on .id to mirror real behavior
        type(customer.invoice_settings.default_payment_method).id = property(
            lambda self: (_ for _ in ()).throw(
                AttributeError("no default_payment_method")
            )
        )

    stripe = MagicMock()
    stripe.Customer.retrieve.return_value = customer
    stripe.PaymentMethod.retrieve.return_value = pm_obj
    return stripe


@pytest.fixture
def app(monkeypatch):
    """Build a FastAPI app with billing routes + stubbed deps."""

    # Mock settings to have a stripe_secret_key (lazy get_settings path).
    fake_settings = MagicMock(stripe_secret_key="sk_test_xxx")
    monkeypatch.setattr(billing, "get_settings", lambda: fake_settings)

    # Auth: stub require_org_permission to a no-op (the route's auth
    # bypasses the Depends() chain by calling require_org_permission
    # as a function). We override at the deps-module level so both
    # `billing` and `eden_deps` references see the noop.
    from eden.api import deps as eden_deps

    async def _noop_perm(*args, **kwargs):
        return None
    monkeypatch.setattr(eden_deps, "require_org_permission", _noop_perm)
    monkeypatch.setattr(billing, "require_org_permission", _noop_perm)

    async def _get_user():
        return {"id": "u-test", "email": "t@test.io", "org_id": "org-test"}

    async def _path_org():
        return "org-test"

    app = FastAPI()
    app.include_router(billing.router)
    # Key the override on the function object the route captured
    # (i.e. billing.get_current_user, which is the same object as
    # deps.get_current_user at import time).
    app.dependency_overrides[billing.get_current_user] = _get_user
    app.dependency_overrides[billing.require_path_org_access] = _path_org
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


# ── Tests ────────────────────────────────────────────────────────


def test_payment_method_no_stripe_config(client, monkeypatch):
    """No Stripe key → returns None (not 404 or 500)."""
    monkeypatch.setattr(
        billing, "get_settings",
        lambda: MagicMock(stripe_secret_key=None),
    )
    resp = client.get("/orgs/org-test/billing/payment-method")
    assert resp.status_code == 200
    assert resp.json() is None


def test_payment_method_no_customer_id(client, app, monkeypatch):
    """Org has no stripe_customer_id in settings → returns None."""
    # No stripe import needed when org has no customer id
    async def _get_pg():
        return _StubPostgresClient(settings={"plan_name": "free"})
    monkeypatch.setattr(billing, "get_postgres_client", _get_pg)

    resp = client.get("/orgs/org-test/billing/payment-method")
    assert resp.status_code == 200
    assert resp.json() is None


def test_payment_method_no_org_row(client, app, monkeypatch):
    """Org row missing → returns None."""
    async def _get_pg():
        return _StubPostgresClient(settings=None)
    monkeypatch.setattr(billing, "get_postgres_client", _get_pg)

    resp = client.get("/orgs/org-test/billing/payment-method")
    assert resp.status_code == 200
    assert resp.json() is None


def test_payment_method_with_card(client, app, monkeypatch):
    """Happy path: org has customer + default payment method → returns card."""
    async def _get_pg():
        return _StubPostgresClient(settings={"stripe_customer_id": "cus_test_123"})
    monkeypatch.setattr(billing, "get_postgres_client", _get_pg)

    # Inject the mock stripe module
    import sys
    fake_stripe = _make_stripe_mock(
        brand="visa", last4="4242", exp_month=12, exp_year=2027,
    )
    monkeypatch.setitem(sys.modules, "stripe", fake_stripe)

    resp = client.get("/orgs/org-test/billing/payment-method")
    assert resp.status_code == 200
    body = resp.json()
    assert body["brand"] == "visa"
    assert body["last4"] == "4242"
    assert body["exp_month"] == 12
    assert body["exp_year"] == 2027


def test_payment_method_no_default_pm(client, app, monkeypatch):
    """Customer exists but has no default payment method → returns None."""
    async def _get_pg():
        return _StubPostgresClient(settings={"stripe_customer_id": "cus_test_123"})
    monkeypatch.setattr(billing, "get_postgres_client", _get_pg)

    import sys
    fake_stripe = _make_stripe_mock(default_pm_exists=False)
    monkeypatch.setitem(sys.modules, "stripe", fake_stripe)

    resp = client.get("/orgs/org-test/billing/payment-method")
    assert resp.status_code == 200
    assert resp.json() is None


def test_payment_method_stripe_api_error(client, app, monkeypatch):
    """Stripe raises an exception → route catches and returns None."""
    async def _get_pg():
        return _StubPostgresClient(settings={"stripe_customer_id": "cus_test_123"})
    monkeypatch.setattr(billing, "get_postgres_client", _get_pg)

    import sys
    fake_stripe = MagicMock()
    fake_stripe.Customer.retrieve.side_effect = RuntimeError("stripe down")
    monkeypatch.setitem(sys.modules, "stripe", fake_stripe)

    resp = client.get("/orgs/org-test/billing/payment-method")
    assert resp.status_code == 200
    assert resp.json() is None
