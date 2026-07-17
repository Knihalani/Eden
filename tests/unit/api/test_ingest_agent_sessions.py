"""Ingest-side agent session routes (org API key)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from eden.api.deps import get_ingest_auth
from eden.api.routes import ingest_agent_sessions as routes
from eden.services.agent_sessions import AgentSessionService


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    async def _fake_auth() -> dict:
        return {"org_id": "org_test", "auth": "api_key"}

    svc = AgentSessionService()

    async def _no_db(_self: AgentSessionService = svc) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(svc, "_client", _no_db)
    monkeypatch.setattr(routes, "_svc", svc)

    application = FastAPI()
    application.dependency_overrides[get_ingest_auth] = _fake_auth
    application.include_router(routes.router)
    return application


@pytest.mark.asyncio
async def test_ingest_session_start_end(app: FastAPI) -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        start = await client.post(
            "/orgs/org_test/ingest/agent-sessions/start",
            json={"agent_id": "a1", "session_id": "s1"},
            headers={"X-Org-Id": "org_test", "X-Org-Api-Key": "k"},
        )
        assert start.status_code == 200
        body = start.json()
        assert body["status"] == "ok"
        assert body["data"]["session"]["id"] == "s1"

        end = await client.post(
            "/orgs/org_test/ingest/agent-sessions/s1/end",
            json={"success": True, "cost_usd": 0.01},
            headers={"X-Org-Id": "org_test", "X-Org-Api-Key": "k"},
        )
        assert end.status_code == 200
        assert end.json()["data"]["session"]["success"] is True
