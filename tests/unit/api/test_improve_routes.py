"""N17 improve API route smoke."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.routes import improve as improve_routes
from eden.improvement.cockpit_aggregator import ImprovementItem, ImprovementQueue


def _app() -> FastAPI:
    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    # Router-level membership gate (Phase 3 path-org); bypass for smoke tests.
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(improve_routes.router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app())


def test_queue_route(client: TestClient) -> None:
    queue = ImprovementQueue(
        items=[
            ImprovementItem(
                ref="issue:1",
                item_type="issue_p0",
                title="Critical loop",
                column="urgent",
                severity="critical",
            )
        ],
        refreshed_at="2026-07-12T00:00:00+00:00",
        counts_by_column={"urgent": 1},
        counts_by_type={"issue_p0": 1},
    )
    with patch.object(
        improve_routes._aggregator,
        "list_queue",
        new=AsyncMock(return_value=queue),
    ):
        resp = client.get("/orgs/org_1/improve/queue")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["feature"] == "improvement_cockpit"
    assert body["data"]["count"] == 1
    assert body["data"]["items"][0]["ref"] == "issue:1"


def test_snooze_route(client: TestClient) -> None:
    resp = client.post(
        "/orgs/org_1/improve/items/issue%3Ax/snooze",
        json={"hours": 2},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["item_ref"] == "issue:x"
    assert "snoozed_until" in resp.json()["data"]


def test_autofix_dry_run(client: TestClient) -> None:
    issue = type(
        "I",
        (),
        {
            "id": "iss_1",
            "title": "Loop",
            "fingerprint": "fp",
            "triage_result": {"root_cause": "tool_loop"},
        },
    )()
    with patch(
        "eden.issues.repo.IssuesRepo.get_issue",
        new=AsyncMock(return_value=issue),
    ):
        resp = client.post(
            "/orgs/org_1/improve/autofix/iss_1",
            json={"dry_run": True},
        )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["dry_run"] is True
    assert data["patch_summary"]["fingerprint"] == "fp"
