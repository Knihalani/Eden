"""Integration tests for the experiments_v1 feature flag.

These tests verify that:
- When EXPERIMENTS_V1=false (default), the legacy experiments routes
  return HTTP 404 (not 403 — pretend the route does not exist).
- When EXPERIMENTS_V1=true, the same routes respond normally and
  the `/feature-flags` endpoint reports the flag as enabled.
- The `/feature-flags` endpoint is unauthenticated and always reachable
  (the portal needs it before sign-in to know which nav to render).

The test app is self-contained and uses only the `require_feature_flag`
dependency + minimal route stubs. This avoids pulling in the langgraph
pipeline / sandbox / benchmark modules which have unrelated import
issues in the test environment.
"""

import importlib.util
import os
import types

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from eden.api.deps import require_feature_flag
from eden.config import get_settings

# Resolve the routes directory at import time.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROUTES_DIR = os.path.normpath(
    os.path.join(_THIS_DIR, "..", "..", "src", "eden", "api", "routes")
)


def _load_route(name: str) -> types.ModuleType:
    """Load a route module directly from its file.

    We do this to bypass the ``eden.api.routes.__init__`` package init,
    which eagerly imports ``jobs`` (which pulls in the langgraph chain,
    currently broken with ``cannot import name 'Command' from
    'langgraph.graph'`` in this env). The route modules themselves are
    standalone.
    """
    spec = importlib.util.spec_from_file_location(
        f"_route_under_test_{name}",
        os.path.join(_ROUTES_DIR, f"{name}.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Eagerly load the feature_flags router before the test session.
_feature_flags_module = _load_route("feature_flags")


def _gate() -> "Depends":
    """A single router-level dependency for the experiments_v1 flag.

    This is exactly what the production routers do:
        dependencies=[Depends(require_feature_flag("experiments_v1"))]
    """
    return Depends(require_feature_flag("experiments_v1"))


# Resolve the routes directory at import time.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROUTES_DIR = os.path.normpath(
    os.path.join(_THIS_DIR, "..", "..", "src", "eden", "api", "routes")
)


def _load_route(name: str) -> types.ModuleType:
    """Load a route module directly from its file.

    We do this to bypass the ``eden.api.routes.__init__`` package init,
    which eagerly imports ``jobs`` (which pulls in the langgraph chain,
    currently broken with ``cannot import name 'Command' from
    'langgraph.graph'`` in this env). The route modules themselves are
    standalone.
    """
    spec = importlib.util.spec_from_file_location(
        f"_route_under_test_{name}",
        os.path.join(_ROUTES_DIR, f"{name}.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Eagerly load the feature_flags router before the test session.
_feature_flags_module = _load_route("feature_flags")


def _build_test_app() -> FastAPI:
    """Build a minimal FastAPI app with the gated route stubs.

    Each route uses `require_feature_flag("experiments_v1")` as a
    router-level dep — exactly mirroring how the real production routers
    are wired. This is the thing under test.
    """
    app = FastAPI(title="eden-feature-flag-test-app")

    # Mirror the public /feature-flags endpoint shape (no auth).
    app.include_router(_feature_flags_module.router)

    # /jobs (gated)
    @app.get("/jobs", dependencies=[_gate()])
    async def list_jobs():
        return {"jobs": []}

    @app.post("/jobs", dependencies=[_gate()])
    async def create_job():
        return {"job_id": "stub"}

    # /specs (gated)
    @app.post("/specs/interview", dependencies=[_gate()])
    async def interview():
        return {"session_id": "stub"}

    @app.get("/specs", dependencies=[_gate()])
    async def list_specs():
        return {"specs": []}

    # /sandbox (gated)
    @app.get("/sandbox/sessions", dependencies=[_gate()])
    async def list_sandboxes():
        return {"sessions": []}

    # /experiments (gated)
    @app.post("/experiments/assign", dependencies=[_gate()])
    async def assign():
        return {"variant": "control"}

    # /evaluation (gated)
    @app.get("/evaluation/datasets", dependencies=[_gate()])
    async def datasets():
        return {"datasets": []}

    # /benchmark (gated)
    @app.post("/benchmark/create", dependencies=[_gate()])
    async def benchmark_create():
        return {"benchmark_id": "stub"}

    # /chain (gated)
    @app.get("/chain/config", dependencies=[_gate()])
    async def chain_config():
        return {"version": "test"}

    # /marketplace (gated)
    @app.post("/marketplace/cards", dependencies=[_gate()])
    async def marketplace_create():
        return {"card_id": "stub"}

    # /integrations/helicone (gated)
    @app.post("/integrations/helicone/webhook", dependencies=[_gate()])
    async def helicone_webhook():
        return {"status": "accepted"}

    # /orgs/{org_id}/multi-agent (gated)
    @app.post(
        "/orgs/{org_id}/multi-agent/messages",
        dependencies=[_gate()],
    )
    async def multi_agent_msg(org_id: str):
        return {"message_id": "stub"}

    # Unaffected route (sanity)
    @app.get("/health")
    async def health():
        return {"status": "ok"}

    return app


@pytest.fixture(scope="module")
def test_app():
    get_settings.cache_clear()
    yield _build_test_app()


@pytest.fixture
def client(test_app):
    return TestClient(test_app, raise_server_exceptions=False)


# ── Public flag endpoint ────────────────────────────────────────────────


def test_feature_flags_default_off(client):
    """/feature-flags must be reachable without auth and report flags off by default."""
    res = client.get("/feature-flags")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body == {"experiments_v1": False, "f70": False}


def test_feature_flags_endpoint_unauthenticated(client):
    """No auth headers should be required."""
    # No cookies, no auth headers — endpoint must still 200.
    res = client.get("/feature-flags", headers={})
    assert res.status_code == 200


# ── Gated routers return 404 when flag is off ──────────────────────────


def test_jobs_get_gated_off_returns_404(client):
    res = client.get("/jobs")
    assert res.status_code == 404, res.text


def test_jobs_post_gated_off_returns_404(client):
    res = client.post("/jobs", json={"description": "x", "tags": []})
    assert res.status_code == 404, res.text


def test_specs_get_gated_off_returns_404(client):
    res = client.get("/specs")
    assert res.status_code == 404, res.text


def test_specs_interview_gated_off_returns_404(client):
    res = client.post("/specs/interview", json={"message": "x"})
    assert res.status_code == 404, res.text


def test_sandbox_sessions_gated_off_returns_404(client):
    res = client.get("/sandbox/sessions")
    assert res.status_code == 404, res.text


def test_experiments_assign_gated_off_returns_404(client):
    res = client.post(
        "/experiments/assign",
        json={"experiment_key": "x", "user_id": "u", "variants": []},
    )
    assert res.status_code == 404, res.text


def test_evaluation_datasets_gated_off_returns_404(client):
    res = client.get("/evaluation/datasets")
    assert res.status_code == 404, res.text


def test_benchmark_create_gated_off_returns_404(client):
    res = client.post(
        "/benchmark/create",
        json={"benchmark_name": "x", "target_agents": ["executor"], "criteria": {}},
    )
    assert res.status_code == 404, res.text


def test_chain_config_gated_off_returns_404(client):
    res = client.get("/chain/config")
    assert res.status_code == 404, res.text


def test_marketplace_cards_gated_off_returns_404(client):
    res = client.post("/marketplace/cards", json={"title": "x"})
    assert res.status_code == 404, res.text


def test_helicone_webhook_gated_off_returns_404(client):
    res = client.post("/integrations/helicone/webhook", json={"event": "x"})
    assert res.status_code == 404, res.text


def test_multi_agent_gated_off_returns_404(client):
    res = client.post("/orgs/org-1/multi-agent/messages", json={"content": "x"})
    assert res.status_code == 404, res.text


# ── Sanity: non-gated endpoints still work ────────────────────────────


def test_health_endpoint_unaffected(client):
    """The /health endpoint must remain reachable regardless of the flag."""
    res = client.get("/health")
    assert res.status_code == 200, res.text


# ── Flag toggle: when ON, 404 is gone ──────────────────────────────────


def test_flag_toggle_roundtrip(monkeypatch, test_app):
    """When EXPERIMENTS_V1=true, the gated routes no longer 404."""
    get_settings.cache_clear()
    monkeypatch.setenv("EXPERIMENTS_V1", "true")
    try:
        # Force re-read of settings.
        s = get_settings()
        assert s.experiments_v1 is True

        # Build a fresh client so the new settings are read.
        client = TestClient(test_app, raise_server_exceptions=False)

        # /feature-flags now reports the flag as enabled.
        res = client.get("/feature-flags")
        assert res.status_code == 200
        assert res.json() == {"experiments_v1": True, "f70": False}

        # The gated routes are no longer 404'd by the feature-flag dep.
        # (They may still 401/403/500 because they are stubs without real
        # implementations, but the 404 returned by require_feature_flag is
        # gone.)
        res = client.get("/jobs")
        assert res.status_code != 404, res.text

        res = client.get("/chain/config")
        assert res.status_code != 404, res.text

        res = client.post("/benchmark/create", json={})
        assert res.status_code != 404, res.text
    finally:
        monkeypatch.delenv("EXPERIMENTS_V1", raising=False)
        get_settings.cache_clear()
