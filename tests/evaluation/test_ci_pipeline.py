"""Tests for eden.evaluation.ci_pipeline."""

from __future__ import annotations

import pytest

from eden.evaluation.ci_pipeline import (
    CIPipeline,
    StageName,
    StageStatus,
    StageResult,
    PipelineReport,
)
from eden.evaluation.golden_dataset import load_canonical_datasets


class TestStageResult:
    def test_blocks_merge_on_failed(self):
        passed = StageResult(stage=StageName.UNIT_TESTS, status=StageStatus.PASSED)
        assert not passed.blocks_merge

        failed = StageResult(stage=StageName.UNIT_TESTS, status=StageStatus.FAILED)
        assert failed.blocks_merge

        warned = StageResult(stage=StageName.PERFORMANCE_TESTS, status=StageStatus.WARNED)
        assert not warned.blocks_merge


class TestPipelineReport:
    def test_merge_allowed_when_all_pass(self):
        stages = [
            StageResult(StageName.STATIC_ANALYSIS, StageStatus.PASSED),
            StageResult(StageName.UNIT_TESTS, StageStatus.PASSED),
        ]
        report = PipelineReport(
            run_id="r1", commit_sha="abc", branch="main",
            stages=stages, overall_status=StageStatus.PASSED,
            summary="", duration_ms=100, timestamp="2024-01-01T00:00:00Z",
        )
        assert report.merge_allowed
        assert not report.has_regression

    def test_merge_blocked_on_failure(self):
        stages = [
            StageResult(StageName.UNIT_TESTS, StageStatus.PASSED),
            StageResult(StageName.INTEGRATION_TESTS, StageStatus.FAILED),
        ]
        report = PipelineReport(
            run_id="r1", commit_sha="abc", branch="main",
            stages=stages, overall_status=StageStatus.FAILED,
            summary="", duration_ms=100, timestamp="2024-01-01T00:00:00Z",
        )
        assert not report.merge_allowed

    def test_regression_detection(self):
        stages = [
            StageResult(
                StageName.BENCHMARK_REGRESSION,
                StageStatus.FAILED,
                details={"regression_detected": True},
            ),
        ]
        report = PipelineReport(
            run_id="r1", commit_sha="abc", branch="main",
            stages=stages, overall_status=StageStatus.FAILED,
            summary="", duration_ms=100, timestamp="2024-01-01T00:00:00Z",
        )
        assert report.has_regression

    def test_dict_serialization(self):
        stages = [StageResult(StageName.UNIT_TESTS, StageStatus.PASSED, duration_ms=50.5)]
        report = PipelineReport(
            run_id="r1", commit_sha="abc123", branch="main",
            stages=stages, overall_status=StageStatus.PASSED,
            summary="All good", duration_ms=100, timestamp="2024-01-01T00:00:00Z",
        )
        d = report.to_dict()
        assert d["run_id"] == "r1"
        assert d["merge_allowed"] is True
        assert d["overall_status"] == "passed"
        assert d["stages"][0]["stage"] == "unit_tests"


class TestCIPipeline:
    @pytest.mark.asyncio
    async def test_select_stages_docs_only(self):
        pipeline = CIPipeline(dataset_registry=load_canonical_datasets())
        stages = pipeline._select_stages(["README.md", "docs/guide.md"], set())
        assert stages == [StageName.STATIC_ANALYSIS]

    def test_select_stages_env_related(self):
        pipeline = CIPipeline(dataset_registry=load_canonical_datasets())
        stages = pipeline._select_stages(["src/eden/agents/planner.py"], set())
        assert StageName.BENCHMARK_REGRESSION in stages

    def test_select_stages_non_env(self):
        pipeline = CIPipeline(dataset_registry=load_canonical_datasets())
        stages = pipeline._select_stages(["src/eden/api/routes/auth.py"], set())
        assert StageName.BENCHMARK_REGRESSION not in stages
        assert StageName.UNIT_TESTS in stages

    def test_simulate_case_evaluation(self):
        pipeline = CIPipeline(dataset_registry=load_canonical_datasets())
        from eden.evaluation.golden_dataset import GoldenCase, EnvironmentCategory, DifficultyLevel
        case = GoldenCase(
            case_id="test",
            category=EnvironmentCategory.AGENT_SANDBOX,
            difficulty=DifficultyLevel.BEGINNER,
            description="",
            input_spec={},
            expected_behavior={},
        )
        # Deterministic based on case_id
        result = pipeline._simulate_case_evaluation(case)
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_run_full_pipeline(self):
        pipeline = CIPipeline(dataset_registry=load_canonical_datasets())
        report = await pipeline.run(
            commit_sha="abcdef1234567890",
            branch="feature/test",
            changed_files=["src/eden/agents/test.py"],
            baseline_commit=None,
        )
        assert report.run_id.startswith("ci-")
        assert report.commit_sha == "abcdef1234567890"
        assert report.branch == "feature/test"
        assert report.duration_ms > 0
        # Should have stages
        assert len(report.stages) > 0

    def test_save_and_load_report(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmpdir:
            pipeline = CIPipeline(
                dataset_registry=load_canonical_datasets(),
                work_dir=Path(tmpdir),
            )
            stages = [StageResult(StageName.UNIT_TESTS, StageStatus.PASSED)]
            report = PipelineReport(
                run_id="test-run-1",
                commit_sha="abc",
                branch="main",
                stages=stages,
                overall_status=StageStatus.PASSED,
                summary="Test",
                duration_ms=100,
                timestamp="2024-01-01T00:00:00Z",
            )
            pipeline._save_report(report)

            loaded = pipeline.load_report("test-run-1")
            assert loaded is not None
            assert loaded.run_id == "test-run-1"
            assert loaded.overall_status == StageStatus.PASSED
