"""Real-service tests for Cat 23 (June 2026 audit pass).

Covers the 6 Cat 23 services whose STUB envelopes were replaced
with real implementations:

* :class:`BlastRadiusAnalyzer`
* :class:`PRExplanationService`
* :class:`PRQualityScorer`
* :class:`CodeRootCauseLinker`
* :class:`TestPlanRunner`
* :class:`CodeChangePolicyService`

Each test exercises the real code path with a mocked
:class:`ModelRouter` (no real LLM calls) + the auto-mocked
:class:`PostgresClient` from :mod:`tests.conftest`.
"""

from __future__ import annotations

import importlib
import os
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_org_member


def _fake_user() -> dict:
    return {"sub": "user-test", "org_id": "org-test", "email": "t@e.com"}


@pytest.fixture(scope="module")
def test_app() -> FastAPI:
    from eden.config import get_settings
    settings = get_settings()
    settings.intelligence_gap_v0 = True
    app = FastAPI(title="eden-cat23-real-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
    mod = importlib.import_module("eden.api.routes.intelligence_code_change")
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def client(test_app: FastAPI) -> TestClient:
    os.environ.setdefault("EDEN_FEATURE_INTELLIGENCE_GAP_V0", "true")
    return TestClient(test_app)


def _fake_router_response(content: str) -> Any:
    """Build a fake LLMResponse compatible with both sync + async paths."""
    from eden.llm.client import LLMResponse, UsageStats
    return LLMResponse(
        content=content,
        usage=UsageStats(prompt_tokens=10, completion_tokens=5, total_tokens=15, cost=0.0001),
        model="test-model",
        finish_reason="stop",
    )


@pytest.fixture
def fake_router(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """A ModelRouter stub whose ``aroute`` returns deterministic content."""
    router = MagicMock()

    async def _aroute(task: Any, prompt: str, **kwargs: Any) -> Any:
        # Return a value appropriate to the task's agent.
        agent = getattr(task, "agent", "")
        if "style" in agent or "pattern" in agent:
            return _fake_router_response(
                '{"title_format": "fix: <desc>", "body_template": "one_paragraph", '
                '"common_labels": ["eden-agent"], "common_reviewers": [], '
                '"common_branch_prefix": "eden/auto-fix"}'
            )
        if "explanation" in agent:
            return _fake_router_response(
                '{"what_happened": "user saw error", '
                '"why_it_happened": "off-by-one in retry_after", '
                '"what_patch_does": "increment retry_after by 1", '
                '"what_to_watch": "watch 24h post-merge"}'
            )
        if "quality" in agent or "idiomatic" in agent:
            return _fake_router_response("0.85")
        if "tester" in agent:
            return _fake_router_response(
                '["test_rate_limiter_retry_after_regression", '
                '"test_diff_happy_path", "test_diff_edge_case"]'
            )
        if "rca" in agent or "link" in agent:
            return _fake_router_response("src/rate_limiter.py")
        return _fake_router_response("0.5")

    monkeypatch.setattr(router, "aroute", _aroute)
    return router


# ── 1. BlastRadiusAnalyzer ─────────────────────────────────────────


class TestBlastRadiusAnalyzer:
    """Real LLM-classified static score + telemetry-count dynamic score."""

    def test_heuristic_static_score_no_router(self) -> None:
        from eden.code_change.blast_radius import BlastRadiusAnalyzer

        # No router → cheap heuristic based on file count.
        async def _run() -> dict[str, Any]:
            return await BlastRadiusAnalyzer().analyze(
                org_id="org-test",
                diff=(
                    "--- a/src/rate_limiter.py\n+++ b/src/rate_limiter.py\n@@ -1 +1 @@\n"
                    "-old\n+new\n"
                ),
                repo_id="repo-test",
            )

        import asyncio
        result = asyncio.run(_run())
        assert result["status"] == "ok"
        assert 0.0 <= result["data"]["blast_radius_score"] <= 1.0
        assert 0.0 <= result["data"]["static_score"] <= 1.0
        assert 0.0 <= result["data"]["dynamic_score"] <= 1.0
        # 40/60 split per v1.6 spec
        assert result["data"]["static_weight"] == 0.4
        assert result["data"]["dynamic_weight"] == 0.6
        assert "src/rate_limiter.py" in result["data"]["files_affected"]

    def test_diff_with_secret_is_zero_security(self) -> None:
        # Security scoring is inline, so the file path is exercised here.
        from eden.code_change.quality.quality_scorer import _security_score

        secret_diff = (
            "--- a/x.py\n+++ b/x.py\n"
            "+api_key = 'sk-1234567890abcdef1234'\n"
        )
        assert _security_score(secret_diff) == 0.0

        safe_diff = (
            "--- a/x.py\n+++ b/x.py\n"
            "+def hello(): return 'hi'\n"
        )
        assert _security_score(safe_diff) == 1.0

    def test_test_coverage_heuristic(self) -> None:
        from eden.code_change.quality.quality_scorer import _test_coverage_score

        # No new defs → perfect coverage
        assert _test_coverage_score("") == 1.0
        assert _test_coverage_score("+ x = 1") == 1.0
        # 2 new defs, 1 new test → ratio 0.5
        diff = (
            "+def foo(): pass\n"
            "+def bar(): pass\n"
            "+def test_foo(): assert foo() is None\n"
        )
        assert abs(_test_coverage_score(diff) - 0.5) < 1e-6


# ── 2. PRExplanationService ────────────────────────────────────────


class TestPRExplanationService:
    def test_templated_fallback_no_router(self) -> None:
        from eden.code_change.explanation import PRExplanationService

        async def _run() -> dict[str, Any]:
            return await PRExplanationService().generate(
                org_id="org-test",
                patch_id="patch-x",
                rca_summary="rca 42: rate limiter off-by-one",
                diff_summary="+ retry_after += 1",
                predicted_cost_savings_usd=42.0,
            )

        import asyncio
        result = asyncio.run(_run())
        assert result["status"] == "ok"
        # The 4 paragraphs are present even without an LLM.
        paragraphs = {p["label"] for p in result["data"]["paragraphs"]}
        assert paragraphs == {
            "what_happened",
            "why_it_happened",
            "what_patch_does",
            "what_to_watch",
        }
        assert result["data"]["model_used"] == "template"

    def test_router_driven_explanation(self, fake_router: MagicMock) -> None:
        from eden.code_change.explanation import PRExplanationService

        async def _run() -> dict[str, Any]:
            return await PRExplanationService(router=fake_router).generate(
                org_id="org-test",
                patch_id="patch-x",
                rca_summary="rca",
                diff_summary="+ fix",
                predicted_cost_savings_usd=10.0,
            )

        import asyncio
        result = asyncio.run(_run())
        assert result["status"] == "ok"
        assert "off-by-one" in result["data"]["explanation"]
        assert result["data"]["model_used"] == "anthropic/claude-sonnet-4"


# ── 3. PRQualityScorer ────────────────────────────────────────────


class TestPRQualityScorer:
    def test_overall_score_in_range(self, fake_router: MagicMock) -> None:
        from eden.code_change.quality.quality_scorer import PRQualityScorer

        async def _run() -> dict[str, Any]:
            return await PRQualityScorer(router=fake_router).score(
                org_id="org-test",
                patch_id="patch-x",
                diff="+ def hello(): return 'hi'\n",
                repo_id="repo-test",
            )

        import asyncio
        result = asyncio.run(_run())
        assert result["status"] == "ok"
        breakdown = result["data"]["quality_breakdown"]
        for k in (
            "style_compliance", "test_coverage", "complexity",
            "security", "idiomatic_fit",
        ):
            assert k in breakdown
            assert 0.0 <= breakdown[k] <= 1.0
        assert 0.0 <= result["data"]["quality_score"] <= 1.0


# ── 4. CodeRootCauseLinker ────────────────────────────────────────


class TestCodeRootCauseLinker:
    def test_stack_trace_extraction(self) -> None:
        from eden.code_change.rca_linker import _stack_trace_files

        stack = (
            'Traceback (most recent call last):\n'
            '  File "src/rate_limiter.py", line 42, in check_limit\n'
            '  File "src/server.py", line 100, in handle_request\n'
        )
        files = _stack_trace_files(stack)
        assert ("src/rate_limiter.py", 1.0) in files
        assert ("src/server.py", 1.0) in files

    def test_request_path_match(self) -> None:
        from eden.code_change.rca_linker import _request_path_files

        cands = ["src/api/users.py", "src/api/orders.py", "src/main.py"]
        # /api/users matches src/api/users.py at 0.8 confidence
        out = _request_path_files("/api/users/123", cands)
        assert any(p == "src/api/users.py" and c == 0.8 for p, c in out)

    def test_link_combines_sources(self, fake_router: MagicMock) -> None:
        from eden.code_change.rca_linker import CodeRootCauseLinker

        async def _run() -> dict[str, Any]:
            return await CodeRootCauseLinker(router=fake_router).link(
                org_id="org-test",
                rca_id="rca-x",
                repo_id="repo-test",
                stack_trace='File "src/rate_limiter.py", line 42, in check',
                request_path="/api/rate",
                candidate_files=["src/rate_limiter.py", "src/api/users.py"],
            )

        import asyncio
        result = asyncio.run(_run())
        assert result["status"] == "ok"
        assert result["data"]["primary_path"] == "src/rate_limiter.py"
        assert result["data"]["primary_confidence"] > 0.0


# ── 5. TestPlanRunner ─────────────────────────────────────────────


class TestTestPlanRunner:
    def test_heuristic_plan_no_router(self) -> None:
        from eden.code_change.test_runner import TestPlanRunner

        async def _run() -> dict[str, Any]:
            return await TestPlanRunner().generate_plan(
                org_id="org-test",
                patch_id="patch-x",
                rca_summary="rate limiter off by one",
                diff="+ retry_after += 1",
            )

        import asyncio
        result = asyncio.run(_run())
        assert result["status"] == "ok"
        plan = result["data"]["test_plan"]
        assert isinstance(plan, list)
        assert len(plan) >= 3

    def test_router_generates_structured_plan(
        self, fake_router: MagicMock,
    ) -> None:
        from eden.code_change.test_runner import TestPlanRunner

        async def _run() -> dict[str, Any]:
            return await TestPlanRunner(router=fake_router).generate_plan(
                org_id="org-test",
                patch_id="patch-x",
                rca_summary="rca",
                diff="+ fix",
            )

        import asyncio
        result = asyncio.run(_run())
        plan = result["data"]["test_plan"]
        # 3 tests as configured in the fake_router fixture.
        assert len(plan) == 3
        assert plan[0].startswith("test_")


# ── 6. CodeChangePolicyService ────────────────────────────────────


class TestCodeChangePolicyService:
    def test_get_returns_defaults_when_empty(self) -> None:
        from eden.code_change.policy import CodeChangePolicyService

        async def _run() -> dict[str, Any]:
            return await CodeChangePolicyService().get(org_id="org-test")

        import asyncio
        result = asyncio.run(_run())
        assert result["status"] == "ok"
        assert "policy" in result["data"]
        assert result["data"]["policy"]["code_change_enabled"] is False
        assert result["data"]["policy_source"] == "defaults"

    def test_update_validates_boolean_fields(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.code_change.policy import CodeChangePolicyService

        async def _run() -> dict[str, Any]:
            return await CodeChangePolicyService().update(
                org_id="org-test",
                policy={"code_change_enabled": "yes"},  # invalid: should be bool
            )

        import asyncio
        result = asyncio.run(_run())
        assert result["status"] == "bad_request"
        assert "must be a bool" in result["message"]

    def test_update_validates_pct_range(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.code_change.policy import CodeChangePolicyService

        async def _run() -> dict[str, Any]:
            return await CodeChangePolicyService().update(
                org_id="org-test",
                policy={"min_quality_score": 1.5},  # out of range
            )

        import asyncio
        result = asyncio.run(_run())
        assert result["status"] == "bad_request"
        assert "must be a number in [0, 1]" in result["message"]


# ── 7. New routes reach the right service ────────────────────────


class TestNewRoutesReachServices:
    """Smoke tests for the 9 new routes added in B9."""

    def test_get_style_profile_route(
        self, client: TestClient, mock_postgres_client: MagicMock
    ) -> None:
        resp = client.get(
            "/orgs/org-test/intelligence/code-change/repos/repo-x/style"
        )
        assert resp.status_code == 200, resp.text
        # Defaults (no row in DB)
        assert resp.json()["data"]["source"] == "defaults"

    def test_get_pr_patterns_route(
        self, client: TestClient, mock_postgres_client: MagicMock
    ) -> None:
        resp = client.get(
            "/orgs/org-test/intelligence/code-change/repos/repo-x/patterns"
        )
        assert resp.status_code == 200, resp.text
        assert "title_format" in resp.json()["data"]

    def test_get_knowledge_summary_route(
        self, client: TestClient, mock_postgres_client: MagicMock
    ) -> None:
        resp = client.get(
            "/orgs/org-test/intelligence/code-change/repos/repo-x/knowledge"
        )
        assert resp.status_code == 200, resp.text

    def test_post_rca_link_route(
        self, client: TestClient, mock_postgres_client: MagicMock,
        fake_router: MagicMock,
    ) -> None:
        resp = client.post(
            "/orgs/org-test/intelligence/code-change/rca/link",
            json={
                "rca_id": "rca-x",
                "rca_description": "off-by-one in retry_after",
                "stack_trace": (
                    'File "src/rate_limiter.py", line 42, in check_limit'
                ),
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()["data"]
        assert "primary_path" in body
