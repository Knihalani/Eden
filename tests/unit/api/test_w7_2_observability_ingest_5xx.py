"""W7 Agent 7.2 — observability/ingest remaining 5xx → 4xx/503.

Covers:
* ``/ingest/app`` API-key auth (no Clerk ``require_path_org_access``)
* Multi-format ingest decode client errors → 400; unexpected → 503
* Multi-format ingest write unexpected → 503
* Telemetry ingest unexpected → 503 (not 500)
* Live publish rate_limited / session_cap → 429
* Agent-session non-UUID session_id → 422
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from eden.api.deps import get_ingest_auth

_ORG = "org-w72"
_EVENT = {
    "event_id": "evt-w72",
    "project_id": "default",
    "trace_id": "trace-w72",
    "realm": "environment",
    "event_type": "llm.completion",
    "timestamp": "2026-07-20T00:00:00Z",
}


@pytest.fixture
def fake_auth() -> dict:
    return {
        "org_id": _ORG,
        "user_id": None,
        "api_key_id": "key-w72",
        "auth_method": "api_key",
        "scopes": ["ingest:write"],
    }


# ── /ingest/app ──────────────────────────────────────────────────────


class TestAppEventsIngestAuthNoClerk:
    def test_api_key_ingest_succeeds_without_clerk(
        self, api_client: TestClient, monkeypatch, fake_auth
    ) -> None:
        from eden.api.app import app
        from eden.api.routes import app_events as app_mod

        app.dependency_overrides[get_ingest_auth] = lambda: fake_auth
        api_client.cookies.clear()

        svc = MagicMock()
        svc.ingest_batch = AsyncMock(
            return_value={"accepted": 1, "rejected": 0, "total": 1}
        )
        monkeypatch.setattr(app_mod, "AppEventsService", lambda: svc)

        try:
            resp = api_client.post(
                f"/orgs/{_ORG}/ingest/app",
                json={
                    "events": [
                        {
                            "name": "page_view",
                            "ts": datetime.now(UTC).isoformat(),
                            "source": "browser",
                        }
                    ]
                },
                headers={
                    "X-Org-Id": _ORG,
                    "X-Org-Api-Key": "test-key",
                },
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["accepted"] == 1
            assert svc.ingest_batch.await_count == 1
        finally:
            app.dependency_overrides.pop(get_ingest_auth, None)

    def test_path_org_mismatch_is_403(
        self, api_client: TestClient, fake_auth
    ) -> None:
        from eden.api.app import app

        app.dependency_overrides[get_ingest_auth] = lambda: fake_auth
        api_client.cookies.clear()
        try:
            resp = api_client.post(
                "/orgs/other-org/ingest/app",
                json={
                    "events": [
                        {
                            "name": "click",
                            "ts": datetime.now(UTC).isoformat(),
                        }
                    ]
                },
                headers={"X-Org-Id": _ORG, "X-Org-Api-Key": "k"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            app.dependency_overrides.pop(get_ingest_auth, None)

    def test_service_fault_is_503_not_500(
        self, api_client: TestClient, monkeypatch, fake_auth
    ) -> None:
        from eden.api.app import app
        from eden.api.routes import app_events as app_mod

        app.dependency_overrides[get_ingest_auth] = lambda: fake_auth
        svc = MagicMock()
        svc.ingest_batch = AsyncMock(side_effect=RuntimeError("db boom"))
        monkeypatch.setattr(app_mod, "AppEventsService", lambda: svc)
        api_client.cookies.clear()
        try:
            resp = api_client.post(
                f"/orgs/{_ORG}/ingest/app",
                json={
                    "events": [
                        {
                            "name": "click",
                            "ts": datetime.now(UTC).isoformat(),
                        }
                    ]
                },
                headers={"X-Org-Id": _ORG, "X-Org-Api-Key": "k"},
            )
            assert resp.status_code == 503, resp.text
            assert resp.status_code != 500
            assert resp.headers.get("Retry-After") == "5"
        finally:
            app.dependency_overrides.pop(get_ingest_auth, None)


# ── Multi-format /ingest/{format} ────────────────────────────────────


class TestMultiFormatIngestStatusCodes:
    @pytest.fixture
    def ingest_client(self, api_client: TestClient, monkeypatch, fake_auth):
        from eden.api.app import app
        from eden.api.routes import ingestion as ingestion_module
        from eden.observability import telemetry_collector as tc_module

        collector = AsyncMock()
        collector.ingest_batch = AsyncMock(
            return_value={
                "accepted": 1,
                "rejected": 0,
                "deduplicated": 0,
                "total": 1,
            }
        )

        async def _get():
            return collector

        app.dependency_overrides[get_ingest_auth] = lambda: fake_auth
        monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
        monkeypatch.setattr(ingestion_module, "get_telemetry_collector", _get)
        api_client.cookies.clear()
        try:
            yield api_client, collector
        finally:
            app.dependency_overrides.pop(get_ingest_auth, None)

    def test_decode_value_error_is_400(self, ingest_client, monkeypatch) -> None:
        from eden.api.routes import ingestion as ingestion_module
        from eden.observability.ingestion.errors import FormatUnsupportedError

        client, collector = ingest_client
        registry = MagicMock()
        registry.decode = AsyncMock(side_effect=ValueError("invalid gzip body"))
        monkeypatch.setattr(ingestion_module, "get_format_registry", lambda: registry)

        resp = client.post(
            f"/orgs/{_ORG}/ingest/openai",
            content=b"not-json",
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": _ORG,
                "X-Org-Api-Key": "k",
            },
        )
        assert resp.status_code == 400, resp.text
        assert collector.ingest_batch.await_count == 0
        # FormatUnsupportedError still maps via IngestError path:
        registry.decode = AsyncMock(
            side_effect=FormatUnsupportedError("nope")
        )
        resp2 = client.post(
            f"/orgs/{_ORG}/ingest/openai",
            content=b"{}",
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": _ORG,
                "X-Org-Api-Key": "k",
            },
        )
        assert resp2.status_code == 415, resp2.text

    def test_decode_unexpected_is_503(self, ingest_client, monkeypatch) -> None:
        from eden.api.routes import ingestion as ingestion_module

        client, collector = ingest_client
        registry = MagicMock()
        registry.decode = AsyncMock(side_effect=RuntimeError("decoder panic"))
        monkeypatch.setattr(ingestion_module, "get_format_registry", lambda: registry)

        resp = client.post(
            f"/orgs/{_ORG}/ingest/openai",
            content=b'{"id":"x","model":"m","choices":[],"usage":{}}',
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": _ORG,
                "X-Org-Api-Key": "k",
            },
        )
        assert resp.status_code == 503, resp.text
        assert resp.status_code != 500
        assert resp.headers.get("Retry-After") == "5"
        assert collector.ingest_batch.await_count == 0

    def test_write_unexpected_is_503(self, ingest_client, monkeypatch) -> None:
        from eden.api.routes import ingestion as ingestion_module
        from eden.observability.telemetry_collector import TelemetryEvent

        client, collector = ingest_client
        registry = MagicMock()
        registry.decode = AsyncMock(
            return_value=[
                TelemetryEvent(
                    event_id="e1",
                    tenant_id=_ORG,
                    project_id="default",
                    trace_id="t1",
                    realm="environment",
                    event_type="llm.completion",
                    timestamp="2026-07-20T00:00:00Z",
                )
            ]
        )
        monkeypatch.setattr(ingestion_module, "get_format_registry", lambda: registry)
        collector.ingest_batch = AsyncMock(side_effect=RuntimeError("write boom"))

        resp = client.post(
            f"/orgs/{_ORG}/ingest/openai",
            content=json.dumps(
                {
                    "id": "chatcmpl-w72",
                    "model": "gpt-4o",
                    "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                }
            ).encode(),
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": _ORG,
                "X-Org-Api-Key": "k",
            },
        )
        assert resp.status_code == 503, resp.text
        assert resp.status_code != 500


# ── Telemetry ingest ─────────────────────────────────────────────────


class TestTelemetryIngestUnexpectedIs503:
    def test_runtime_error_maps_to_503(
        self, api_client: TestClient, monkeypatch, fake_auth
    ) -> None:
        from eden.api.app import app
        from eden.api.routes import observability as obs_module
        from eden.observability import telemetry_collector as tc_module

        collector = AsyncMock()
        collector.ingest_one = AsyncMock(side_effect=RuntimeError("collector boom"))

        async def _get():
            return collector

        monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
        monkeypatch.setattr(obs_module, "get_telemetry_collector", _get)
        monkeypatch.setattr(obs_module, "_get_collector", _get)
        app.dependency_overrides[get_ingest_auth] = lambda: {
            **fake_auth,
            "org_id": "00000000-0000-0000-0000-000000000099",
        }
        org = "00000000-0000-0000-0000-000000000099"
        api_client.cookies.clear()
        try:
            resp = api_client.post(
                f"/orgs/{org}/observability/telemetry/ingest",
                json={**_EVENT, "event_id": "evt-503"},
                headers={"X-Org-Id": org, "X-Org-Api-Key": "k"},
            )
            assert resp.status_code == 503, resp.text
            assert resp.status_code != 500
            assert resp.headers.get("Retry-After") == "5"
        finally:
            app.dependency_overrides.pop(get_ingest_auth, None)


# ── Live publish ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_live_publish_rate_limited_is_429() -> None:
    from fastapi import HTTPException

    from eden.api.routes import observability_live as live_routes
    from eden.api.routes.observability_live import LiveEventBody, publish_live_event

    with patch.object(
        live_routes._publisher,
        "publish",
        new=AsyncMock(
            return_value={
                "status": "error",
                "code": "rate_limited",
                "message": "1000 events/min/session exceeded",
            }
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await publish_live_event(
                org_id=_ORG,
                session_id="sess-1",
                body=LiveEventBody(type="span_start"),
                auth={"org_id": _ORG},
            )
    assert exc.value.status_code == 429
    assert exc.value.headers.get("Retry-After") == "60"


@pytest.mark.asyncio
async def test_live_publish_session_cap_is_429() -> None:
    from fastapi import HTTPException

    from eden.api.routes import observability_live as live_routes
    from eden.api.routes.observability_live import LiveEventBody, publish_live_event

    with patch.object(
        live_routes._publisher,
        "publish",
        new=AsyncMock(
            return_value={
                "status": "error",
                "code": "session_cap",
                "message": "Org live session cap reached",
            }
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await publish_live_event(
                org_id=_ORG,
                session_id="sess-1",
                body=LiveEventBody(type="span_start"),
                auth={"org_id": _ORG},
            )
    assert exc.value.status_code == 429


# ── Agent sessions UUID ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ingest_agent_session_non_uuid_is_422() -> None:
    from eden.api.routes import ingest_agent_sessions as routes
    from eden.services.agent_sessions import AgentSessionService

    async def _fake_auth() -> dict:
        return {"org_id": _ORG, "auth": "api_key"}

    svc = AgentSessionService()

    async def _no_db(_self: AgentSessionService = svc) -> None:  # noqa: ARG001
        return None

    with patch.object(svc, "_client", _no_db):
        application = FastAPI()
        application.dependency_overrides[get_ingest_auth] = _fake_auth
        application.include_router(routes.router)
        routes._svc = svc

        transport = ASGITransport(app=application)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            bad = await client.post(
                f"/orgs/{_ORG}/ingest/agent-sessions/start",
                json={"agent_id": "a1", "session_id": "not-a-uuid"},
            )
            assert bad.status_code == 422, bad.text

            sid = str(uuid.uuid4())
            ok = await client.post(
                f"/orgs/{_ORG}/ingest/agent-sessions/start",
                json={"agent_id": "a1", "session_id": sid},
            )
            assert ok.status_code == 200, ok.text
            assert ok.json()["data"]["session"]["id"] == sid
