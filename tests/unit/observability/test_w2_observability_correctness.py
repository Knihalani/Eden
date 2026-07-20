"""Worker-2 correctness fixes — tenant gates, SSE replay, soft 403s, PG 503."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from eden.api.deps import get_ingest_auth
from eden.api.routes import ingest_agent_sessions as ias_routes
from eden.api.routes import observability_live as live_routes
from eden.api.routes import observability_stream as stream
from eden.observability.errors import IngestionUnavailable
from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent
from eden.services.agent_sessions import AgentSessionService


def test_stream_max_duration_matches_portal_vercel_limit() -> None:
    """Backend SSE bound must match portal maxDuration=300."""
    assert stream._STREAM_MAX_DURATION_S == 300


def _event(eid: str = "evt-1") -> TelemetryEvent:
    from datetime import UTC, datetime

    return TelemetryEvent(
        event_id=eid,
        tenant_id="org-1",
        project_id="proj-1",
        trace_id="trace-1",
        realm="environment",
        event_type="llm.completion",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        agent_id="agent-1",
        payload={},
        metrics={},
    )


@pytest.mark.asyncio
async def test_replay_since_parses_seq_payload_members() -> None:
    redis = MagicMock()
    redis.zrangebyscore = AsyncMock(
        return_value=[
            '2|{"trace_id":"a"}',
            '3|{"trace_id":"b"}',
            "bad",
        ]
    )
    with patch(
        "eden.api.routes.observability_stream.get_redis_client",
        new=AsyncMock(return_value=redis),
    ):
        out = await stream._replay_since("org-1", "1")
    assert [e["trace_id"] for _, e in out] == ["a", "b"]
    assert [s for s, _ in out] == [2, 3]


@pytest.mark.asyncio
async def test_publish_zadd_member_matches_replay_format() -> None:
    stream._numsub_cache.clear()
    redis = MagicMock()
    redis.pubsub_numsub = AsyncMock(return_value=[("ch", 1)])
    redis.incr = AsyncMock(return_value=42)
    pipe = MagicMock()
    pipe.publish = MagicMock(return_value=pipe)
    pipe.zadd = MagicMock(return_value=pipe)
    pipe.expire = MagicMock(return_value=pipe)
    pipe.zremrangebyrank = MagicMock(return_value=pipe)
    pipe.execute = AsyncMock(return_value=[1, 1, True, True, 0])
    redis.pipeline = MagicMock(return_value=pipe)

    with patch(
        "eden.api.routes.observability_stream.get_redis_client",
        new=AsyncMock(return_value=redis),
    ):
        await stream.publish_trace_event("org-x", {"trace_id": "t9"})

    member = next(iter(pipe.zadd.call_args.args[1].keys()))
    seq_str, payload = member.split("|", 1)
    assert int(seq_str) == 42
    assert json.loads(payload)["trace_id"] == "t9"


@pytest.mark.asyncio
async def test_ingest_agent_session_org_mismatch_is_http_403() -> None:
    async def _fake_auth() -> dict:
        return {"org_id": "org_a", "auth": "api_key"}

    svc = AgentSessionService()

    async def _no_db(_self: AgentSessionService = svc) -> None:  # noqa: ARG001
        return None

    with patch.object(svc, "_client", _no_db):
        application = FastAPI()
        application.dependency_overrides[get_ingest_auth] = _fake_auth
        application.include_router(ias_routes.router)
        ias_routes._svc = svc

        transport = ASGITransport(app=application)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/orgs/org_b/ingest/agent-sessions/start",
                json={"agent_id": "a1"},
            )
        assert resp.status_code == 403


@pytest.mark.asyncio
async def test_live_publish_org_mismatch_is_http_403() -> None:
    with pytest.raises(HTTPException) as exc:
        live_routes._assert_ingest_org({"org_id": "org_a"}, "org_b")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_route_postgres_missing_client_raises_unavailable() -> None:
    collector = TelemetryCollector()
    collector._postgres = None
    with patch.object(collector, "_get_postgres", new=AsyncMock(return_value=None)):
        with pytest.raises(IngestionUnavailable):
            await collector._route_postgres(_event())


@pytest.mark.asyncio
async def test_ingest_batch_surfaces_pg_unavailable() -> None:
    collector = TelemetryCollector()
    with (
        patch.object(collector, "_get_postgres", new=AsyncMock(return_value=None)),
        patch.object(collector, "_route_redis", new=AsyncMock()),
        patch.object(collector, "_route_clickhouse", new=AsyncMock()),
        patch.object(collector, "_route_websocket", new=AsyncMock()),
        patch.object(collector, "_route_otel_dual_emit", new=AsyncMock()),
        patch.object(collector, "_route_typesense", new=AsyncMock()),
    ):
        with pytest.raises(IngestionUnavailable):
            await collector.ingest_batch([_event()])


@pytest.mark.asyncio
async def test_assert_ingest_org_requires_auth_org() -> None:
    with pytest.raises(HTTPException) as exc:
        ias_routes._assert_ingest_org({}, "org_a")
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc2:
        ias_routes._assert_ingest_org({"org_id": "org_a"}, "org_b")
    assert exc2.value.status_code == 403
    ias_routes._assert_ingest_org({"org_id": "org_a"}, "org_a")
