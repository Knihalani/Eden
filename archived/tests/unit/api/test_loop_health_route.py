"""M2 (D4) — /internal/loop-health bus liveness probe (N5 outbox primary)."""

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


def _patch_probe(**kwargs):
    """Patch the two PG-backed probe reads with canned values."""
    import contextlib

    stack = contextlib.ExitStack()
    stack.enter_context(
        patch.object(
            eb, "outbox_depth", AsyncMock(return_value=kwargs.get("depth", 0))
        )
    )
    stack.enter_context(
        patch.object(
            eb,
            "oldest_pending_age_s",
            AsyncMock(return_value=kwargs.get("pending_age")),
        )
    )
    return stack


def test_dead_when_publish_failing(client):
    eb.last_publish_failure_ts = time.time() - 10.0
    with _patch_probe(depth=0, pending_age=None):
        resp = client.get("/internal/loop-health")

    assert resp.status_code == 200
    body = resp.json()
    assert body["bus"] == "dead"
    assert body["outbox_depth"] == 0
    assert body["consumer_lag"] == 0
    assert 0 <= body["last_publish_failure_age_s"] < 60


def test_degraded_when_outbox_backlog(client):
    with _patch_probe(depth=3, pending_age=120.0):
        resp = client.get("/internal/loop-health")

    body = resp.json()
    assert body["bus"] == "degraded"
    assert body["outbox_depth"] == 3
    assert body["consumer_lag"] == 3
    assert body["last_event_age_s"] == 120.0
    assert body["last_publish_failure_age_s"] is None


def test_degraded_when_stale_publish_failure(client):
    eb.last_publish_failure_ts = time.time() - 3600.0
    with _patch_probe(depth=0, pending_age=None):
        resp = client.get("/internal/loop-health")

    body = resp.json()
    assert body["bus"] == "degraded"
    assert body["last_publish_failure_age_s"] > 600


def test_ok_when_healthy(client):
    with _patch_probe(depth=0, pending_age=None):
        resp = client.get("/internal/loop-health")

    body = resp.json()
    assert body["bus"] == "ok"
    assert body["last_publish_failure_age_s"] is None
    assert body["last_event_age_s"] is None
    assert body["consumer_lag"] == 0


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
        with _patch_probe(depth=0, pending_age=None):
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
