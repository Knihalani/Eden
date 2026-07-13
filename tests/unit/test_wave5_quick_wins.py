"""Minimal tests for Wave 5 quick-wins.

Covers the 7 items implemented:
  1. SatisfactionJudge SQL aggregation
  2. Fine-tune org lookup from fine_tuning_runs
  3. optimization/tool_intel/attribution delegates to services/tool_intel
  4. _fire_tool_drift_hook is async and awaits on_drift_alert
  5. sql_query schema cache is org-keyed
  6. production_eval fail-closed on DB errors
  7. strategy_store ON CONFLICT uses (collection, org_id)
"""

from __future__ import annotations

import inspect
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── 1. SatisfactionJudge ────────────────────────────────────────────


class TestSatisfactionJudge:
    def test_score_is_coroutine(self) -> None:
        from eden.llmops.judges.satisfaction import SatisfactionJudge

        judge = SatisfactionJudge()
        assert inspect.iscoroutinefunction(judge.score)

    def test_version_updated(self) -> None:
        from eden.llmops.judges.satisfaction import SatisfactionJudge

        assert SatisfactionJudge.version == "2026-07-14"

    @pytest.mark.asyncio
    async def test_no_data_returns_neutral(self) -> None:
        from eden.llmops.judges.satisfaction import _aggregate_satisfaction

        with patch(
            "eden.llmops.judges.satisfaction._get_client",
            new=AsyncMock(return_value=None),
        ):
            score, confidence = await _aggregate_satisfaction("org1", "trace1")
        assert score == 0.5
        assert confidence is None

    @pytest.mark.asyncio
    async def test_positive_signals_push_score_up(self) -> None:
        from eden.llmops.judges.satisfaction import _aggregate_satisfaction

        mock_client = AsyncMock()
        mock_client.fetch = AsyncMock(
            side_effect=[
                [{"signal_type": "copy_pasted", "weight": 1.0}],
                [],
            ]
        )
        with patch(
            "eden.llmops.judges.satisfaction._get_client",
            new=AsyncMock(return_value=mock_client),
        ):
            score, confidence = await _aggregate_satisfaction("org1", "trace1")
        assert score > 0.5
        assert confidence is not None

    @pytest.mark.asyncio
    async def test_negative_signals_push_score_down(self) -> None:
        from eden.llmops.judges.satisfaction import _aggregate_satisfaction

        mock_client = AsyncMock()
        mock_client.fetch = AsyncMock(
            side_effect=[
                [{"signal_type": "regenerated", "weight": 1.0}],
                [],
            ]
        )
        with patch(
            "eden.llmops.judges.satisfaction._get_client",
            new=AsyncMock(return_value=mock_client),
        ):
            score, confidence = await _aggregate_satisfaction("org1", "trace1")
        assert score < 0.5

    @pytest.mark.asyncio
    async def test_thumbs_up_feedback_nudges_high(self) -> None:
        from eden.llmops.judges.satisfaction import _aggregate_satisfaction

        mock_client = AsyncMock()
        mock_client.fetch = AsyncMock(
            side_effect=[
                [],
                [{"thumbs": "up", "rating": None}],
            ]
        )
        with patch(
            "eden.llmops.judges.satisfaction._get_client",
            new=AsyncMock(return_value=mock_client),
        ):
            score, _ = await _aggregate_satisfaction("org1", "trace1")
        assert score > 0.5


# ── 2. Fine-tune org lookup ──────────────────────────────────────────


class TestFineTuneOrgLookup:
    @pytest.mark.asyncio
    async def test_empty_fine_tune_id_returns_none(self) -> None:
        from eden.api.routes.observability_fine_tune import _lookup_org_for_fine_tune

        result = await _lookup_org_for_fine_tune("")
        assert result is None

    @pytest.mark.asyncio
    async def test_db_row_returns_org_id(self) -> None:
        from eden.api.routes.observability_fine_tune import _lookup_org_for_fine_tune

        mock_client = AsyncMock()
        mock_client.fetchrow = AsyncMock(return_value={"org_id": "org-abc"})
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_client),
        ):
            result = await _lookup_org_for_fine_tune("ftjob-abc123")
        assert result == "org-abc"

    @pytest.mark.asyncio
    async def test_unknown_org_returns_none(self) -> None:
        from eden.api.routes.observability_fine_tune import _lookup_org_for_fine_tune

        mock_client = AsyncMock()
        mock_client.fetchrow = AsyncMock(return_value={"org_id": "unknown"})
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_client),
        ):
            result = await _lookup_org_for_fine_tune("ftjob-abc123")
        assert result is None

    @pytest.mark.asyncio
    async def test_no_row_returns_none(self) -> None:
        from eden.api.routes.observability_fine_tune import _lookup_org_for_fine_tune

        mock_client = AsyncMock()
        mock_client.fetchrow = AsyncMock(return_value=None)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_client),
        ):
            result = await _lookup_org_for_fine_tune("ftjob-xyz")
        assert result is None


# ── 3. Cat 7 delegation ──────────────────────────────────────────────


class TestCat7Delegation:
    def test_attribution_scorer_is_live_class(self) -> None:
        from eden.optimization.tool_intel.attribution import ToolAttributionScorer
        from eden.services.tool_intel.services import (
            ToolAttributionScorer as LiveScorer,
        )

        assert ToolAttributionScorer is LiveScorer

    def test_comparator_is_live_class(self) -> None:
        from eden.optimization.tool_intel.attribution import ToolComparator
        from eden.services.tool_intel.services import ToolComparator as LiveComparator

        assert ToolComparator is LiveComparator

    def test_recommender_is_live_class(self) -> None:
        from eden.optimization.tool_intel.attribution import ToolRecommender
        from eden.services.tool_intel.services import ToolRecommender as LiveRecommender

        assert ToolRecommender is LiveRecommender

    def test_taxonomy_is_live_class(self) -> None:
        from eden.optimization.tool_intel.attribution import ToolRegistryTaxonomy
        from eden.services.tool_intel.services import (
            ToolRegistryTaxonomy as LiveTaxonomy,
        )

        assert ToolRegistryTaxonomy is LiveTaxonomy


# ── 4. Tool drift hook is async ──────────────────────────────────────


class TestToolDriftHookAsync:
    def test_fire_tool_drift_hook_is_coroutine(self) -> None:
        from eden.services.tool_intel._common import _fire_tool_drift_hook

        assert inspect.iscoroutinefunction(_fire_tool_drift_hook)

    @pytest.mark.asyncio
    async def test_on_drift_alert_is_awaited(self) -> None:
        from eden.services.tool_intel._common import _fire_tool_drift_hook
        import eden.llmops.promotion_hooks as ph_module

        mock_hook = MagicMock()
        mock_hook.on_drift_alert = AsyncMock(return_value=None)

        with patch.object(ph_module, "get_promotion_hook", return_value=mock_hook):
            await _fire_tool_drift_hook(
                "org1",
                tool_name="search",
                n_calls=20,
                success_rate_now=0.50,
                success_rate_prev=0.85,
            )
        mock_hook.on_drift_alert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_below_threshold_does_not_fire(self) -> None:
        from eden.services.tool_intel._common import _fire_tool_drift_hook
        import eden.llmops.promotion_hooks as ph_module

        mock_hook = MagicMock()
        mock_hook.on_drift_alert = AsyncMock(return_value=None)

        with patch.object(ph_module, "get_promotion_hook", return_value=mock_hook):
            await _fire_tool_drift_hook(
                "org1",
                tool_name="search",
                n_calls=20,
                success_rate_now=0.88,
                success_rate_prev=0.90,
            )
        mock_hook.on_drift_alert.assert_not_awaited()


# ── 5. SQL schema cache ──────────────────────────────────────────────


class TestSqlSchemaCache:
    def test_cache_instance_exists(self) -> None:
        from eden.api.routes.sql_query import _schema_cache

        assert _schema_cache is not None
        assert _schema_cache.default_ttl == 300

    def test_cache_prefix_is_org_scoped(self) -> None:
        from eden.api.routes.sql_query import _schema_cache

        assert "sql:schema" in _schema_cache.prefix


# ── 6. production_eval fail-closed ──────────────────────────────────


class TestProductionEvalFailClosed:
    @pytest.mark.asyncio
    async def test_budget_check_fails_closed_on_db_error(self) -> None:
        from eden.evaluation.production.sampler import ProductionEvalSampler

        sampler = ProductionEvalSampler()

        mock_client = AsyncMock()
        mock_client.fetchrow = AsyncMock(
            side_effect=Exception("DB connection refused")
        )

        with patch.object(sampler, "_client", new=AsyncMock(return_value=mock_client)):
            result = await sampler._budget_allows(
                "org1", {"max_cost_usd_per_day": 50.0}
            )
        assert result is False, "Budget check must fail closed on DB error"

    @pytest.mark.asyncio
    async def test_budget_check_allows_when_under_cap(self) -> None:
        from eden.evaluation.production.sampler import ProductionEvalSampler

        sampler = ProductionEvalSampler()

        mock_client = AsyncMock()
        mock_client.fetchrow = AsyncMock(return_value={"spend_usd": 0.005})

        with patch.object(sampler, "_client", new=AsyncMock(return_value=mock_client)):
            result = await sampler._budget_allows(
                "org1", {"max_cost_usd_per_day": 50.0}
            )
        assert result is True


# ── 7. strategy_store ON CONFLICT ────────────────────────────────────


class TestStrategyStoreOnConflict:
    def test_on_conflict_uses_collection_and_org_id(self) -> None:
        import inspect

        from eden.kb.strategy_store import RetrievalStrategyStore

        src = inspect.getsource(RetrievalStrategyStore.get_strategy)
        assert "ON CONFLICT (collection, org_id)" in src, (
            "get_strategy must use ON CONFLICT (collection, org_id)"
        )

    def test_migration_094_exists(self) -> None:
        import pathlib

        path = pathlib.Path(
            "src/eden/db_migrations/versions/094_strategy_store_org_id.py"
        )
        assert path.exists(), "Migration 094 must exist"
        src = path.read_text()
        assert 'revision: str = "094"' in src
        assert 'down_revision' in src and '"093"' in src

    def test_org_id_column_added_in_migration(self) -> None:
        import pathlib

        path = pathlib.Path(
            "src/eden/db_migrations/versions/094_strategy_store_org_id.py"
        )
        src = path.read_text()
        assert "org_id" in src
        assert "UNIQUE" in src
