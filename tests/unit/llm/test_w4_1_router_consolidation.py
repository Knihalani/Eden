"""W4-1 prerequisite (8.7): smoke + contract tests for model_router,
ai_gateway, and internal_router behaviours that callers rely on.

These tests pin the observable interface so the consolidation into
eden.llm.client cannot silently break callers.  The tests import from
the canonical locations (eden.optimization.model_router,
eden.llmops.ai_gateway, eden.llm.internal_router) so the same suite
validates both the original modules and the post-consolidation compat
shims.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.llm.client import LLMResponse, UsageStats


# ── Helpers ─────────────────────────────────────────────────────────────────

def _resp(content: str = "word " * 20) -> LLMResponse:
    """Return a minimal LLMResponse."""
    return LLMResponse(
        content=content,
        usage=UsageStats(prompt_tokens=10, completion_tokens=20, total_tokens=30),
        model="deepseek/deepseek-v4-flash-0731",
        finish_reason="stop",
    )


# ── model_router: tiers share model ─────────────────────────────────────────

class TestChatTiersShareModel:
    """After the DeepSeek collapse all Eden tiers resolve to the same model."""

    def test_tiers_share_model_is_true(self):
        from eden.optimization.model_router import _chat_tiers_share_model
        assert _chat_tiers_share_model() is True

    def test_t1_t2_t3_primary_model_identical(self):
        from eden.optimization.model_router import TIER_MODELS, ModelTier
        t1 = TIER_MODELS[ModelTier.T1][0]
        t2 = TIER_MODELS[ModelTier.T2][0]
        t3 = TIER_MODELS[ModelTier.T3][0]
        assert t1 == t2 == t3, (
            f"T1/T2/T3 must share model; got T1={t1!r} T2={t2!r} T3={t3!r}"
        )

    def test_t4_is_distinct_placeholder(self):
        from eden.optimization.model_router import TIER_MODELS, ModelTier
        t1 = TIER_MODELS[ModelTier.T1][0]
        t4 = TIER_MODELS[ModelTier.T4][0]
        assert t1 != t4, "T4 should remain a distinct custom tier"


# ── model_router: TaskClassifier heuristic path ──────────────────────────────

class TestTaskClassifierHeuristic:
    """classify() always uses heuristic path when T1/T2/T3 share model."""

    @pytest.mark.asyncio
    async def test_classify_fast_slot_returns_t1(self):
        from eden.optimization.model_router import (
            ModelTier, PipelineTask, TaskClassifier,
        )
        clf = TaskClassifier()
        task = PipelineTask(agent="patch_critic", description="critique", slot="fast")
        result = await clf.classify(task)
        assert result.tier == ModelTier.T1
        assert result.heuristic_used is True

    @pytest.mark.asyncio
    async def test_classify_reasoning_slot_returns_t2_or_t3(self):
        from eden.optimization.model_router import (
            ModelTier, PipelineTask, TaskClassifier,
        )
        clf = TaskClassifier()
        task = PipelineTask(agent="planner", description="plan a feature", slot="reasoning")
        result = await clf.classify(task)
        assert result.tier in (ModelTier.T2, ModelTier.T3)
        assert result.heuristic_used is True

    @pytest.mark.asyncio
    async def test_classify_never_calls_llm_client(self):
        """When tiers share model, classify() must not call the LLM."""
        from eden.optimization.model_router import PipelineTask, TaskClassifier
        mock_client = MagicMock()
        clf = TaskClassifier(llm_client=mock_client)
        task = PipelineTask(agent="any_agent", description="ambiguous", slot="reasoning")
        await clf.classify(task)
        mock_client.call.assert_not_called()

    @pytest.mark.asyncio
    async def test_heuristic_hits_counter_increments(self):
        from eden.optimization.model_router import PipelineTask, TaskClassifier
        clf = TaskClassifier()
        task = PipelineTask(agent="extract", description="extract data", slot="fast")
        await clf.classify(task)
        stats = clf.get_stats()
        assert stats["heuristic_hits"] >= 1

    @pytest.mark.asyncio
    async def test_heuristic_rate_is_one(self):
        """All classifications must go through heuristic when tiers share."""
        from eden.optimization.model_router import PipelineTask, TaskClassifier
        clf = TaskClassifier()
        for slot in ("fast", "reasoning", "code", "extraction"):
            task = PipelineTask(agent="x", description="desc", slot=slot)
            await clf.classify(task)
        stats = clf.get_stats()
        assert stats["heuristic_rate"] == 1.0


# ── model_router: ModelRouter.route() ────────────────────────────────────────

class TestModelRouterRoute:
    """ModelRouter.route() contract: single tier, counters, error handling."""

    def test_route_returns_response_on_success(self):
        from eden.optimization.model_router import ModelRouter, PipelineTask
        mock_client = MagicMock()
        mock_client.call.return_value = _resp()
        router = ModelRouter(llm_client=mock_client)
        task = PipelineTask(
            agent="tester", description="test", slot="fast",
            requires_quality_check=False,
        )
        response = router.route(task, "test prompt")
        assert response.content is not None
        mock_client.call.assert_called_once()

    def test_route_increments_calls_by_tier(self):
        from eden.optimization.model_router import ModelRouter, ModelTier, PipelineTask
        mock_client = MagicMock()
        mock_client.call.return_value = _resp()
        router = ModelRouter(llm_client=mock_client)
        task = PipelineTask(
            agent="tester", description="test", slot="fast",
            requires_quality_check=False,
        )
        router.route(task, "prompt")
        stats = router.get_stats()
        assert stats["total_calls"] == 1
        assert stats["calls_by_tier"][ModelTier.T1.value] == 1

    def test_route_raises_max_retries_when_all_models_fail(self):
        from eden.optimization.model_router import (
            MaxRetriesExceededError, ModelRouter, PipelineTask,
        )
        mock_client = MagicMock()
        mock_client.call.side_effect = RuntimeError("upstream down")
        router = ModelRouter(llm_client=mock_client)
        task = PipelineTask(
            agent="tester", description="test", slot="fast",
            requires_quality_check=False,
        )
        with pytest.raises(MaxRetriesExceededError):
            router.route(task, "prompt")

    def test_route_fallback_counter_increments_when_tier_fails(self):
        from eden.optimization.model_router import ModelRouter, PipelineTask
        mock_client = MagicMock()
        mock_client.call.side_effect = RuntimeError("fail")
        router = ModelRouter(llm_client=mock_client)
        task = PipelineTask(agent="x", description="x", slot="fast")
        try:
            router.route(task, "p")
        except Exception:
            pass
        stats = router.get_stats()
        assert stats["fallbacks"] >= 1

    def test_route_with_org_and_feature_sets_cost_context(self):
        """route() with org_id/feature binds cost_context without error."""
        from eden.optimization.model_router import ModelRouter, PipelineTask
        mock_client = MagicMock()
        mock_client.call.return_value = _resp()
        router = ModelRouter(llm_client=mock_client)
        task = PipelineTask(
            agent="tester", description="test", slot="fast",
            requires_quality_check=False, org_id="test-org",
        )
        response = router.route(task, "prompt", org_id="test-org", feature="patches")
        assert response is not None


# ── model_router: ModelRouter.aroute() ───────────────────────────────────────

class TestModelRouterAroute:
    """ModelRouter.aroute() async contract."""

    @pytest.mark.asyncio
    async def test_aroute_returns_response_on_success(self):
        from eden.optimization.model_router import ModelRouter, PipelineTask
        mock_client = MagicMock()
        mock_client.call.return_value = _resp()
        router = ModelRouter(llm_client=mock_client)
        task = PipelineTask(
            agent="tester", description="test", slot="fast",
            requires_quality_check=False,
        )
        resp = await router.aroute(task, "prompt")
        assert resp.content is not None

    @pytest.mark.asyncio
    async def test_aroute_raises_max_retries_when_all_models_fail(self):
        from eden.optimization.model_router import (
            MaxRetriesExceededError, ModelRouter, PipelineTask,
        )
        mock_client = MagicMock()
        mock_client.call.side_effect = RuntimeError("down")
        router = ModelRouter(llm_client=mock_client)
        task = PipelineTask(
            agent="tester", description="test", slot="fast",
            requires_quality_check=False,
        )
        with pytest.raises(MaxRetriesExceededError):
            await router.aroute(task, "prompt")


# ── model_router: get_stats shape ────────────────────────────────────────────

class TestModelRouterStats:
    """get_stats() returns the expected keys (callers access these by name)."""

    def test_get_stats_keys(self):
        from eden.optimization.model_router import ModelRouter
        router = ModelRouter(llm_client=MagicMock())
        stats = router.get_stats()
        for key in (
            "calls_by_tier", "total_calls", "fallbacks",
            "validation_failures", "fallback_rate", "classifier_stats",
        ):
            assert key in stats, f"Missing key: {key!r}"

    def test_classifier_stats_keys(self):
        from eden.optimization.model_router import ModelRouter
        router = ModelRouter(llm_client=MagicMock())
        clf_stats = router.get_stats()["classifier_stats"]
        for key in ("heuristic_hits", "llm_classifications", "heuristic_rate"):
            assert key in clf_stats, f"Missing classifier key: {key!r}"


# ── MaxRetriesExceededError importable from both paths ───────────────────────

class TestMaxRetriesExceededErrorCompat:
    def test_importable_from_model_router(self):
        from eden.optimization.model_router import MaxRetriesExceededError
        assert issubclass(MaxRetriesExceededError, Exception)

    def test_importable_from_llm_client(self):
        from eden.llm.client import MaxRetriesExceededError
        assert issubclass(MaxRetriesExceededError, Exception)


# ── internal_router: route_sync / route_async ────────────────────────────────

class TestInternalRouterRouteSync:
    """route_sync wires through ModelRouter.route()."""

    def test_route_sync_delegates_to_router(self):
        from eden.llm.internal_router import route_sync
        mock_router = MagicMock()
        mock_router.route.return_value = _resp()
        with patch("eden.llm.internal_router.get_router", return_value=mock_router):
            resp = route_sync("agent", "prompt", slot="fast")
        assert resp.content is not None
        mock_router.route.assert_called_once()

    def test_route_sync_passes_task_with_correct_agent(self):
        from eden.llm.internal_router import route_sync
        mock_router = MagicMock()
        mock_router.route.return_value = _resp()
        with patch("eden.llm.internal_router.get_router", return_value=mock_router):
            route_sync("my_agent", "some prompt", slot="fast")
        task = mock_router.route.call_args[0][0]
        assert task.agent == "my_agent"
        assert task.slot == "fast"


class TestInternalRouterRouteAsync:
    """route_async wires through ModelRouter.aroute()."""

    @pytest.mark.asyncio
    async def test_route_async_delegates_to_router(self):
        from eden.llm.internal_router import route_async
        mock_router = MagicMock()
        mock_router.aroute = AsyncMock(return_value=_resp())
        with patch("eden.llm.internal_router.get_router", return_value=mock_router):
            resp = await route_async("agent", "prompt", slot="fast")
        assert resp.content is not None
        mock_router.aroute.assert_awaited_once()


class TestBuildTask:
    """build_task produces a PipelineTask with correct defaults."""

    def test_build_task_defaults(self):
        from eden.llm.internal_router import build_task
        from eden.optimization.model_router import PipelineTask
        task = build_task("test_agent")
        assert isinstance(task, PipelineTask)
        assert task.agent == "test_agent"
        assert task.slot == "fast"
        assert task.output_type == "json"

    def test_build_task_with_org_id(self):
        from eden.llm.internal_router import build_task
        task = build_task("agent", org_id="org-123", slot="reasoning")
        assert task.org_id == "org-123"
        assert task.slot == "reasoning"


class TestResolveModels:
    """resolve_models returns (tier, model_chain) for streaming callers."""

    @pytest.mark.asyncio
    async def test_resolve_models_returns_tier_and_chain(self):
        from eden.llm.internal_router import resolve_models
        from eden.optimization.model_router import ModelTier
        tier, models = await resolve_models("planner", slot="reasoning")
        assert isinstance(tier, ModelTier)
        assert isinstance(models, list)
        assert len(models) >= 1

    @pytest.mark.asyncio
    async def test_resolve_models_fast_slot_returns_t1(self):
        from eden.llm.internal_router import resolve_models
        from eden.optimization.model_router import ModelTier
        tier, models = await resolve_models("patch_critic", slot="fast")
        assert tier == ModelTier.T1


# ── ai_gateway: AIGateway contract ───────────────────────────────────────────

class TestAIGatewayFiltersContract:
    """AIGateway filter chain is importable and the metrics dict is correct."""

    def test_ai_gateway_importable(self):
        from eden.llmops.ai_gateway import AIGateway, ModelRequest, ModelResponse  # noqa: F401
        assert AIGateway is not None

    def test_filter_metrics_includes_pii_by_default(self):
        from eden.llmops.ai_gateway import AIGateway
        gw = AIGateway()
        metrics = gw.get_filter_metrics()
        names = metrics.get("filter_names", [])
        assert any("pii" in n.lower() for n in names), (
            f"Expected a PII filter in {names}"
        )

    def test_filter_metrics_keys(self):
        from eden.llmops.ai_gateway import AIGateway
        gw = AIGateway()
        metrics = gw.get_filter_metrics()
        for key in ("invocations", "findings", "errors", "filter_names"):
            assert key in metrics

    def test_register_custom_filter_appears_in_names(self):
        from eden.llmops.ai_gateway import AIGateway
        from eden.llmops.filters.base import GatewayFilter

        class _TestFilter:
            name = "test_filter_w4"

            def enabled(self, request):
                return True

            def apply(self, request):
                return request, []

        assert isinstance(_TestFilter(), GatewayFilter)  # Protocol check
        gw = AIGateway()
        gw.register_filter(_TestFilter())
        names = gw.get_filter_metrics()["filter_names"]
        assert "test_filter_w4" in names

    def test_unregister_filter_removes_it(self):
        from eden.llmops.ai_gateway import AIGateway
        from eden.llmops.filters.base import GatewayFilter

        class _Remove:
            name = "remove_me_w4"

            def enabled(self, request):
                return True

            def apply(self, request):
                return request, []

        assert isinstance(_Remove(), GatewayFilter)
        gw = AIGateway()
        gw.register_filter(_Remove())
        count = gw.unregister_filter("remove_me_w4")
        assert count == 1
        names = gw.get_filter_metrics()["filter_names"]
        assert "remove_me_w4" not in names

    def test_model_request_prompt_hash_is_stable(self):
        from eden.llmops.ai_gateway import ModelRequest
        req = ModelRequest(model_family="openai", model_version="gpt-4o", prompt="hello world")
        h1 = req.prompt_hash
        h2 = req.prompt_hash
        assert h1 == h2
        assert len(h1) > 8

    def test_model_request_prompt_hash_varies_by_prompt(self):
        from eden.llmops.ai_gateway import ModelRequest
        r1 = ModelRequest(model_family="openai", model_version="gpt-4o", prompt="prompt one")
        r2 = ModelRequest(model_family="openai", model_version="gpt-4o", prompt="prompt two")
        assert r1.prompt_hash != r2.prompt_hash


class TestAIGatewayCostEstimate:
    """AIGateway._estimate_cost / resolve_cost contract."""

    def test_self_hosted_provider_cost_is_zero(self):
        from eden.llmops.ai_gateway import AIGateway, Provider
        gw = AIGateway()
        cost = gw._estimate_cost(Provider.LLAMACPP, 1000, 500, "any-model")
        assert cost == 0.0

    def test_unknown_model_returns_nonnegative_cost(self):
        from eden.llmops.ai_gateway import AIGateway, Provider
        gw = AIGateway()
        cost = gw._estimate_cost(Provider.OPENROUTER, 1000, 500, "nonexistent-xyz")
        assert cost >= 0.0

    @pytest.mark.asyncio
    async def test_resolve_cost_self_hosted_returns_zero_source(self):
        from eden.llmops.ai_gateway import AIGateway, Provider
        gw = AIGateway()
        cost, source, no_cache, cache_cost = await gw.resolve_cost(
            Provider.LLAMACPP, 100, 50, "any"
        )
        assert cost == 0.0
        assert source == "self_hosted"


# ── Import smoke tests ────────────────────────────────────────────────────────

class TestImportSmoke:
    """All three layers must be importable without side effects."""

    def test_import_llm_client(self):
        from eden.llm.client import (  # noqa: F401
            CircuitBreaker, LLMResponse, MaxRetriesExceededError,
            OpenRouterClient, get_llm_client,
        )
        assert get_llm_client is not None

    def test_import_llm_internal_router(self):
        from eden.llm.internal_router import (  # noqa: F401
            build_task, get_router, resolve_models, route_async, route_sync,
        )

    def test_import_optimization_model_router(self):
        from eden.optimization.model_router import (  # noqa: F401
            TIER_MODELS, ClassificationResult, MaxRetriesExceededError,
            ModelRouter, ModelTier, PipelineTask, QualityValidator,
            TaskClassifier, ValidationResult,
        )
        assert ModelRouter is not None
        assert TIER_MODELS is not None

    def test_import_llmops_ai_gateway(self):
        from eden.llmops.ai_gateway import (  # noqa: F401
            AIGateway, ModelRequest, ModelResponse, Provider,
        )
        assert AIGateway is not None

    def test_import_optimization_package(self):
        from eden.optimization import (  # noqa: F401
            ModelRouter, ModelTier, QualityValidator, TaskClassifier,
            ValidationResult,
        )
        assert ModelRouter is not None

    def test_import_llmops_package(self):
        from eden.llmops import AIGateway, ModelRequest, ModelResponse  # noqa: F401
        assert AIGateway is not None

    def test_three_module_import_smoke(self):
        import eden.llm.client  # noqa: F401
        import eden.llmops  # noqa: F401
        import eden.optimization  # noqa: F401
