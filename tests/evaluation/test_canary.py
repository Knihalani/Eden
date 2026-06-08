"""Tests for eden.evaluation.canary."""

from __future__ import annotations

import pytest

from eden.evaluation.canary import (
    CanaryDeployment,
    CanaryResult,
    DeploymentConfig,
    DeploymentStrategy,
    MetricThreshold,
    RollbackController,
    RolloutStage,
)


class TestCanaryResult:
    def test_to_dict(self):
        result = CanaryResult(
            status="passed",
            failed_checks=[],
            action="promote",
            confidence=0.95,
            metrics={"key": "value"},
            duration_ms=1234.5,
        )
        d = result.to_dict()
        assert d["status"] == "passed"
        assert d["action"] == "promote"
        assert d["confidence"] == 0.95
        assert d["duration_ms"] == 1234.5


class TestDeploymentConfig:
    def test_default_stages(self):
        config = DeploymentConfig()
        assert config.strategy == DeploymentStrategy.CANARY
        assert len(config.stages) == 4
        assert config.stages[0].percentage == 1
        assert config.stages[-1].percentage == 100

    def test_from_dict(self):
        data = {
            "strategy": "shadow",
            "stages": [
                {"percentage": 10, "duration_minutes": 5, "metrics": ["error_rate"]},
            ],
            "rollback": False,
            "rollback_conditions": [
                {"metric": "error_rate", "max_regression_pct": 10.0, "window_minutes": 5},
            ],
        }
        config = DeploymentConfig.from_dict(data)
        assert config.strategy == DeploymentStrategy.SHADOW
        assert not config.rollback
        assert len(config.stages) == 1
        assert config.rollback_conditions[0].metric == "error_rate"


class TestCanaryDeployment:
    @pytest.mark.asyncio
    async def test_shadow_mode(self):
        deployment = CanaryDeployment()
        config = DeploymentConfig(strategy=DeploymentStrategy.SHADOW)
        result = await deployment.deploy(
            environment_id="env_test",
            current_version="v1.0.0",
            candidate_version="v1.1.0",
            config=config,
        )
        assert result.status in ("passed", "failed")
        assert result.action in ("promote", "rollback")
        assert result.duration_ms > 0

    @pytest.mark.asyncio
    async def test_canary_progressive(self):
        deployment = CanaryDeployment()
        # Use minimal stages for fast test
        config = DeploymentConfig(
            strategy=DeploymentStrategy.CANARY,
            stages=[
                RolloutStage(percentage=1, duration_minutes=0, metrics=["error_rate"]),
                RolloutStage(percentage=100, duration_minutes=0, metrics=["all"]),
            ],
        )
        result = await deployment.deploy(
            environment_id="env_test",
            current_version="v1.0.0",
            candidate_version="v1.1.0",
            config=config,
        )
        assert result.status in ("passed", "failed")
        assert result.duration_ms > 0

    @pytest.mark.asyncio
    async def test_blue_green(self):
        deployment = CanaryDeployment()
        config = DeploymentConfig(strategy=DeploymentStrategy.BLUE_GREEN)
        result = await deployment.deploy(
            environment_id="env_test",
            current_version="v1.0.0",
            candidate_version="v1.1.0",
            config=config,
        )
        assert result.status in ("passed", "failed")
        assert result.action in ("promote", "rollback")

    @pytest.mark.asyncio
    async def test_ab_test(self):
        deployment = CanaryDeployment()
        config = DeploymentConfig(strategy=DeploymentStrategy.AB_TEST)
        result = await deployment.deploy(
            environment_id="env_test",
            current_version="v1.0.0",
            candidate_version="v1.1.0",
            config=config,
        )
        assert result.status in ("passed", "failed")
        assert result.duration_ms > 0

    def test_collect_metrics(self):
        deployment = CanaryDeployment()
        metrics = deployment._collect_metrics("env_test", "v1.0.0")
        assert "error_rate" in metrics
        assert "latency_p99" in metrics
        assert 0 <= metrics["error_rate"] <= 1

    def test_analyze_metrics_pass(self):
        deployment = CanaryDeployment()
        baseline = {"error_rate": 0.01, "latency_p99": 200}
        candidate = {"error_rate": 0.01, "latency_p99": 210}  # 5% regression
        thresholds = [MetricThreshold("error_rate", max_regression_pct=5.0)]
        result = deployment._analyze_metrics(baseline, candidate, thresholds)
        assert result.status == "passed"
        assert result.action == "promote"

    def test_analyze_metrics_fail(self):
        deployment = CanaryDeployment()
        baseline = {"error_rate": 0.01}
        candidate = {"error_rate": 0.02}  # 100% regression
        thresholds = [MetricThreshold("error_rate", max_regression_pct=5.0)]
        result = deployment._analyze_metrics(baseline, candidate, thresholds)
        assert result.status == "failed"
        assert result.action == "rollback"
        assert "error_rate" in result.failed_checks

    def test_health_check(self):
        deployment = CanaryDeployment()
        result = deployment._health_check("env_test", "v1.0.0")
        assert isinstance(result, bool)

    def test_persist_and_get_state(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmpdir:
            deployment = CanaryDeployment(state_dir=Path(tmpdir))
            deployment._persist_state("test-dep", {"key": "value"})
            state = deployment.get_deployment_state("test-dep")
            assert state is not None
            assert state["key"] == "value"


class TestRollbackController:
    @pytest.mark.asyncio
    async def test_emergency_rollback(self):
        controller = RollbackController()
        result = await controller.emergency_rollback("env_test", "test reason")
        assert result["environment_id"] == "env_test"
        assert result["reason"] == "test reason"
        assert result["verified"] is True

    @pytest.mark.asyncio
    async def test_dry_run(self):
        controller = RollbackController()
        result = await controller.dry_run("env_test", "v1.0.0", "v1.1.0")
        assert result["rollback_possible"] is True
        assert "checks" in result

    def test_automatic_triggers(self):
        controller = RollbackController()
        # Error rate spike
        triggered = controller.check_automatic_triggers({"error_rate": 0.10})
        assert len(triggered) > 0
        assert triggered[0]["trigger"] == "error_rate_spike"

        # No triggers
        triggered = controller.check_automatic_triggers({"error_rate": 0.01})
        assert len(triggered) == 0
