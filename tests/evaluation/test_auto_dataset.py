"""Tests for eden.evaluation.auto_dataset."""

from __future__ import annotations

import pytest

from eden.evaluation.auto_dataset import (
    AutoDatasetPromoter,
    TraceQualityScore,
    TraceQualityScorer,
)
from eden.evaluation.golden_dataset import (
    DatasetRegistry,
    DifficultyLevel,
    EnvironmentCategory,
    GoldenCase,
)


class TestTraceQualityScore:
    def test_to_dict(self):
        score = TraceQualityScore(
            trace_id="t1",
            overall_score=0.85,
            correctness_score=0.90,
            robustness_score=0.80,
            efficiency_score=0.85,
            diversity_score=0.75,
        )
        d = score.to_dict()
        assert d["trace_id"] == "t1"
        assert d["overall_score"] == 0.85
        assert d["diversity_score"] == 0.75


class TestTraceQualityScorer:
    def test_score_high_quality_trace(self):
        scorer = TraceQualityScorer()
        trace = {
            "trace_id": "t1",
            "description": "Test environment for agent reasoning",
            "metrics": {"tokens_used": 500, "max_tokens": 10000},
            "test_results": {"passed": 10, "total": 10, "edge_cases": {"a": True, "b": True}},
            "tags": ["reasoning", "multi-step"],
        }
        score = scorer.score(trace, existing_cases=[])
        assert score.overall_score > 0.8
        assert score.correctness_score == 1.0
        assert score.robustness_score == 1.0

    def test_score_low_quality_trace(self):
        scorer = TraceQualityScorer()
        trace = {
            "trace_id": "t2",
            "description": "Failing environment",
            "metrics": {"tokens_used": 9000, "max_tokens": 10000},
            "test_results": {"passed": 1, "total": 10, "edge_cases": {"a": False, "b": False}},
            "tags": ["failing"],
        }
        score = scorer.score(trace, existing_cases=[])
        assert score.correctness_score == 0.1
        assert score.overall_score < 0.6

    def test_diversity_with_existing_cases(self):
        scorer = TraceQualityScorer()
        existing = [
            GoldenCase("c1", EnvironmentCategory.AGENT_SANDBOX, DifficultyLevel.BEGINNER, "Agent sandbox", {}, {}, tags=["sandbox"]),
        ]
        trace = {
            "trace_id": "t3",
            "description": "LLM evaluation benchmark",
            "metrics": {},
            "test_results": {},
            "tags": ["llm", "evaluation"],
        }
        score = scorer.score(trace, existing_cases=existing)
        assert score.diversity_score > 0.5  # Very different from existing

    def test_diversity_identical_case(self):
        scorer = TraceQualityScorer()
        existing = [
            GoldenCase("c1", EnvironmentCategory.AGENT_SANDBOX, DifficultyLevel.BEGINNER, "Agent sandbox test", {}, {}, tags=["sandbox"]),
        ]
        trace = {
            "trace_id": "t4",
            "description": "Agent sandbox test",
            "metrics": {},
            "test_results": {},
            "tags": ["sandbox"],
        }
        score = scorer.score(trace, existing_cases=existing)
        assert score.diversity_score < 0.5  # Very similar to existing

    def test_should_promote(self):
        scorer = TraceQualityScorer()
        high_score = TraceQualityScore("t1", overall_score=0.90)
        low_score = TraceQualityScore("t2", overall_score=0.50)
        assert scorer.should_promote(high_score) is True
        assert scorer.should_promote(low_score) is False


class TestAutoDatasetPromoter:
    @pytest.mark.asyncio
    async def test_process_traces(self):
        promoter = AutoDatasetPromoter()
        traces = [
            {
                "trace_id": "t1",
                "description": "High quality agent sandbox",
                "environment_type": "agent_sandbox",
                "metrics": {"tokens_used": 500, "max_tokens": 10000},
                "test_results": {"passed": 10, "total": 10, "edge_cases": {"a": True}},
                "tags": ["sandbox", "tool-use"],
                "complexity_metrics": {"max_steps": 8},
                "input_spec": {"observation_space": "text"},
            },
            {
                "trace_id": "t2",
                "description": "Low quality failing trace",
                "environment_type": "agent_sandbox",
                "metrics": {"tokens_used": 9500, "max_tokens": 10000},
                "test_results": {"passed": 2, "total": 10, "edge_cases": {"a": False}},
                "tags": ["failing"],
                "complexity_metrics": {"max_steps": 3},
            },
        ]
        result = await promoter.process_traces(traces, target_dataset_id="gd_auto_test")
        assert result["processed"] == 2
        assert result["promoted"] >= 0
        assert result["rejected"] >= 0
        assert result["promoted"] + result["rejected"] == 2

    @pytest.mark.asyncio
    async def test_review_and_freeze(self):
        promoter = AutoDatasetPromoter()
        traces = [
            {
                "trace_id": "t1",
                "description": "High quality",
                "environment_type": "agent_sandbox",
                "metrics": {"tokens_used": 500, "max_tokens": 10000},
                "test_results": {"passed": 10, "total": 10},
                "tags": ["sandbox"],
                "complexity_metrics": {"max_steps": 5},
            },
        ]
        await promoter.process_traces(traces, target_dataset_id="gd_freeze_test")

        # Approve and freeze
        frozen = await promoter.review_and_freeze("gd_freeze_test", approved=True)
        assert frozen is not None
        assert frozen.dataset_id == "gd_freeze_test"

    @pytest.mark.asyncio
    async def test_review_reject(self):
        promoter = AutoDatasetPromoter()
        traces = [
            {
                "trace_id": "t1",
                "description": "Test",
                "environment_type": "agent_sandbox",
                "metrics": {},
                "test_results": {},
                "tags": [],
                "complexity_metrics": {"max_steps": 5},
            },
        ]
        await promoter.process_traces(traces, target_dataset_id="gd_reject_test")

        # Reject
        frozen = await promoter.review_and_freeze("gd_reject_test", approved=False)
        assert frozen is None

    def test_bump_version(self):
        promoter = AutoDatasetPromoter()
        assert promoter._bump_version("1.0.0") == "1.0.1"
        assert promoter._bump_version("2.3.4") == "2.3.5"
        assert promoter._bump_version("1.0") == "1.0.1"

    def test_trace_to_golden_case(self):
        promoter = AutoDatasetPromoter()
        trace = {
            "trace_id": "abc123",
            "description": "Test environment",
            "environment_type": "tool_use",
            "tags": ["auto-promoted", "tool_use"],
            "input_spec": {"tools": ["calc"]},
            "test_results": {"passed": 5, "total": 5},
            "complexity_metrics": {"max_steps": 12},
        }
        score = TraceQualityScore("abc123", overall_score=0.90)
        case = promoter._trace_to_golden_case(trace, score)
        assert case is not None
        assert case.case_id.startswith("auto_")
        assert case.category == EnvironmentCategory.TOOL_USE
        assert case.difficulty == DifficultyLevel.INTERMEDIATE  # 12 steps
        assert "auto-promoted" in case.tags

    def test_trace_to_golden_case_custom_category(self):
        promoter = AutoDatasetPromoter()
        trace = {
            "trace_id": "xyz789",
            "description": "Custom environment",
            "environment_type": "unknown_type",
            "tags": [],
            "input_spec": {},
            "test_results": {},
            "complexity_metrics": {"max_steps": 50},
        }
        score = TraceQualityScore("xyz789", overall_score=0.85)
        case = promoter._trace_to_golden_case(trace, score, default_category=EnvironmentCategory.SIMULATION)
        assert case.category == EnvironmentCategory.SIMULATION
        assert case.difficulty == DifficultyLevel.EXPERT  # 50 steps
