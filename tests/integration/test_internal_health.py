"""Tests for the /v1/internal/health dashboard (Phase 4 B3).

The tests verify:

1. The endpoint requires an allow-listed IP (default: loopback).
2. The overall envelope shape is correct.
3. Each component probe returns the expected fields.
4. A failing component drags the overall status to "unhealthy".
5. An unknown component name returns 404.

The route iterates the ``PROBES`` dict (which captures function
refs at module load time). The tests therefore patch ``PROBES``
directly rather than the module-level ``_probe_*`` names.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.middleware.internal_only import InternalOnlyMiddleware
from eden.api.routes import internal_health

# ── Fixtures ──────────────────────────────────────────────────────────


def _build_app(allowed_ips: str | None = None) -> FastAPI:
    """Build a fresh FastAPI app with the internal-only middleware
    + internal_health router. Setting ``allowed_ips`` overrides
    the env var (the default is loopback-only)."""
    import os
    if allowed_ips is not None:
        os.environ["INTERNAL_ALLOWED_IPS"] = allowed_ips
    elif "INTERNAL_ALLOWED_IPS" not in os.environ:
        os.environ["INTERNAL_ALLOWED_IPS"] = ""
    a = FastAPI()
    a.add_middleware(InternalOnlyMiddleware)
    a.include_router(internal_health.router)
    return a


@pytest.fixture
def app() -> "typing.Iterator[FastAPI]":
    # Audit 2026-07-06 — env-var-mutating fixture MUST restore the
    # prior value via a finalizer. Previously this fixture wrote
    # ``os.environ["INTERNAL_ALLOWED_IPS"] = "testclient"`` and
    # never cleaned it up, which leaked into
    # ``tests/unit/api/test_middleware_perf.py`` run order and
    # caused 2 spurious failures (those tests assert the default
    # loopback-only allow-list behaviour).
    import os as _os
    _prior = _os.environ.get("INTERNAL_ALLOWED_IPS", None)
    built = _build_app(allowed_ips="testclient")
    try:
        yield built
    finally:
        _os.environ.pop("INTERNAL_ALLOWED_IPS", None)
        if _prior is not None:
            _os.environ["INTERNAL_ALLOWED_IPS"] = _prior


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def _fake_probes(
    *,
    postgres: str = "healthy",
    clickhouse: str = "healthy",
    judge: str = "healthy",
    hookbus: str = "healthy",
    eval_status: str = "healthy",
) -> dict[str, AsyncMock]:
    """Build a fake PROBES dict mapping each component to an
    AsyncMock returning the requested status."""
    def _mk(status: str) -> AsyncMock:
        if status == "healthy":
            return AsyncMock(return_value={"status": "healthy", "probe_ms": 0.5})
        if status == "degraded":
            return AsyncMock(return_value={
                "status": "degraded", "note": "test", "probe_ms": 0.3,
            })
        if status == "unhealthy":
            return AsyncMock(return_value={
                "status": "unhealthy", "error": "test", "probe_ms": 0.2,
            })
        raise ValueError(f"unknown status: {status}")

    return {
        "postgres": _mk(postgres),
        "clickhouse": _mk(clickhouse),
        "judge": _mk(judge),
        "hookbus": _mk(hookbus),
        "eval": _mk(eval_status),
    }


# ── 1. Allow-list gating ─────────────────────────────────────────────


def test_internal_health_blocks_non_allowlisted_ip() -> None:
    """Default allow-list is loopback only. A client whose
    ``request.client.host`` is not in the allow-list gets 403."""
    import os
    os.environ.pop("INTERNAL_ALLOWED_IPS", None)
    app = _build_app()
    client = TestClient(app)
    resp = client.get("/v1/internal/health")
    assert resp.status_code == 403, resp.text
    body = resp.json()
    assert body["status"] == "forbidden"
    assert "health/*" in body["message"].lower()


def test_internal_only_middleware_does_not_gate_other_internal_routes(
    client: TestClient,
) -> None:
    """The InternalOnlyMiddleware is intentionally narrow — it
    only blocks ``/v1/internal/health/*``. Other internal routes
    (e.g. ``/v1/internal/onboarding/*``) have their own Clerk auth
    and must remain reachable."""
    # /v1/internal/onboarding/foo should NOT be blocked, even
    # though it's under /v1/internal/. (The route doesn't exist in
    # this test app so we expect a 404, NOT a 403.)
    resp = client.get("/v1/internal/onboarding/foo")
    assert resp.status_code != 403, (
        "InternalOnlyMiddleware must NOT block /v1/internal/onboarding/*"
    )


def test_internal_health_allows_configured_ip(client: TestClient) -> None:
    """When the client's IP is in the allow-list, the request
    succeeds (200) and the dashboard renders."""
    with patch.dict(
        internal_health.PROBES,
        _fake_probes(),
        clear=False,
    ):
        resp = client.get("/v1/internal/health")
    assert resp.status_code == 200, resp.text


# ── 2. Envelope shape ────────────────────────────────────────────────


def test_internal_health_returns_envelope_with_all_components(
    client: TestClient,
) -> None:
    with patch.dict(
        internal_health.PROBES,
        _fake_probes(),
        clear=False,
    ):
        resp = client.get("/v1/internal/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "healthy"
    assert set(body["components"].keys()) == {
        "postgres", "clickhouse", "judge", "hookbus", "eval",
    }
    for component_data in body["components"].values():
        assert component_data["status"] == "healthy"
        assert "probe_ms" in component_data
    assert "timestamp" in body
    assert "version" in body


def test_internal_health_aggregates_worst_status(client: TestClient) -> None:
    """A single unhealthy component drags the overall to 'unhealthy'."""
    with patch.dict(
        internal_health.PROBES,
        _fake_probes(judge="unhealthy"),
        clear=False,
    ):
        resp = client.get("/v1/internal/health")
    body = resp.json()
    assert resp.status_code == 200
    assert body["status"] == "unhealthy"
    assert body["components"]["judge"]["status"] == "unhealthy"


def test_internal_health_degraded_when_only_degraded_present(
    client: TestClient,
) -> None:
    """When only 'degraded' components are present (no unhealthy),
    the overall is 'degraded'."""
    with patch.dict(
        internal_health.PROBES,
        _fake_probes(clickhouse="degraded", judge="degraded"),
        clear=False,
    ):
        resp = client.get("/v1/internal/health")
    body = resp.json()
    assert resp.status_code == 200
    assert body["status"] == "degraded"


# ── 3. Per-component endpoint ───────────────────────────────────────


def test_internal_health_component_returns_per_component_detail(
    client: TestClient,
) -> None:
    fake = AsyncMock(return_value={
        "status": "healthy",
        "active_connections": 5,
        "idle_connections": 10,
        "slow_query_count": 0,
        "probe_ms": 1.0,
    })
    with patch.dict(
        internal_health.PROBES,
        {"postgres": fake},
        clear=False,
    ):
        resp = client.get("/v1/internal/health/postgres")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["component"] == "postgres"
    assert body["data"]["active_connections"] == 5


def test_internal_health_component_404_for_unknown(client: TestClient) -> None:
    resp = client.get("/v1/internal/health/not-a-component")
    assert resp.status_code == 404
    body = resp.json()
    assert body["detail"]["status"] == "not_found"
    assert "postgres" in body["detail"]["known_components"]


# ── 4. Probe error envelope ─────────────────────────────────────────


def test_probe_exception_is_caught_not_500(client: TestClient) -> None:
    """When a probe raises an exception, the dashboard returns 200
    with the component status='error' — the dashboard is informational,
    not a probe gate."""
    healthy = AsyncMock(return_value={"status": "healthy", "probe_ms": 0.5})
    broken = AsyncMock(side_effect=RuntimeError("simulated db failure"))
    with patch.dict(
        internal_health.PROBES,
        {
            "postgres": healthy,
            "clickhouse": broken,
            "judge": healthy,
            "hookbus": healthy,
            "eval": healthy,
        },
        clear=False,
    ):
        resp = client.get("/v1/internal/health")
    body = resp.json()
    assert resp.status_code == 200
    assert body["status"] == "unhealthy"
    assert body["components"]["clickhouse"]["status"] == "error"
    assert "simulated db failure" in body["components"]["clickhouse"]["error"]


# ── 5. Probe registry spot-check ────────────────────────────────────


def test_probes_registered() -> None:
    assert set(internal_health.PROBES.keys()) == {
        "postgres", "clickhouse", "judge", "hookbus", "eval",
    }
