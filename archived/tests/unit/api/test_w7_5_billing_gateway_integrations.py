"""W7.5 — billing / gateway_models / webhooks: client errors must not 500.

Covers:
  - subscribe/cancel: HTTPException(400) + Stripe InvalidRequestError → 400
  - create_gateway_model: bad UUID → 400, other DB → 503 (not 500)
  - webhooks: non-UUID webhook_id → 404; create FK → 404; create UUID → 400
  - free-only invoices/payment-method gates stay 503 (Wave 6.3)
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

ORG = "00000000-0000-0000-0000-000000000001"
USER = "00000000-0000-0000-0000-000000000002"
WEBHOOK = "00000000-0000-0000-0000-0000000000aa"


# ── Billing subscribe / cancel ──────────────────────────────────────


@pytest.mark.asyncio
async def test_subscribe_unknown_plan_is_400_not_500(monkeypatch):
    from eden.api.routes import billing as mod

    monkeypatch.setattr(mod, "PAID_PLANS_ENABLED", True)
    monkeypatch.setattr(
        mod, "get_settings", lambda: MagicMock(stripe_secret_key="sk_test_x")
    )

    with pytest.raises(HTTPException) as ei:
        await mod.subscribe(
            request=mod.SubscribeRequest(
                plan_name="not-a-real-plan",
                success_url="https://example.com/ok",
                cancel_url="https://example.com/cancel",
            ),
            org_id=ORG,
            user={"user_id": USER},
            _check_billing_edit={},
        )
    assert ei.value.status_code == 400
    assert "Unknown plan" in ei.value.detail


@pytest.mark.asyncio
async def test_subscribe_stripe_invalid_request_is_400(monkeypatch):
    from eden.api.routes import billing as mod

    class InvalidRequestError(Exception):
        http_status = 400

    monkeypatch.setattr(mod, "PAID_PLANS_ENABLED", True)
    monkeypatch.setattr(
        mod, "get_settings", lambda: MagicMock(stripe_secret_key="sk_test_x")
    )
    monkeypatch.setattr(
        mod,
        "get_postgres_client",
        AsyncMock(
            return_value=MagicMock(
                fetchrow=AsyncMock(
                    return_value={"name": "Acme", "settings": {"stripe_customer_id": "cus_x"}},
                ),
                transaction=MagicMock(
                    return_value=AsyncMock(
                        __aenter__=AsyncMock(return_value=None),
                        __aexit__=AsyncMock(return_value=None),
                    )
                ),
            )
        ),
    )

    async def _boom(*_a, **_k):
        raise InvalidRequestError("No such customer: cus_x")

    monkeypatch.setattr(mod, "_stripe_call", _boom)
    # Ensure PLAN_DEFINITIONS has a known key so we reach Stripe.
    plan_name = next(iter(mod.PLAN_DEFINITIONS))

    with pytest.raises(HTTPException) as ei:
        await mod.subscribe(
            request=mod.SubscribeRequest(
                plan_name=plan_name,
                success_url="https://example.com/ok",
                cancel_url="https://example.com/cancel",
            ),
            org_id=ORG,
            user={"user_id": USER},
            _check_billing_edit={},
        )
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_subscribe_missing_org_is_404(monkeypatch):
    from eden.api.routes import billing as mod

    monkeypatch.setattr(mod, "PAID_PLANS_ENABLED", True)
    monkeypatch.setattr(
        mod, "get_settings", lambda: MagicMock(stripe_secret_key="sk_test_x")
    )
    monkeypatch.setattr(
        mod,
        "get_postgres_client",
        AsyncMock(return_value=MagicMock(fetchrow=AsyncMock(return_value=None))),
    )
    plan_name = next(iter(mod.PLAN_DEFINITIONS))

    with pytest.raises(HTTPException) as ei:
        await mod.subscribe(
            request=mod.SubscribeRequest(
                plan_name=plan_name,
                success_url="https://example.com/ok",
                cancel_url="https://example.com/cancel",
            ),
            org_id=ORG,
            user={"user_id": USER},
            _check_billing_edit={},
        )
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_cancel_no_subscription_is_400_not_500(monkeypatch):
    from eden.api.routes import billing as mod

    monkeypatch.setattr(mod, "PAID_PLANS_ENABLED", True)
    monkeypatch.setattr(
        mod, "get_settings", lambda: MagicMock(stripe_secret_key="sk_test_x")
    )
    monkeypatch.setattr(mod, "get_org_plan", AsyncMock(return_value=None))

    with pytest.raises(HTTPException) as ei:
        await mod.cancel_subscription(
            org_id=ORG,
            user={"user_id": USER},
            _check_billing_edit={},
        )
    assert ei.value.status_code == 400
    assert "No active subscription" in ei.value.detail


@pytest.mark.asyncio
async def test_cancel_stripe_invalid_request_is_400(monkeypatch):
    from eden.api.routes import billing as mod

    class InvalidRequestError(Exception):
        http_status = 400

    monkeypatch.setattr(mod, "PAID_PLANS_ENABLED", True)
    monkeypatch.setattr(
        mod, "get_settings", lambda: MagicMock(stripe_secret_key="sk_test_x")
    )
    monkeypatch.setattr(
        mod,
        "get_org_plan",
        AsyncMock(return_value={"stripe_subscription_id": "sub_bad"}),
    )

    async def _boom(*_a, **_k):
        raise InvalidRequestError("No such subscription: sub_bad")

    monkeypatch.setattr(mod, "_stripe_call", _boom)

    with pytest.raises(HTTPException) as ei:
        await mod.cancel_subscription(
            org_id=ORG,
            user={"user_id": USER},
            _check_billing_edit={},
        )
    assert ei.value.status_code == 400


def test_free_only_invoices_and_payment_method_still_503(monkeypatch):
    """Wave 6.3 gate must remain; W7.5 must not reopen paid Stripe reads."""
    from eden.api.routes import billing as mod

    assert mod.PAID_PLANS_ENABLED is False
    with pytest.raises(HTTPException) as ei_inv:
        mod._require_paid_plans_enabled()
    assert ei_inv.value.status_code == 503

    # Source-level: paid read endpoints still call the gate.
    import inspect

    assert "_require_paid_plans_enabled" in inspect.getsource(mod.get_invoices)
    assert "_require_paid_plans_enabled" in inspect.getsource(mod.get_payment_method)


# ── Gateway models ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_gateway_model_bad_uuid_is_400():
    from eden.api.routes import gateway_models as mod

    member = SimpleNamespace(org_id=ORG, user_id=USER, role="owner")
    body = mod.GatewayModelCreate(
        name="gpt-test",
        provider="openai",
        upstream_model="gpt-4o",
        upstream_api_key="sk-x",
    )

    with patch.object(
        mod.registry_store,
        "create_model",
        AsyncMock(
            side_effect=Exception('invalid input syntax for type uuid: "org_bad"')
        ),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.create_gateway_model(body=body, member=member, org_id=ORG)
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_create_gateway_model_other_db_is_503_not_500():
    from eden.api.routes import gateway_models as mod

    member = SimpleNamespace(org_id=ORG, user_id=USER, role="owner")
    body = mod.GatewayModelCreate(
        name="gpt-test",
        provider="openai",
        upstream_model="gpt-4o",
        upstream_api_key="sk-x",
    )

    with patch.object(
        mod.registry_store,
        "create_model",
        AsyncMock(side_effect=Exception("connection reset by peer")),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.create_gateway_model(body=body, member=member, org_id=ORG)
        assert ei.value.status_code == 503


# ── Webhooks ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_webhook_non_uuid_is_404_not_500():
    from eden.api.routes import webhooks as mod

    with pytest.raises(HTTPException) as ei:
        await mod._get_webhook(ORG, "{webhook_id}")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_create_webhook_bad_uuid_is_400():
    from eden.api.routes import webhooks as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception('invalid input syntax for type uuid: "org_bad"')
    )

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        with pytest.raises(HTTPException) as ei:
            await mod.create_webhook(
                org_id="org_bad",
                request=mod.WebhookCreateRequest(
                    url="https://example.com/hook",
                    events=["job.completed"],
                ),
                user={"user_id": USER},
                _admin={},
            )
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_create_webhook_fk_is_404():
    from eden.api.routes import webhooks as mod

    client = MagicMock()
    client.execute = AsyncMock(
        side_effect=Exception(
            'insert or update on table "webhooks" violates foreign key constraint'
        )
    )

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        with pytest.raises(HTTPException) as ei:
            await mod.create_webhook(
                org_id=ORG,
                request=mod.WebhookCreateRequest(
                    url="https://example.com/hook",
                    events=["job.completed"],
                ),
                user={"user_id": USER},
                _admin={},
            )
        assert ei.value.status_code == 404
