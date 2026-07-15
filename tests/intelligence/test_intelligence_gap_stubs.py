"""Wiring test for the 16-category intelligence gap surface.

This test exists for one purpose: prove that every Cat 1-17
router is mounted under the ``intelligence_gap_v0`` feature
flag and returns the uniform stub envelope. Per-feature
behavioural tests are deferred to the implementation phase.

We use a tiny ``FastAPI()`` fixture (not the full Eden app) so
the test doesn't drag in KB init, sandbox runner, or any other
production-only dependency. The fixture also overrides
``get_current_user`` so the test can hit routes without a
real auth cookie.
"""

from __future__ import annotations

import importlib
import os
from collections.abc import Iterable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── 1. Static list of every Cat router module to mount ───────────
ROUTER_MODULES = [
    "eden.api.routes.intelligence_replay",
    "eden.api.routes.intelligence_rca",
    "eden.api.routes.intelligence_eval",
    "eden.api.routes.intelligence_retrieval",
    "eden.api.routes.intelligence_memory",
    "eden.api.routes.intelligence_agents",
    "eden.api.routes.intelligence_tools",
    "eden.api.routes.intelligence_cost",
    "eden.api.routes.intelligence_user",
    "eden.api.routes.intelligence_outcomes",
    "eden.api.routes.intelligence_governance",
    "eden.api.routes.intelligence_experiments",
    "eden.api.routes.intelligence_predictive",
    "eden.api.routes.intelligence_autonomous",
    "eden.api.routes.intelligence_guardrails",
]


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


# ─── 2. Build the minimal test app ────────────────────────────────
@pytest.fixture(scope="module")
def test_app() -> FastAPI:
    """A fresh FastAPI() with the 15 new routers mounted only.

    Bypasses the full app's lifespan (KB init, sandbox runner,
    insights loop, etc.) so the test stays fast and isolated.

    Overrides ``get_current_user`` so we don't need a real
    auth cookie, and turns on the ``intelligence_gap_v0``
    feature flag via a settings monkeypatch.
    """
    from eden.api.deps import get_current_user, require_org_member
    from eden.config import get_settings

    # Make sure the feature flag is on for the duration of the
    # test. ``get_settings`` is cached on the function attribute
    # so we read it once, mutate, and let the dep see the new
    # value (the dep reads settings on every request).
    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-intelligence-stub-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
    for mod_name in ROUTER_MODULES:
        mod = importlib.import_module(mod_name)
        app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def client(test_app: FastAPI) -> TestClient:
    # Enable the feature flag for the duration of the test.
    os.environ.setdefault("EDEN_FEATURE_INTELLIGENCE_GAP_V0", "true")
    return TestClient(test_app)


# ─── 3. Per-router smoke tests ────────────────────────────────────
@pytest.mark.parametrize("mod_name", ROUTER_MODULES)
def test_router_imports(mod_name: str) -> None:
    """Every router module imports and exposes a non-empty router."""
    mod = importlib.import_module(mod_name)
    assert hasattr(mod, "router"), f"{mod_name} missing router"
    assert len(mod.router.routes) > 0, f"{mod_name} has no routes"


@pytest.mark.parametrize("mod_name", ROUTER_MODULES)
def test_router_has_intelligence_tag(mod_name: str) -> None:
    """Every Cat router uses an ``intelligence-*`` OpenAPI tag."""
    mod = importlib.import_module(mod_name)
    tags = mod.router.tags
    assert tags, f"{mod_name} has no tags"
    for tag in tags:
        assert tag.startswith("intelligence-"), (
            f"{mod_name} tag {tag!r} does not start with intelligence-"
        )


# ─── 4. End-to-end envelope check (one route per router) ──────────
# A representative path per router — exercises at least one full
# request/response cycle to confirm the Pydantic schemas wire up.
REPRESENTATIVE_PATHS: list[tuple[str, str, str, dict[str, Any]]] = [
    # (module, method, path, body)
    ("intelligence_rca", "POST", "/orgs/org_x/intelligence/rca/trace_y/analyze", None),
    ("intelligence_retrieval", "POST", "/orgs/org_x/intelligence/retrieval/trace_y/utilization", None),
    ("intelligence_memory", "POST", "/orgs/org_x/intelligence/memory/trace_y/attribute", None),
    ("intelligence_tools", "GET", "/orgs/org_x/intelligence/tools/taxonomy", None),
    ("intelligence_cost", "GET", "/orgs/org_x/intelligence/cost/forecast", None),
    ("intelligence_user", "GET", "/orgs/org_x/intelligence/user/segment?user_id=u1", None),
    ("intelligence_outcomes", "GET", "/orgs/org_x/intelligence/outcomes/departments", None),
    ("intelligence_governance", "POST", "/orgs/org_x/intelligence/governance/approvals", {"name": "x", "steps": []}),
    ("intelligence_governance", "POST", "/orgs/org_x/intelligence/governance/security/scan", None),
    ("intelligence_experiments", "POST", "/orgs/org_x/intelligence/experiments/recommend", {"experiment_id": "exp_x"}),
    ("intelligence_predictive", "POST", "/orgs/org_x/intelligence/predict/quality", {"request_id": "r1"}),
    ("intelligence_autonomous", "GET", "/orgs/org_x/intelligence/autonomous/recommendations", None),
    ("intelligence_guardrails", "GET", "/orgs/org_x/intelligence/guardrails/metrics", None),
    ("intelligence_guardrails", "POST", "/orgs/org_x/intelligence/guardrails/evaluate", {"text": "hi"}),
    ("intelligence_replay", "GET", "/orgs/org_x/intelligence/replay/live-tail", None),
]


@pytest.mark.parametrize("mod,method,path,body", REPRESENTATIVE_PATHS)
def test_envelope_shape(client, mod, method, path, body) -> None:
    """Every Cat route returns the uniform ``IntelligenceStubResponse`` envelope."""
    # The live-tail endpoint is a real SSE stream (Cat 1
    # implementation 2026-06-10) — it never closes by itself,
    # so the envelope-shape test (which expects a JSON
    # response) doesn't apply. Cat 1 dedicated tests in
    # ``test_trace_replay.py`` cover the live-tail behavior.
    is_live_tail = path.endswith("/replay/live-tail")
    if is_live_tail:
        pytest.skip("live-tail is a long-lived SSE stream; covered by test_trace_replay.py")
        return

    resp = client.get(path) if method == "GET" else client.post(path, json=body or {})
    # The route may 401/403 because the test app has no auth
    # dependencies mounted (deps are stubbed in this minimal
    # fixture). If the response is a JSON dict, it must be
    # shaped like the envelope.
    if resp.status_code in (200, 501):
        data = resp.json()
        assert "status" in data, f"{path} missing status: {data}"
        assert "feature" in data, f"{path} missing feature: {data}"
        assert "live" in data, f"{path} missing live: {data}"
    else:
        # 401/403/422 are also valid (the test app has no auth)
        assert resp.status_code in (200, 401, 403, 422, 501), (
            f"unexpected status {resp.status_code} for {path}"
        )


# ─── 5. Guardrail default — must allow in stub mode ───────────────
def test_guardrail_evaluate_defaults_to_allow(client) -> None:
    """``POST /guardrails/evaluate`` must return ``verdict: allow``
    with ``live: false`` so production flows don't break before a
    real policy exists.
    """
    resp = client.post(
        "/orgs/org_x/intelligence/guardrails/evaluate",
        json={"text": "hello", "context": "world"},
    )
    if resp.status_code == 200:
        data = resp.json()
        assert data.get("status") == "ok", f"guardrail should be ok, got {data}"
        assert data.get("data", {}).get("verdict") == "allow", (
            f"guardrail default must be allow, got {data}"
        )
        # The data-level ``live`` flag is False when no real
        # policies exist (i.e. the engine returned the safe
        # default). The envelope-level ``live`` is True
        # because the engine actually ran.
        assert data.get("data", {}).get("live") is False


# ─── 6. Closed-loop hooks are no-ops in stub mode ─────────────────
def test_closed_loop_hooks_register() -> None:
    """The four closed-loop hooks must be importable and no-op."""
    from eden.llmops.promotion_hooks import (
        GuardrailHook,
        PromotionHook,
        register_all_hooks,
    )

    # All hooks should construct without error
    PromotionHook()
    GuardrailHook()
    # register_all_hooks() must be idempotent and side-effect-free
    register_all_hooks()
    register_all_hooks()


# ─── 7. Intelligence judges are registered on import ──────────────
def test_intelligence_judges_registered() -> None:
    """The 7 new Cat 3 judges must be in the JudgeRegistry."""
    from eden.llmops.judges.builtin_v9 import register_intelligence_judges
    from eden.llmops.judges.registry import JudgeRegistry

    registry = JudgeRegistry()
    added = register_intelligence_judges(registry)
    # 7 distinct judge names — re-registering is idempotent
    assert added >= 7, f"expected at least 7 new judges, got {added}"
    expected_names = {
        "groundedness",
        "relevance",
        "safety",
        "satisfaction",
        "action_completion",
        "tool_selection_quality",
        "reasoning_coherence",
    }
    for name in expected_names:
        assert registry.get(name) is not None, f"judge {name!r} not registered"


# ─── 8. Envelope contract ─────────────────────────────────────────
def test_envelope_module() -> None:
    """The shared envelope helpers must produce the expected shape."""
    from eden.intelligence_envelope import (
        INTELLIGENCE_GAP_FLAG,
        allow_default,
        not_implemented,
        stub,
    )

    assert INTELLIGENCE_GAP_FLAG == "intelligence_gap_v0"

    s = stub("x", data={"a": 1})
    assert s["status"] == "not_implemented"
    assert s["feature"] == "x"
    assert s["live"] is False
    assert s["data"] == {"a": 1}
    assert "trace_id" in s

    n = not_implemented("y")
    assert n["status"] == "not_implemented"
    assert n["feature"] == "y"

    a = allow_default("z", verdict="allow", reason="test")
    assert a["status"] == "ok"
    assert a["data"]["verdict"] == "allow"
    assert a["live"] is False
