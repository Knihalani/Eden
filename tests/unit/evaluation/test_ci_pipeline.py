"""Unit tests for the CI pipeline benchmark-regression stage.

Data-integrity audit 2026-08: no real case-execution backend
exists, so by default the benchmark_regression stage must report
``execution_unavailable`` (SKIPPED) rather than fabricating
pass/fail results. The heuristic simulation is opt-in via
``allow_simulated_benchmarks=True`` and every simulated result is
labeled ``simulated: True``.
"""
from __future__ import annotations

from enum import Enum
from unittest.mock import MagicMock

import pytest

from eden.evaluation.ci_pipeline import (
    CIPipeline,
    StageName,
    StageStatus,
)


class _Difficulty(Enum):
    BEGINNER = "beginner"


class _Category(Enum):
    GENERAL = "general"


class _FakeCase:
    def __init__(self, case_id: str) -> None:
        self.case_id = case_id
        self.category = _Category.GENERAL
        self.difficulty = _Difficulty.BEGINNER


class _FakeDataset:
    dataset_id = "gd_eden_canonical_v1"
    version = "v1"
    overall_pass_criteria: dict[str, float] = {}

    def __init__(self) -> None:
        self.cases = [_FakeCase(f"case_{i}") for i in range(4)]

    def get_cases_by_category(self, category: object) -> list[_FakeCase]:
        return self.cases


def _pipeline(tmp_path, *, allow_simulated: bool = False, dataset=None) -> CIPipeline:
    registry = MagicMock()
    registry.get.return_value = dataset
    return CIPipeline(
        dataset_registry=registry,
        work_dir=tmp_path / "ci",
        allow_simulated_benchmarks=allow_simulated,
    )


class TestBenchmarkRegressionHonesty:
    @pytest.mark.asyncio
    async def test_default_reports_execution_unavailable(self, tmp_path) -> None:
        """Without opt-in, the stage must skip — never simulate."""
        pipeline = _pipeline(tmp_path)
        result = await pipeline._run_benchmark_regression(None)
        assert result.stage == StageName.BENCHMARK_REGRESSION
        assert result.status == StageStatus.SKIPPED
        assert result.details["reason"] == "execution_unavailable"
        assert not result.blocks_merge
        # The dataset registry must not even be consulted.
        assert not pipeline._dataset_registry.get.called

    @pytest.mark.asyncio
    async def test_opt_in_without_dataset_skips(self, tmp_path) -> None:
        pipeline = _pipeline(tmp_path, allow_simulated=True)
        result = await pipeline._run_benchmark_regression(None)
        assert result.status == StageStatus.SKIPPED
        assert result.details["reason"] == "golden_dataset_not_found"

    @pytest.mark.asyncio
    async def test_opt_in_simulation_is_labeled(self, tmp_path) -> None:
        """Opt-in simulation must label its results simulated: True."""
        pipeline = _pipeline(
            tmp_path, allow_simulated=True, dataset=_FakeDataset()
        )
        result = await pipeline._run_benchmark_regression(None)
        assert result.status in (StageStatus.PASSED, StageStatus.FAILED)
        assert result.details["simulated"] is True
