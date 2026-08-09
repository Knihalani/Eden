"""Alert suppression rule routes (FEAT-134)."""

from __future__ import annotations

from unittest.mock import AsyncMock

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
async def test_list_alert_suppression_rules_returns_rules(monkeypatch) -> None:
    monkeypatch.setattr(
        alerts_routes,
        "_require_org_member",
        AsyncMock(return_value=ORG_ID),
    )
    rule = {
        "id": "sup-1",
        "org_id": ORG_ID,
        "pattern": r"tuesday.?batch",
        "reason": "Known noisy Tuesday job",
        "window_hours": 24,
        "enabled": True,
        "created_by_user_id": "user-1",
        "created_at": "2026-08-01T00:00:00Z",
        "updated_at": "2026-08-01T00:00:00Z",
    }
    monkeypatch.setattr(
        alerts_routes.repo,
        "list_suppression_rules",
        AsyncMock(return_value=[rule]),
    )

    app = _make_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get(f"/orgs/{ORG_ID}/alert-suppression-rules")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 1
    assert body["rules"][0]["pattern"] == r"tuesday.?batch"


@pytest.mark.asyncio
async def test_create_alert_suppression_rule_requires_admin(monkeypatch) -> None:
    monkeypatch.setattr(
        alerts_routes,
        "_require_org_admin",
        AsyncMock(return_value=ORG_ID),
    )
    monkeypatch.setattr(
        alerts_routes, "eden_user_id_from_auth", AsyncMock(return_value="user-1")
    )
    created = {
        "id": "sup-2",
        "org_id": ORG_ID,
        "pattern": "batch",
        "reason": "nightly",
        "window_hours": None,
        "enabled": True,
        "created_by_user_id": "user-1",
        "created_at": "2026-08-01T00:00:00Z",
        "updated_at": "2026-08-01T00:00:00Z",
    }
    create_mock = AsyncMock(return_value=created)
    monkeypatch.setattr(alerts_routes.repo, "create_suppression_rule", create_mock)

    app = _make_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.post(
            f"/orgs/{ORG_ID}/alert-suppression-rules",
            json={"pattern": "batch", "reason": "nightly"},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == "sup-2"
    create_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_alert_suppression_rule_ok(monkeypatch) -> None:
    monkeypatch.setattr(
        alerts_routes,
        "_require_org_admin",
        AsyncMock(return_value=ORG_ID),
    )
    monkeypatch.setattr(
        alerts_routes.repo,
        "delete_suppression_rule",
        AsyncMock(return_value=True),
    )

    app = _make_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.delete(f"/orgs/{ORG_ID}/alert-suppression-rules/sup-1")

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "rule_id": "sup-1"}
