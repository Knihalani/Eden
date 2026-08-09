"""FEAT-157 — artifact demotion activity API."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.routes import learn as learn_routes


def _app() -> FastAPI:
    app = FastAPI()

    async def _fake_user() -> dict:
        return {"user_id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(learn_routes.router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app())


def test_list_demotions_returns_gate_and_archived(client: TestClient) -> None:
    nudge_id = str(uuid4())
    fake_rows_gate = [
        {
            "candidate_id": uuid4(),
            "ref_id": nudge_id,
            "demoted_at": datetime(2026, 8, 6, tzinfo=UTC),
            "evidence": {"demote_reason": "7d_regression"},
            "artifact_id": nudge_id,
            "agent_id": "agent-a",
            "name": "bad-fix",
            "mode": "archived",
            "content": "Always refund immediately",
        }
    ]
    fake_rows_archived = [
        {
            "id": uuid4(),
            "agent_id": "agent-b",
            "name": "other-fix",
            "mode": "archived",
            "content": "Skip validation",
            "archived_at": datetime(2026, 8, 5, tzinfo=UTC),
            "evidence": {},
        }
    ]

    class _FakePg:
        async def fetch(self, query: str, *args):
            if "promotion_candidates" in query:
                return fake_rows_gate
            if "mode = 'archived'" in query:
                return fake_rows_archived
            return []

    with (
        patch.object(learn_routes, "artifacts_enabled", new=AsyncMock(return_value=True)),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=_FakePg()),
        ),
    ):
        resp = client.get("/orgs/org_1/artifacts/demotions")

    assert resp.status_code == 200, resp.text
    items = resp.json()["data"]["items"]
    assert len(items) >= 1
    assert items[0]["reason"] == "7d_regression"
    assert items[0]["source"] == "evidence_gate"


def test_list_demotions_empty_when_no_db(client: TestClient) -> None:
    with (
        patch.object(learn_routes, "artifacts_enabled", new=AsyncMock(return_value=True)),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ),
    ):
        resp = client.get("/orgs/org_1/artifacts/demotions")
    assert resp.status_code == 200
    assert resp.json()["data"]["items"] == []
