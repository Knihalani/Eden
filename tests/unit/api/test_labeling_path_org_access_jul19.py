"""Labeling routes require path-org membership (cross-org IDOR guard)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.routes import labeling as labeling_routes


def _app_with_cross_org_denial() -> TestClient:
    app = FastAPI()
    app.include_router(labeling_routes.router)

    async def _deny_path_org() -> str:
        raise HTTPException(status_code=403, detail="Not a member of this organization")

    app.dependency_overrides[require_path_org_access] = _deny_path_org
    app.dependency_overrides[get_current_user] = lambda: {
        "user_id": "u-1",
        "email": "x@y.z",
    }
    return TestClient(app)


class TestLabelingPathOrgAccess:
    def test_router_depends_on_require_path_org(self) -> None:
        app = FastAPI()
        app.include_router(labeling_routes.router)
        any_check = False
        for route in app.routes:
            if not hasattr(route, "dependant"):
                continue
            stack = [route.dependant]
            while stack:
                d = stack.pop()
                stack.extend(d.dependencies)
                if d.call is require_path_org_access:
                    any_check = True
                    break
            if any_check:
                break
        assert any_check, (
            "labeling routes must Depends(require_path_org_access) for path org membership"
        )

    def test_list_items_cross_org_403(self) -> None:
        client = _app_with_cross_org_denial()
        r = client.get("/orgs/org-B/labeling/items")
        assert r.status_code == 403, r.text

    def test_seed_item_cross_org_403(self) -> None:
        client = _app_with_cross_org_denial()
        r = client.post(
            "/orgs/org-B/labeling/items",
            json={"payload": {}, "label_schema": {}},
        )
        assert r.status_code == 403, r.text

    def test_annotate_cross_org_403(self) -> None:
        client = _app_with_cross_org_denial()
        r = client.post(
            "/orgs/org-B/labeling/annotate",
            json={"item_id": "00000000-0000-0000-0000-000000000001", "label": "up"},
        )
        assert r.status_code == 403, r.text

    def test_skip_cross_org_403(self) -> None:
        client = _app_with_cross_org_denial()
        r = client.post(
            "/orgs/org-B/labeling/skip",
            json={"item_id": "00000000-0000-0000-0000-000000000001"},
        )
        assert r.status_code == 403, r.text

    def test_list_queues_cross_org_403(self) -> None:
        client = _app_with_cross_org_denial()
        r = client.get("/orgs/org-B/labeling/queues")
        assert r.status_code == 403, r.text

    def test_create_queue_cross_org_403(self) -> None:
        client = _app_with_cross_org_denial()
        r = client.post(
            "/orgs/org-B/labeling/queues",
            json={"name": "q1"},
        )
        assert r.status_code == 403, r.text

    def test_move_queue_item_cross_org_403(self) -> None:
        client = _app_with_cross_org_denial()
        r = client.post(
            "/orgs/org-B/labeling/queues/00000000-0000-0000-0000-000000000099/move",
            json={
                "item_id": "00000000-0000-0000-0000-000000000001",
                "status": "done",
            },
        )
        assert r.status_code == 403, r.text

    def test_export_cross_org_403(self) -> None:
        client = _app_with_cross_org_denial()
        r = client.get("/orgs/org-B/labeling/export")
        assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_list_items_member_uses_resolved_eden_org(monkeypatch) -> None:
    """Member path: require_path_org_access return value is the org passed to the service."""
    from httpx import ASGITransport, AsyncClient

    captured: dict[str, str] = {}

    class _StubSvc:
        def __init__(self, *_a, **_k) -> None:
            pass

        async def list_items(self, *, org_id: str, limit: int = 100, offset: int = 0):
            captured["org_id"] = org_id
            return [], 0

    application = FastAPI()
    application.include_router(labeling_routes.router)
    application.dependency_overrides[require_path_org_access] = (
        lambda: "eden-org-resolved"
    )
    application.dependency_overrides[get_current_user] = lambda: {
        "user_id": "u-1",
    }

    monkeypatch.setattr(
        labeling_routes,
        "get_postgres_client",
        AsyncMock(return_value=MagicMock()),
    )
    monkeypatch.setattr(labeling_routes, "LabelingService", _StubSvc)

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get("/orgs/path-org-clerk/labeling/items")

    assert resp.status_code == 200, resp.text
    assert captured["org_id"] == "eden-org-resolved"
