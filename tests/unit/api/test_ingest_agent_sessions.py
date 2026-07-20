"""Ingest-side agent session routes (org API key)."""

from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from eden.api.deps import get_ingest_auth
from eden.api.routes import ingest_agent_sessions as routes
from eden.services.agent_sessions import AgentSessionService

_SID = str(uuid.uuid4())
_SID_BULK = str(uuid.uuid4())


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
            json={"agent_id": "a1", "session_id": _SID},
            headers={"X-Org-Id": "org_test", "X-Org-Api-Key": "k"},
        )
        assert start.status_code == 200
        body = start.json()
        assert body["status"] == "ok"
        assert body["data"]["session"]["id"] == _SID

        end = await client.post(
            f"/orgs/org_test/ingest/agent-sessions/{_SID}/end",
            json={"success": True, "cost_usd": 0.01},
            headers={"X-Org-Id": "org_test", "X-Org-Api-Key": "k"},
        )
        assert end.status_code == 200
        assert end.json()["data"]["session"]["success"] is True


@pytest.mark.asyncio
async def test_end_session_bulk_attach_traces(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    """end_session with multiple trace_ids calls attach_traces once (not per-id)."""
    svc = routes._svc
    calls: list[tuple[str, str, list[str]]] = []

    async def _spy_attach_traces(
        org_id: str, session_id: str, trace_ids: list[str]
    ) -> int:
        calls.append((org_id, session_id, list(trace_ids)))
        return await AgentSessionService.attach_traces(
            svc, org_id, session_id, trace_ids
        )

    monkeypatch.setattr(svc, "attach_traces", _spy_attach_traces)

    persist_calls = 0
    orig_persist = svc._persist

    async def _counting_persist(session: object) -> None:
        nonlocal persist_calls
        persist_calls += 1
        await orig_persist(session)

    monkeypatch.setattr(svc, "_persist", _counting_persist)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post(
            "/orgs/org_test/ingest/agent-sessions/start",
            json={"agent_id": "a1", "session_id": _SID_BULK},
            headers={"X-Org-Id": "org_test", "X-Org-Api-Key": "k"},
        )
        # start() already persisted once
        persist_before_end = persist_calls

        end = await client.post(
            f"/orgs/org_test/ingest/agent-sessions/{_SID_BULK}/end",
            json={
                "success": True,
                "trace_ids": ["t1", "t2", "t3"],
            },
            headers={"X-Org-Id": "org_test", "X-Org-Api-Key": "k"},
        )
        assert end.status_code == 200
        data = end.json()["data"]["session"]
        assert data["trace_ids"] == ["t1", "t2", "t3"]

    assert len(calls) == 1
    assert calls[0] == ("org_test", _SID_BULK, ["t1", "t2", "t3"])
    # attach_traces persists once + complete persists once
    assert persist_calls - persist_before_end == 2
