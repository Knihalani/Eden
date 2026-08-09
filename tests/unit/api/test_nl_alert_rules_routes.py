"""NL-alert rule CRUD routes (FEAT-18).

The backend for the NL-alert authoring pipeline (compile + full rule
CRUD) has existed since F81, but nothing in the portal called it — a
customer couldn't create a working NL alert rule through the product
at all. These tests pin down the route-level contract the new portal
authoring UI (``clients/portal/src/lab/alerts-panel.tsx``,
``AlertRulesView``) depends on.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from eden.alerts import routes as alerts_routes
from eden.api.deps import _try_resolve_token_payload, get_current_user

ORG_ID = "f4dc4575-ebd5-47a2-8541-42b9e41c1148"


def _make_app() -> FastAPI:
    application = FastAPI()
    application.dependency_overrides[get_current_user] = lambda: {"user_id": "user-1"}
    application.dependency_overrides[_try_resolve_token_payload] = lambda: None
    application.include_router(alerts_routes.router)
    return application


@pytest.mark.asyncio
async def test_list_nl_alert_rules_returns_rules(monkeypatch):
    monkeypatch.setattr(
        alerts_routes,
        "_require_org_member",
        AsyncMock(return_value=ORG_ID),
    )
    rule = {
        "id": "rule-1",
        "name": "High error rate",
        "nl_text": "alert me when error rate exceeds 5% in the last hour",
        "compiled_eql": "SELECT * FROM traces WHERE error_rate > 0.05",
        "triage_enabled": True,
        "channels": {"email": True},
        "enabled": True,
        "last_fired_at": None,
        "created_at": "2026-08-01T00:00:00Z",
    }
    monkeypatch.setattr(
        alerts_routes.repo, "list_nl_rules", AsyncMock(return_value=[rule])
    )

    app = _make_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get(f"/orgs/{ORG_ID}/nl-alert-rules")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 1
    assert body["rules"][0]["name"] == "High error rate"


@pytest.mark.asyncio
async def test_create_nl_alert_rule_saves_and_compiles(monkeypatch):
    monkeypatch.setattr(
        alerts_routes,
        "_require_org_admin",
        AsyncMock(return_value=ORG_ID),
    )
    monkeypatch.setattr(
        alerts_routes, "eden_user_id_from_auth", AsyncMock(return_value="user-1")
    )

    created_rule = {
        "id": "rule-2",
        "name": "High error rate",
        "nl_text": "alert me when error rate exceeds 5%",
        "compiled_eql": "SELECT * FROM traces WHERE error_rate > 0.05",
        "triage_enabled": True,
        "channels": {"email": True, "slack": False},
        "enabled": True,
        "last_fired_at": None,
        "created_at": "2026-08-01T00:00:00Z",
    }
    create_mock = AsyncMock(return_value=created_rule)
    monkeypatch.setattr(alerts_routes.repo, "create_nl_rule", create_mock)

    compile_mock = AsyncMock(return_value={"alert_id": "alert-1"})
    alert_as_code_cls = MagicMock(return_value=MagicMock(compile=compile_mock))
    monkeypatch.setattr(alerts_routes, "AlertAsCode", alert_as_code_cls)

    app = _make_app()
    transport = ASGITransport(app=app)
    payload = {
        "name": "High error rate",
        "nl_text": "alert me when error rate exceeds 5%",
        "compiled_eql": "SELECT * FROM traces WHERE error_rate > 0.05",
        "severity": "warning",
        "channels": {"email": True, "slack": False},
        "interval_seconds": 3600,
    }
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.post(f"/orgs/{ORG_ID}/nl-alert-rules", json=payload)

    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == "rule-2"

    create_mock.assert_awaited_once()
    _, kwargs = create_mock.call_args
    assert kwargs["org_id"] == ORG_ID
    assert kwargs["name"] == "High error rate"
    assert kwargs["compiled_eql"] == "SELECT * FROM traces WHERE error_rate > 0.05"
    assert kwargs["channels"] == {"email": True, "slack": False}
    assert kwargs["severity"] == "warning"

    compile_mock.assert_awaited_once()
    _, compile_kwargs = compile_mock.call_args
    assert compile_kwargs["name"] == "High error rate"
    assert compile_kwargs["severity"] == "warning"


@pytest.mark.asyncio
async def test_update_nl_alert_rule_missing_is_404(monkeypatch):
    monkeypatch.setattr(
        alerts_routes,
        "_require_org_admin",
        AsyncMock(return_value=ORG_ID),
    )
    monkeypatch.setattr(
        alerts_routes.repo, "update_nl_rule", AsyncMock(return_value=None)
    )

    app = _make_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.patch(
            f"/orgs/{ORG_ID}/nl-alert-rules/missing-rule",
            json={"enabled": False},
        )

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_nl_alert_rule_ok(monkeypatch):
    monkeypatch.setattr(
        alerts_routes,
        "_require_org_admin",
        AsyncMock(return_value=ORG_ID),
    )
    monkeypatch.setattr(
        alerts_routes.repo, "delete_nl_rule", AsyncMock(return_value=True)
    )

    app = _make_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.delete(f"/orgs/{ORG_ID}/nl-alert-rules/rule-1")

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "rule_id": "rule-1"}
