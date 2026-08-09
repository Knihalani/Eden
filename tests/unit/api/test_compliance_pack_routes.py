"""FEAT-111 — route-level tests for N06 compliance pack endpoints.

Mounted at ``/orgs/{org_id}/compliance`` (flag ``compliance_pack_export_v1``,
enabled by default). Pattern mirrors ``test_session_timeline_routes.py`` /
``test_improve_routes.py``: mini FastAPI app + auth/path-org overrides +
mocked ledger/pack collaborators.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.routes import compliance_pack as cp_routes


def _app(*, deny_foreign_org: bool = False) -> FastAPI:
    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        if deny_foreign_org and org_id != "org_1":
            raise HTTPException(status_code=403, detail="Not a member of this organization")
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(cp_routes.router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app())


class TestVerifyChain:
    def test_happy_path(self, client: TestClient) -> None:
        report = {
            "verified": True,
            "total_rows": 2,
            "ok_rows": 2,
            "broken_rows": 0,
        }
        with patch.object(
            cp_routes._ledger,
            "verify_chain",
            new=AsyncMock(return_value=report),
        ) as mock_verify:
            resp = client.post(
                "/orgs/org_1/compliance/verify?agent_id=agent-a&limit=100"
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["feature"] == "agent_audit_ledger_verify"
        assert body["live"] is True
        assert body["data"]["verified"] is True
        assert body["data"]["ok_rows"] == 2
        mock_verify.assert_awaited_once()
        kwargs = mock_verify.call_args.kwargs
        assert mock_verify.call_args.args == ("org_1",)
        assert kwargs["agent_id"] == "agent-a"
        assert kwargs["limit"] == 100

    def test_ledger_down_is_503(self, client: TestClient) -> None:
        with patch.object(
            cp_routes._ledger,
            "verify_chain",
            new=AsyncMock(side_effect=ConnectionError("pg down")),
        ):
            resp = client.post("/orgs/org_1/compliance/verify")
        assert resp.status_code == 503
        assert resp.json()["detail"] == "Audit ledger unavailable"


class TestQueryLedger:
    def test_happy_path(self, client: TestClient) -> None:
        events = [
            {"id": "e1", "event_type": "autonomous", "agent_id": "agent-a"},
            {"id": "e2", "event_type": "runtime", "agent_id": "agent-a"},
        ]
        with patch.object(
            cp_routes._ledger,
            "query",
            new=AsyncMock(return_value=events),
        ) as mock_query:
            resp = client.get(
                "/orgs/org_1/compliance/ledger"
                "?agent_id=agent-a&event_type=autonomous&limit=50"
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["feature"] == "agent_audit_ledger"
        assert body["data"]["count"] == 2
        assert body["data"]["events"][0]["id"] == "e1"
        kwargs = mock_query.call_args.kwargs
        assert mock_query.call_args.args == ("org_1",)
        assert kwargs["agent_id"] == "agent-a"
        assert kwargs["event_type"] == "autonomous"
        assert kwargs["limit"] == 50

    def test_ledger_down_is_503(self, client: TestClient) -> None:
        with patch.object(
            cp_routes._ledger,
            "query",
            new=AsyncMock(side_effect=RuntimeError("db gone")),
        ):
            resp = client.get("/orgs/org_1/compliance/ledger")
        assert resp.status_code == 503
        assert resp.json()["detail"] == "Audit ledger unavailable"

    def test_bad_limit_rejected(self, client: TestClient) -> None:
        resp = client.get("/orgs/org_1/compliance/ledger?limit=0")
        assert resp.status_code == 422


class TestExportAgentPack:
    def test_happy_path(self, client: TestClient) -> None:
        pack = {
            "status": "ok",
            "feature": "compliance_pack",
            "data": {
                "pack_id": "pack-1",
                "agent_id": "agent-a",
                "framework": "soc2_type_ii",
            },
        }
        with patch.object(
            cp_routes._packs,
            "generate_agent_pack",
            new=AsyncMock(return_value=pack),
        ) as mock_gen:
            resp = client.post(
                "/orgs/org_1/compliance/agents/agent-a/export",
                json={
                    "period_start": "2026-01-01T00:00:00Z",
                    "period_end": "2026-01-31T23:59:59Z",
                    "framework": "soc2_type_ii",
                },
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["feature"] == "compliance_pack"
        assert body["data"]["pack_id"] == "pack-1"
        assert body["data"]["agent_id"] == "agent-a"
        mock_gen.assert_awaited_once()
        assert mock_gen.call_args.args[:2] == ("org_1", "agent-a")
        kwargs = mock_gen.call_args.kwargs
        assert kwargs["period_start"] == "2026-01-01T00:00:00Z"
        assert kwargs["period_end"] == "2026-01-31T23:59:59Z"
        assert kwargs["framework"] == "soc2_type_ii"

    def test_missing_body_is_422(self, client: TestClient) -> None:
        resp = client.post("/orgs/org_1/compliance/agents/agent-a/export", json={})
        assert resp.status_code == 422


class TestOrgScoping:
    def test_foreign_org_denied_when_path_org_enforced(self) -> None:
        client = TestClient(_app(deny_foreign_org=True))
        with patch.object(
            cp_routes._ledger,
            "verify_chain",
            new=AsyncMock(return_value={"verified": False, "total_rows": 0}),
        ):
            resp = client.post("/orgs/org_other/compliance/verify")
        assert resp.status_code == 403
