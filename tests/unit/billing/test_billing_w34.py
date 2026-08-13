"""W3-4 billing-enablement tests (OOM 2026-08-12).

Covers:
  a. flag-off behaviour — billing_enabled=False / PAID_PLANS_ENABLED=False
     means subscribe / portal / invoices / cancel → 503.
  b. checkout-session creation (mocked Stripe) when flag is on.
  c. POST /billing/portal — customer-portal session (mocked Stripe).
  d. Usage meter computation — span_ingest rows via _emit_billing_events.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import (
    get_current_user,
    require_org_permission_dep,
    require_path_org_access,
)
from eden.api.routes import billing as billing_mod


# ── shared test fixture factory ───────────────────────────────────────────────


def _make_app(monkeypatch, *, stripe_key: str = "sk_test_x", paid_plans: bool = False) -> TestClient:
    """Minimal FastAPI app with billing routes and all auth stubbed out."""
    # Patch both possible flag paths.
    monkeypatch.setattr(billing_mod, "PAID_PLANS_ENABLED", paid_plans)
    monkeypatch.setattr(
        billing_mod,
        "get_settings",
        lambda: MagicMock(
            stripe_secret_key=stripe_key,
            billing_enabled=paid_plans,
        ),
    )

    async def _user():
        return {"id": "u1", "email": "t@test.io", "org_id": "org1"}

    async def _perm():
        return {"role": "owner"}

    app = FastAPI()
    app.include_router(billing_mod.router)
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[billing_mod.get_current_user] = _user
    app.dependency_overrides[require_path_org_access] = lambda: "org1"
    # Override every remaining dependency with the permissive stub so we don't
    # need to wire real auth.
    for route in app.routes:
        dependant = getattr(route, "dependant", None)
        if dependant is None:
            continue
        for dep in getattr(dependant, "dependencies", []):
            fn = dep.call
            if fn in (get_current_user, billing_mod.get_current_user):
                continue
            if fn is not None and fn not in app.dependency_overrides:
                app.dependency_overrides[fn] = _perm
    return TestClient(app)


# ── (a) flag-off → 503 ────────────────────────────────────────────────────────


class TestFlagOff:
    """All Stripe-backed endpoints must 503 while billing_enabled is False."""

    @pytest.fixture
    def client(self, monkeypatch):
        return _make_app(monkeypatch, paid_plans=False)

    def test_subscribe_503_when_flag_off(self, client):
        r = client.post(
            "/orgs/org1/billing/subscribe",
            json={"plan_name": "pro", "success_url": "https://e.dev/ok", "cancel_url": "https://e.dev/no"},
        )
        assert r.status_code == 503, r.text
        assert "not available" in r.json()["detail"].lower()

    def test_portal_503_when_flag_off(self, client):
        r = client.post(
            "/orgs/org1/billing/portal",
            json={"return_url": "https://e.dev/settings"},
        )
        assert r.status_code == 503, r.text

    def test_invoices_503_when_flag_off(self, client):
        r = client.get("/orgs/org1/billing/invoices")
        assert r.status_code == 503, r.text

    def test_cancel_503_when_flag_off(self, client):
        r = client.post("/orgs/org1/billing/cancel")
        assert r.status_code == 503, r.text

    def test_plans_200_regardless_of_flag(self, monkeypatch):
        """GET /plans is an informational read — must work flag-off."""
        from eden.services.usage_service import UsageService

        mock_budget = {
            "cost_usd": {"used": 0.5, "soft_limit": 3.2, "hard_limit": 4.0, "status": "ok"},
            "credits": {"used": 50, "soft_limit": 320, "hard_limit": 400, "status": "ok"},
            "tokens": {"used": 1000},
            "storage_mb": {"used": 10.0},
            "sandbox_seconds": {"used": 0.0},
        }
        monkeypatch.setattr(
            UsageService,
            "get_budget_status",
            AsyncMock(return_value=mock_budget),
        )

        async def _org_plan(_org_id):
            return None  # no plan row → fall back to org_free

        monkeypatch.setattr(billing_mod, "get_org_plan", _org_plan)

        # Stub postgres so get_plans doesn't touch the real DB for resource limits
        stub_pg = MagicMock()
        stub_pg.fetchrow = AsyncMock(return_value=None)
        stub_pg.get_org_resource_limits = AsyncMock(return_value=None)
        stub_pg.set_org_resource_limits = AsyncMock(return_value=None)
        monkeypatch.setattr(billing_mod, "get_postgres_client", AsyncMock(return_value=stub_pg))

        client = _make_app(monkeypatch, paid_plans=False)
        r = client.get("/orgs/org1/billing/plans")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["plan_name"] in ("org_free", "individual_free")


# ── (b) checkout session creation (mocked Stripe) ────────────────────────────


class TestCheckoutSession:
    """Subscribe → Stripe checkout.Session.create (mocked)."""

    @pytest.fixture
    def pg_mock(self):
        """Postgres client stub that returns an org row with a Stripe customer."""
        stub = MagicMock()
        stub.fetchrow = AsyncMock(
            return_value={"name": "Acme", "settings": json.dumps({"stripe_customer_id": "cus_abc"})}
        )
        stub.execute = AsyncMock(return_value=None)
        stub.transaction = MagicMock(
            return_value=MagicMock(__aenter__=AsyncMock(return_value=None), __aexit__=AsyncMock(return_value=None))
        )
        return stub

    @pytest.fixture
    def stripe_mock(self):
        """Mock stripe module with checkout.Session.create."""
        session = MagicMock()
        session.url = "https://checkout.stripe.com/pay/test_session"
        session.id = "cs_test_abc"

        stripe = MagicMock()
        stripe.checkout.Session.create.return_value = session
        return stripe

    def test_subscribe_creates_checkout_session(self, monkeypatch, pg_mock, stripe_mock):
        monkeypatch.setattr(billing_mod, "PAID_PLANS_ENABLED", True)
        monkeypatch.setattr(
            billing_mod,
            "get_settings",
            lambda: MagicMock(stripe_secret_key="sk_test_x", billing_enabled=True),
        )
        monkeypatch.setattr(billing_mod, "get_postgres_client", AsyncMock(return_value=pg_mock))

        import builtins
        real_import = builtins.__import__

        def fake_import(name, *a, **kw):
            if name == "stripe":
                return stripe_mock
            return real_import(name, *a, **kw)

        monkeypatch.setattr(builtins, "__import__", fake_import)

        client = _make_app(monkeypatch, paid_plans=True, stripe_key="sk_test_x")
        r = client.post(
            "/orgs/org1/billing/subscribe",
            json={
                "plan_name": "pro",
                "success_url": "https://e.dev/ok",
                "cancel_url": "https://e.dev/no",
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["checkout_url"] == "https://checkout.stripe.com/pay/test_session"
        assert body["session_id"] == "cs_test_abc"


# ── (c) customer portal session (mocked Stripe) ──────────────────────────────


class TestPortalSession:
    """POST /billing/portal → Stripe billing_portal.Session.create (mocked)."""

    @pytest.fixture
    def pg_mock(self):
        stub = MagicMock()
        stub.fetchrow = AsyncMock(
            return_value={"settings": json.dumps({"stripe_customer_id": "cus_portal_abc"})}
        )
        return stub

    @pytest.fixture
    def stripe_mock(self):
        session = MagicMock()
        session.url = "https://billing.stripe.com/session/portal_abc"
        stripe = MagicMock()
        stripe.billing_portal.Session.create.return_value = session
        return stripe

    def test_portal_returns_url_when_enabled(self, monkeypatch, pg_mock, stripe_mock):
        monkeypatch.setattr(billing_mod, "PAID_PLANS_ENABLED", True)
        monkeypatch.setattr(
            billing_mod,
            "get_settings",
            lambda: MagicMock(stripe_secret_key="sk_test_x", billing_enabled=True),
        )
        monkeypatch.setattr(billing_mod, "get_postgres_client", AsyncMock(return_value=pg_mock))

        import builtins
        real_import = builtins.__import__

        def fake_import(name, *a, **kw):
            if name == "stripe":
                return stripe_mock
            return real_import(name, *a, **kw)

        monkeypatch.setattr(builtins, "__import__", fake_import)

        client = _make_app(monkeypatch, paid_plans=True, stripe_key="sk_test_x")
        r = client.post(
            "/orgs/org1/billing/portal",
            json={"return_url": "https://app.eden.dev/settings"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["portal_url"] == "https://billing.stripe.com/session/portal_abc"

    def test_portal_404_when_no_customer(self, monkeypatch):
        """Org exists but has no stripe_customer_id → 404."""
        monkeypatch.setattr(billing_mod, "PAID_PLANS_ENABLED", True)
        monkeypatch.setattr(
            billing_mod,
            "get_settings",
            lambda: MagicMock(stripe_secret_key="sk_test_x", billing_enabled=True),
        )
        stub = MagicMock()
        stub.fetchrow = AsyncMock(return_value={"settings": json.dumps({})})
        monkeypatch.setattr(billing_mod, "get_postgres_client", AsyncMock(return_value=stub))

        import builtins
        real_import = builtins.__import__

        stripe_mock = MagicMock()

        def fake_import(name, *a, **kw):
            if name == "stripe":
                return stripe_mock
            return real_import(name, *a, **kw)

        monkeypatch.setattr(builtins, "__import__", fake_import)

        client = _make_app(monkeypatch, paid_plans=True, stripe_key="sk_test_x")
        r = client.post(
            "/orgs/org1/billing/portal",
            json={"return_url": "https://app.eden.dev/settings"},
        )
        assert r.status_code == 404, r.text

    def test_portal_503_when_no_stripe_key(self, monkeypatch):
        """billing_enabled=True but no Stripe key → 503."""
        monkeypatch.setattr(billing_mod, "PAID_PLANS_ENABLED", True)
        monkeypatch.setattr(
            billing_mod,
            "get_settings",
            lambda: MagicMock(stripe_secret_key="", billing_enabled=True),
        )
        client = _make_app(monkeypatch, paid_plans=True, stripe_key="")
        r = client.post(
            "/orgs/org1/billing/portal",
            json={"return_url": "https://app.eden.dev/settings"},
        )
        assert r.status_code == 503, r.text


# ── (d) usage meter — span_ingest rows ───────────────────────────────────────


class TestSpanIngestMeter:
    """_emit_billing_events should emit span_ingest + trace_ingest rows."""

    def _make_event(self, org_id: str, event_type: str, trace_id: str = "t1") -> Any:
        """Return a minimal TelemetryEvent-like object."""

        class _Ev:
            tenant_id = org_id
            event_id = "ev1"
            source_format = "sdk"
            model_version = None
            payload: dict = {}
            metrics: dict = {}
            attributes: dict = {}

        ev = _Ev()
        ev.event_type = event_type  # type: ignore[attr-defined]
        ev.trace_id = trace_id  # type: ignore[attr-defined]
        return ev

    def test_span_ingest_rows_emitted(self):
        """Non-LLM spans produce span_ingest + trace_ingest rows in the flush batch."""
        from eden.observability.telemetry_collector import TelemetryCollector

        flushed: list[dict] = []

        async def _run():
            collector = TelemetryCollector.__new__(TelemetryCollector)
            collector._billing_buffer = []
            collector._billing_buffer_lock = asyncio.Lock()
            collector._billing_flush_task = None

            async def _fake_flush(batch: list[dict]) -> None:
                flushed.extend(batch)

            collector._do_billing_flush = _fake_flush  # type: ignore[method-assign]

            from unittest.mock import AsyncMock
            from eden.services.usage_service import UsageService
            with patch.object(UsageService, "track_events_batch", new=AsyncMock(side_effect=lambda b: flushed.extend(b))) as _:
                events = [
                    self._make_event("org-a", "agent.run", trace_id="trace-1"),
                    self._make_event("org-a", "tool.call", trace_id="trace-1"),
                    self._make_event("org-a", "agent.run", trace_id="trace-2"),
                    self._make_event("org-b", "tool.call", trace_id="trace-3"),
                ]
                await collector._emit_billing_events(events)
                # Rows accumulate in the buffer; flush explicitly (pre-buffer tests
                # did not need this but post-merge the buffer must be drained first).
                await collector._flush_billing_buffer()

        asyncio.run(_run())

        span_rows = [r for r in flushed if r.get("event_type") == "span_ingest"]
        trace_rows = [r for r in flushed if r.get("event_type") == "trace_ingest"]

        # org-a: 3 spans, 2 unique traces; org-b: 1 span, 1 trace
        span_by_org = {r["org_id"]: r["quantity"] for r in span_rows}
        trace_by_org = {r["org_id"]: r["quantity"] for r in trace_rows}

        assert span_by_org.get("org-a") == 3.0
        assert span_by_org.get("org-b") == 1.0
        assert trace_by_org.get("org-a") == 2.0
        assert trace_by_org.get("org-b") == 1.0

    def test_llm_span_still_emits_llm_call_row(self):
        """LLM events still produce llm_call billing rows (regression guard)."""
        from eden.observability.telemetry_collector import TelemetryCollector

        flushed: list[dict] = []

        async def _run():
            collector = TelemetryCollector.__new__(TelemetryCollector)
            collector._billing_buffer = []
            collector._billing_buffer_lock = asyncio.Lock()
            collector._billing_flush_task = None

            with patch(
                "eden.services.usage_service.UsageService.track_events_batch",
                new=AsyncMock(side_effect=lambda b: flushed.extend(b)),
            ):
                ev = self._make_event("org-a", "llm.completion", trace_id="t1")
                ev.metrics = {"input_tokens": 100, "output_tokens": 50, "cost_usd": 0.001}  # type: ignore
                ev.payload = {"model_normalized": "gpt-4o"}  # type: ignore
                await collector._emit_billing_events([ev])
                # Rows accumulate in the buffer; flush explicitly before asserting.
                await collector._flush_billing_buffer()

        asyncio.run(_run())

        llm_rows = [r for r in flushed if r.get("event_type") == "llm_call"]
        assert len(llm_rows) >= 1, "Expected at least one llm_call row"
        assert llm_rows[0]["quantity"] == 150.0  # 100 + 50


# ── (e) billing_enabled config flag ──────────────────────────────────────────


class TestBillingEnabledFlag:
    """billing_enabled=True in settings gates paid routes (OOM W3-4)."""

    def test_config_flag_gates_subscribe(self, monkeypatch):
        """billing_enabled=True opens subscribe even with PAID_PLANS_ENABLED=False."""
        # Set PAID_PLANS_ENABLED=False but billing_enabled=True in settings.
        # _require_paid_plans_enabled checks either, so the route should pass
        # the flag check and reach Stripe (mocked to succeed).
        monkeypatch.setattr(billing_mod, "PAID_PLANS_ENABLED", False)
        monkeypatch.setattr(
            billing_mod,
            "get_settings",
            lambda: MagicMock(stripe_secret_key="sk_x", billing_enabled=True),
        )

        stub_pg = MagicMock()
        stub_pg.fetchrow = AsyncMock(return_value={"name": "X", "settings": json.dumps({"stripe_customer_id": "cus_y"})})
        stub_pg.execute = AsyncMock()
        stub_pg.transaction = MagicMock(
            return_value=MagicMock(__aenter__=AsyncMock(return_value=None), __aexit__=AsyncMock(return_value=None))
        )
        monkeypatch.setattr(billing_mod, "get_postgres_client", AsyncMock(return_value=stub_pg))

        import builtins
        real_import = builtins.__import__

        stripe_mock = MagicMock()
        stripe_mock.checkout.Session.create.return_value = MagicMock(
            url="https://checkout.stripe.com/x", id="cs_x"
        )

        def fake_import(name, *a, **kw):
            if name == "stripe":
                return stripe_mock
            return real_import(name, *a, **kw)

        monkeypatch.setattr(builtins, "__import__", fake_import)

        # Build a minimal app WITHOUT using _make_app so we control get_settings.
        async def _user():
            return {"id": "u1", "email": "t@test.io", "org_id": "org1"}

        async def _perm():
            return {"role": "owner"}

        app = FastAPI()
        app.include_router(billing_mod.router)
        app.dependency_overrides[get_current_user] = _user
        app.dependency_overrides[billing_mod.get_current_user] = _user
        app.dependency_overrides[require_path_org_access] = lambda: "org1"
        for route in app.routes:
            dependant = getattr(route, "dependant", None)
            if dependant is None:
                continue
            for dep in getattr(dependant, "dependencies", []):
                fn = dep.call
                if fn in (get_current_user, billing_mod.get_current_user):
                    continue
                if fn is not None and fn not in app.dependency_overrides:
                    app.dependency_overrides[fn] = _perm

        client = TestClient(app)
        r = client.post(
            "/orgs/org1/billing/subscribe",
            json={"plan_name": "pro", "success_url": "https://e.dev/ok", "cancel_url": "https://e.dev/no"},
        )
        # The route must NOT 503 with "paid plans not available" — flag check passed.
        assert r.status_code != 503 or "not available" not in r.json().get("detail", "").lower(), (
            f"Flag check failed — billing_enabled=True should have unlocked the route. "
            f"Got {r.status_code}: {r.text}"
        )
        # If we got 200, confirm the checkout URL is present.
        if r.status_code == 200:
            assert "checkout_url" in r.json()
