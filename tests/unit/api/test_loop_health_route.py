"""M2 (D4) — /internal/loop-health bus liveness probe."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import eden.closed_loop.event_bus as eb
from eden.api.routes import loop_health as lh


@pytest.fixture(autouse=True)
def _reset_failure_ts():
    eb.last_publish_failure_ts = None
    yield
    eb.last_publish_failure_ts = None


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(lh.router)
    app.dependency_overrides[lh._check_metrics_auth] = lambda: None
    return TestClient(app)


def _redis_ok(lag: int = 0) -> MagicMock:
    redis = MagicMock()
    now_ms = int(time.time() * 1000)
    redis.xinfo_stream = AsyncMock(
        return_value={"last-entry": (f"{now_ms}-0", {"type": "x"})}
    )
    redis.xinfo_groups = AsyncMock(
        return_value=[{"name": eb._GROUP, "pending": lag, "lag": lag}]
    )
    return redis


def test_dead_when_no_redis(client):
    with (
        patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=None)),
        patch.object(eb, "outbox_depth", AsyncMock(return_value=0)),
    ):
        resp = client.get("/internal/loop-health")

    assert resp.status_code == 200
    body = resp.json()
    assert body["bus"] == "dead"
    assert body["outbox_depth"] == 0
    assert body["consumer_lag"] is None


def test_dead_when_stream_missing(client):
    redis = MagicMock()
    redis.xinfo_stream = AsyncMock(side_effect=Exception("ERR no such key"))
    with (
        patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=redis)),
        patch.object(eb, "outbox_depth", AsyncMock(return_value=0)),
    ):
        resp = client.get("/internal/loop-health")

    assert resp.json()["bus"] == "dead"


def test_degraded_when_outbox_backlog(client):
    with (
        patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=_redis_ok(lag=2)),
        ),
        patch.object(eb, "outbox_depth", AsyncMock(return_value=3)),
    ):
        resp = client.get("/internal/loop-health")

    body = resp.json()
    assert body["bus"] == "degraded"
    assert body["outbox_depth"] == 3
    assert body["consumer_lag"] == 2


def test_degraded_when_recent_publish_failure(client):
    eb.last_publish_failure_ts = time.time() - 10.0
    with (
        patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=_redis_ok()),
        ),
        patch.object(eb, "outbox_depth", AsyncMock(return_value=0)),
    ):
        resp = client.get("/internal/loop-health")

    body = resp.json()
    assert body["bus"] == "degraded"
    assert 0 <= body["last_publish_failure_age_s"] < 60


def test_ok_when_healthy(client):
    with (
        patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=_redis_ok()),
        ),
        patch.object(eb, "outbox_depth", AsyncMock(return_value=0)),
    ):
        resp = client.get("/internal/loop-health")

    body = resp.json()
    assert body["bus"] == "ok"
    assert body["last_publish_failure_age_s"] is None
    assert body["last_event_age_s"] is not None
    assert body["last_event_age_s"] < 60


def test_bearer_auth_enforced():
    """Without the override the route uses the /metrics bearer check."""
    app = FastAPI()
    app.include_router(lh.router)
    client = TestClient(app)
    settings = MagicMock()
    settings.metrics_bearer_token = "sekrit"

    with patch(
        "eden.observability.metrics_endpoint.get_settings",
        return_value=settings,
    ):
        assert client.get("/internal/loop-health").status_code == 401
        assert (
            client.get(
                "/internal/loop-health",
                headers={"Authorization": "Bearer wrong"},
            ).status_code
            == 401
        )
        with (
            patch(
                "eden.storage.redis.get_redis_client",
                AsyncMock(return_value=None),
            ),
            patch.object(eb, "outbox_depth", AsyncMock(return_value=0)),
        ):
            resp = client.get(
                "/internal/loop-health",
                headers={"Authorization": "Bearer sekrit"},
            )
    assert resp.status_code == 200


def test_unconfigured_token_returns_503():
    app = FastAPI()
    app.include_router(lh.router)
    client = TestClient(app)
    settings = MagicMock()
    settings.metrics_bearer_token = ""

    with patch(
        "eden.observability.metrics_endpoint.get_settings",
        return_value=settings,
    ):
        assert client.get("/internal/loop-health").status_code == 503
