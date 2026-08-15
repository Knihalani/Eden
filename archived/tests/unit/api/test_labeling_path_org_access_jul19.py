"""Labeling routes require path-org membership (cross-org IDOR guard)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.routes import labeling as labeling_routes
from eden.evaluation.labeling import IAAReport


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

    def test_skip_bulk_cross_org_403(self) -> None:
        client = _app_with_cross_org_denial()
        r = client.post(
            "/orgs/org-B/labeling/skip/bulk",
            json={"item_ids": ["00000000-0000-0000-0000-000000000001"]},
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


@pytest.mark.asyncio
async def test_skip_bulk_member_calls_service(monkeypatch) -> None:
    """FEAT-117: bulk skip passes org, annotator, and item ids to the service."""
    from httpx import ASGITransport, AsyncClient

    captured: dict[str, object] = {}

    class _StubSvc:
        def __init__(self, *_a, **_k) -> None:
            pass

        async def skip_bulk(
            self,
            *,
            org_id: str,
            item_ids: list[str],
            annotator_id: str,
            reason: str | None = None,
        ) -> int:
            captured["org_id"] = org_id
            captured["item_ids"] = item_ids
            captured["annotator_id"] = annotator_id
            captured["reason"] = reason
            return len(item_ids)

    application = FastAPI()
    application.include_router(labeling_routes.router)
    application.dependency_overrides[require_path_org_access] = lambda: "org-1"
    application.dependency_overrides[get_current_user] = lambda: {"user_id": "u-9"}

    monkeypatch.setattr(
        labeling_routes,
        "get_postgres_client",
        AsyncMock(return_value=MagicMock()),
    )
    monkeypatch.setattr(labeling_routes, "LabelingService", _StubSvc)

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.post(
            "/orgs/org-1/labeling/skip/bulk",
            json={
                "item_ids": ["item-a", "item-b"],
                "reason": "ambiguous",
            },
        )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"skipped": True, "skipped_count": 2}
    assert captured == {
        "org_id": "org-1",
        "item_ids": ["item-a", "item-b"],
        "annotator_id": "u-9",
        "reason": "ambiguous",
    }


@pytest.mark.asyncio
async def test_queue_agreement_uses_real_iaa_engine(monkeypatch) -> None:
    """FEAT-79: ``GET /queues/{id}/agreement`` must route through the
    real ``LabelingService.compute_iaa`` (backed by the annotations
    table), not the dead ``label_a``/``label_b`` payload-key IAA path
    that always reported zeros because nothing ever wrote those keys.
    """
    from httpx import ASGITransport, AsyncClient

    from eden.evaluation import labeling_queues as labeling_queues_module

    captured: dict[str, object] = {}

    class _StubQueueSvc:
        def __init__(self, *_a, **_k) -> None:
            pass

        async def kanban_board(self, org_id: str, queue_id: str, *, limit: int = 100):
            captured["board_org_id"] = org_id
            captured["board_queue_id"] = queue_id
            return {
                "todo": [{"id": "item-1"}],
                "in_progress": [],
                "done": [{"id": "item-2"}],
                "skipped": [],
            }

    class _StubLabelingSvc:
        def __init__(self, *_a, **_k) -> None:
            pass

        async def compute_iaa(self, *, org_id: str, item_ids):
            captured["org_id"] = org_id
            captured["item_ids"] = sorted(item_ids)
            return IAAReport(
                kappa=0.75,
                alpha=0.7,
                overall_agreement=0.9,
                item_count=2,
                annotation_count=4,
            )

    application = FastAPI()
    application.include_router(labeling_routes.router)
    application.dependency_overrides[require_path_org_access] = lambda: "org-1"
    application.dependency_overrides[get_current_user] = lambda: {"user_id": "u-1"}

    monkeypatch.setattr(
        labeling_routes,
        "get_postgres_client",
        AsyncMock(return_value=MagicMock()),
    )
    monkeypatch.setattr(labeling_routes, "LabelingService", _StubLabelingSvc)
    monkeypatch.setattr(labeling_queues_module, "LabelingQueueService", _StubQueueSvc)

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.get("/orgs/org-1/labeling/queues/q-1/agreement")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Real, non-zero numbers — the whole point of FEAT-79.
    assert body["iaa"]["kappa"] == 0.75
    assert body["iaa"]["n"] == 4
    assert body["iaa"]["agreement_rate"] == 0.9
    assert captured["item_ids"] == ["item-1", "item-2"]
    assert captured["org_id"] == "org-1"

    # The old `/iaa` path no longer exists.
    resp_old = await AsyncClient(
        transport=ASGITransport(app=application), base_url="http://test"
    ).get("/orgs/org-1/labeling/queues/q-1/iaa")
    assert resp_old.status_code == 404
