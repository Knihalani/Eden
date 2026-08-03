"""Phase 5 — ``GunzipRequestMiddleware`` decodes gzip request bodies
for the agent-session / live-trace-streaming ingest routers only.

FastAPI parses typed ``Body(...)`` parameters as JSON before any
``Depends`` dependency runs, so those two routers cannot rely on a
dependency to gunzip — the ASGI-level middleware is the only place
that can intercept in time. See ``eden.api.middleware.gzip_request``.
"""

from __future__ import annotations

import gzip
import json
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from eden.api.deps import get_ingest_auth
from eden.api.middleware.gzip_request import GunzipRequestMiddleware

_ORG = "org-gzip-mw"


async def _fake_auth() -> dict:
    return {"org_id": _ORG, "auth": "api_key"}


def _gzip_json(payload: dict) -> bytes:
    return gzip.compress(json.dumps(payload).encode("utf-8"))


@pytest.mark.asyncio
async def test_gzip_body_decoded_for_agent_sessions_start() -> None:
    from eden.api.routes import ingest_agent_sessions as routes
    from eden.services.agent_sessions import AgentSessionService

    svc = AgentSessionService()

    async def _no_db(_self: AgentSessionService = svc) -> None:
        return None

    with patch.object(svc, "_client", _no_db):
        routes._svc = svc
        application = FastAPI()
        application.dependency_overrides[get_ingest_auth] = _fake_auth
        application.include_router(routes.router)
        application.add_middleware(GunzipRequestMiddleware)

        sid = str(uuid.uuid4())
        body = _gzip_json({"agent_id": "a1", "session_id": sid})

        transport = ASGITransport(app=application)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                f"/orgs/{_ORG}/ingest/agent-sessions/start",
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "Content-Encoding": "gzip",
                },
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["session"]["id"] == sid


@pytest.mark.asyncio
async def test_gzip_body_decoded_for_live_publish() -> None:
    from eden.api.routes import observability_live as live_routes

    application = FastAPI()
    application.dependency_overrides[get_ingest_auth] = _fake_auth
    application.include_router(live_routes.router)
    application.add_middleware(GunzipRequestMiddleware)

    with patch.object(
        live_routes._publisher,
        "publish",
        new=AsyncMock(return_value={"status": "ok", "event_id": 1}),
    ) as mock_publish:
        body = _gzip_json({"type": "span_start", "span_id": "sp1"})
        transport = ASGITransport(app=application)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                f"/orgs/{_ORG}/stream/traces/sess-1/publish",
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "Content-Encoding": "gzip",
                },
            )

    assert resp.status_code == 200, resp.text
    mock_publish.assert_awaited_once()
    published_payload = mock_publish.await_args.args[-1]
    assert published_payload["span_id"] == "sp1"


@pytest.mark.asyncio
async def test_uncompressed_body_still_works_through_middleware() -> None:
    """The middleware must be a pure no-op when there is no gzip Content-Encoding."""
    from eden.api.routes import ingest_agent_sessions as routes
    from eden.services.agent_sessions import AgentSessionService

    svc = AgentSessionService()

    async def _no_db(_self: AgentSessionService = svc) -> None:
        return None

    with patch.object(svc, "_client", _no_db):
        routes._svc = svc
        application = FastAPI()
        application.dependency_overrides[get_ingest_auth] = _fake_auth
        application.include_router(routes.router)
        application.add_middleware(GunzipRequestMiddleware)

        sid = str(uuid.uuid4())
        transport = ASGITransport(app=application)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                f"/orgs/{_ORG}/ingest/agent-sessions/start",
                json={"agent_id": "a1", "session_id": sid},
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["session"]["id"] == sid


@pytest.mark.asyncio
async def test_main_ingest_routes_are_not_touched_by_middleware() -> None:
    """The middleware must never intercept ``/orgs/{org}/ingest/{format}``
    (main telemetry ingest) — that router gunzips itself, and double
    handling would hand it already-plain bytes still labelled gzip."""
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    seen: dict[str, bytes] = {}

    async def _echo(request):
        seen["body"] = await request.body()
        seen["content_encoding"] = request.headers.get("content-encoding", "")
        return JSONResponse({"ok": True})

    app = Starlette(
        routes=[Route(f"/orgs/{_ORG}/ingest/openai", _echo, methods=["POST"])]
    )
    app.add_middleware(GunzipRequestMiddleware)

    compressed = _gzip_json({"model": "gpt-4"})
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            f"/orgs/{_ORG}/ingest/openai",
            content=compressed,
            headers={"Content-Encoding": "gzip"},
        )

    assert resp.status_code == 200
    # Body must arrive UNCHANGED (still gzip'd) — this route's own
    # gunzip logic (not exercised by this minimal echo app) is
    # responsible for decoding it.
    assert seen["body"] == compressed
    assert seen["content_encoding"] == "gzip"
