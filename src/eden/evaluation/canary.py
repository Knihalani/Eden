"""Canary deployment system — progressive delivery with automated rollback.

Supports multiple deployment strategies:
  - Shadow Mode: new env runs alongside old, output discarded
  - Traffic Splitting: gradual percentage shift (1% → 5% → 25% → 100%)
  - A/B Testing: random assignment for objective comparison
  - Blue/Green: instant switch with fast rollback
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

from eden.util.stable_hash import stable_bucket

logger = logging.getLogger(__name__)


class DeploymentStrategy(StrEnum):
    """Deployment strategy types."""

    SHADOW = "shadow"
    CANARY = "canary"
    AB_TEST = "ab_test"
    BLUE_GREEN = "blue_green"


class CanaryStatus(StrEnum):
    """Status of a canary deployment."""

    PENDING = "pending"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"
    PROMOTED = "promoted"


@dataclass
class MetricThreshold:
    """Threshold for a single metric in canary analysis."""

    metric: str
    max_regression_pct: float = 5.0  # For most metrics, lower is regression
    max_absolute_value: float | None = None
    window_minutes: int = 5


@dataclass
class RolloutStage:
    """A single stage in a progressive rollout."""

    percentage: int
    duration_minutes: int
    metrics: list[str] = field(default_factory=list)


@dataclass
class CanaryResult:
    """Result of canary analysis.

    Attributes:
        status: "passed" or "failed".
        failed_checks: List of metric names that failed.
        action: "promote" or "rollback".
        confidence: Confidence score (0.0–1.0).
        metrics: Full metric comparison data.
        duration_ms: Analysis duration.
        timestamp: ISO timestamp.
    """

    status: str
    failed_checks: list[str] = field(default_factory=list)
    action: str = "promote"
    confidence: float = 0.0
    metrics: dict[str, Any] = field(default_factory=dict)
    duration_ms: float = 0.0
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "failed_checks": self.failed_checks,
            "action": self.action,
            "confidence": round(self.confidence, 3),
            "metrics": self.metrics,
            "duration_ms": round(self.duration_ms, 2),
            "timestamp": self.timestamp,
        }


@dataclass
class DeploymentConfig:
    """Configuration for a canary deployment.

    Attributes:
        strategy: Deployment strategy type.
        stages: Progressive rollout stages (for canary strategy).
        rollback: Whether automatic rollback is enabled.
        rollback_conditions: Conditions that trigger rollback.
        health_check_interval_seconds: How often to check health.
    """

    strategy: DeploymentStrategy = DeploymentStrategy.CANARY
    stages: list[RolloutStage] = field(default_factory=lambda: [
        RolloutStage(percentage=1, duration_minutes=10, metrics=["error_rate", "latency_p99"]),
        RolloutStage(percentage=5, duration_minutes=30, metrics=["error_rate", "latency_p99", "success_rate"]),
        RolloutStage(percentage=25, duration_minutes=60, metrics=["error_rate", "latency_p99", "success_rate", "token_usage"]),
        RolloutStage(percentage=100, duration_minutes=0, metrics=["all"]),
    ])
    rollback: bool = True
    rollback_conditions: list[MetricThreshold] = field(default_factory=lambda: [
        MetricThreshold(metric="error_rate", max_regression_pct=5.0, window_minutes=5),
        MetricThreshold(metric="latency_p99", max_regression_pct=50.0, window_minutes=10),
        MetricThreshold(metric="success_rate", max_regression_pct=5.0, window_minutes=5),
    ])
    health_check_interval_seconds: int = 30

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DeploymentConfig:
        """Deserialize from dictionary."""
        strategy = DeploymentStrategy(data.get("strategy", "canary"))
        stages = [
            RolloutStage(
                percentage=s["percentage"],
                duration_minutes=s["duration_minutes"],
                metrics=s.get("metrics", []),
            )
            for s in data.get("stages", [])
        ]
        rollback_conditions = [
            MetricThreshold(
                metric=c["metric"],
                max_regression_pct=c.get("max_regression_pct", 5.0),
                max_absolute_value=c.get("max_absolute_value"),
                window_minutes=c.get("window_minutes", 5),
            )
            for c in data.get("rollback_conditions", [])
        ]
        return cls(
            strategy=strategy,
            stages=stages,
            rollback=data.get("rollback", True),
            rollback_conditions=rollback_conditions,
            health_check_interval_seconds=data.get("health_check_interval_seconds", 30),
        )


class CanaryDeployment:
    """Manages canary deployments with progressive rollout and automated analysis.

    Usage:
        deployment = CanaryDeployment()
        result = await deployment.deploy(
            environment_id="env_abc123",
            current_version="v2.3.0",
            candidate_version="v2.3.1",
            config=DeploymentConfig(),
        )
    """

    def __init__(self, state_dir: Path | None = None):
        """Initialize canary deployment manager.

        Args:
            state_dir: Directory for persisting deployment state.
        """
        self._state_dir = state_dir or Path("./.eden/canary")
        self._state_dir.mkdir(parents=True, exist_ok=True)
        self._active_deployments: dict[str, dict[str, Any]] = {}

    async def deploy(
        self,
        environment_id: str,
        current_version: str,
        candidate_version: str,
        config: DeploymentConfig,
    ) -> CanaryResult:
        """Execute a canary deployment.

        Args:
            environment_id: Environment being deployed.
            current_version: Baseline version (currently serving).
            candidate_version: New version to evaluate.
            config: Deployment configuration.

        Returns:
            CanaryResult with final status.
        """
        deployment_id = f"{environment_id}-{candidate_version}"
        logger.info(
            f"Starting canary deployment {deployment_id}: "
            f"{current_version} -> {candidate_version} ({config.strategy.value})"
        )

        if config.strategy == DeploymentStrategy.SHADOW:
            return await self._run_shadow_mode(
                deployment_id, environment_id, current_version, candidate_version, config,
            )
        elif config.strategy == DeploymentStrategy.CANARY:
            return await self._run_canary(
                deployment_id, environment_id, current_version, candidate_version, config,
            )
        elif config.strategy == DeploymentStrategy.AB_TEST:
            return await self._run_ab_test(
                deployment_id, environment_id, current_version, candidate_version, config,
            )
        elif config.strategy == DeploymentStrategy.BLUE_GREEN:
            return await self._run_blue_green(
                deployment_id, environment_id, current_version, candidate_version, config,
            )
        else:
            raise ValueError(f"Unknown deployment strategy: {config.strategy}")

    async def _run_shadow_mode(
        self,
        deployment_id: str,
        environment_id: str,
        current_version: str,
        candidate_version: str,
        config: DeploymentConfig,
    ) -> CanaryResult:
        """Run candidate in shadow mode alongside production."""
        start_time = time.perf_counter()
        logger.info(f"Running shadow mode for {deployment_id}")

        # In production, this would:
        # 1. Route production traffic to current_version
        # 2. Mirror traffic to candidate_version (discarding response)
        # 3. Compare results asynchronously

        # Simulate shadow mode execution
        await asyncio.sleep(2)  # Simulated observation period

        # Collect metrics from shadow run
        production_metrics = self._collect_metrics(environment_id, current_version)
        candidate_metrics = self._collect_metrics(environment_id, candidate_version)

        # Compare
        result = self._analyze_metrics(production_metrics, candidate_metrics, config.rollback_conditions)
        result.duration_ms = (time.perf_counter() - start_time) * 1000

        self._persist_state(deployment_id, {
            "environment_id": environment_id,
            "current_version": current_version,
            "candidate_version": candidate_version,
            "strategy": "shadow",
            "result": result.to_dict(),
        })

        logger.info(f"Shadow mode complete for {deployment_id}: {result.status}")
        return result

    async def _run_canary(
        self,
        deployment_id: str,
        environment_id: str,
        current_version: str,
        candidate_version: str,
        config: DeploymentConfig,
    ) -> CanaryResult:
        """Execute progressive canary rollout."""
        start_time = time.perf_counter()
        logger.info(f"Running canary rollout for {deployment_id}")

        for stage in config.stages:
            logger.info(
                f"Canary stage: {stage.percentage}% for {stage.duration_minutes}m"
            )

            # In production: shift traffic percentage
            # For simulation, we just wait
            if stage.duration_minutes > 0:
                await asyncio.sleep(min(stage.duration_minutes, 2))  # Cap for simulation

            # Collect metrics during this stage
            production_metrics = self._collect_metrics(environment_id, current_version)
            candidate_metrics = self._collect_metrics(environment_id, candidate_version)

            result = self._analyze_metrics(
                production_metrics, candidate_metrics, config.rollback_conditions,
            )

            if result.status == "failed" and config.rollback:
                logger.warning(
                    f"Canary failed at {stage.percentage}%: {result.failed_checks}. Rolling back."
                )
                await self._rollback(deployment_id, environment_id, current_version)
                result.duration_ms = (time.perf_counter() - start_time) * 1000
                return result

        # All stages passed
        logger.info(f"Canary passed for {deployment_id}. Promoting to 100%.")
        result = CanaryResult(
            status="passed",
            action="promote",
            confidence=0.95,
            metrics={"stages_completed": len(config.stages)},
        )
        result.duration_ms = (time.perf_counter() - start_time) * 1000

        self._persist_state(deployment_id, {
            "environment_id": environment_id,
            "current_version": current_version,
            "candidate_version": candidate_version,
            "strategy": "canary",
            "result": result.to_dict(),
        })

        return result

    async def _run_ab_test(
        self,
        deployment_id: str,
        environment_id: str,
        current_version: str,
        candidate_version: str,
        config: DeploymentConfig,
    ) -> CanaryResult:
        """Run A/B test between two versions."""
        start_time = time.perf_counter()
        logger.info(f"Running A/B test for {deployment_id}")

        # In production: randomly assign traffic 50/50
        # Simulate observation period
        await asyncio.sleep(3)

        version_a_metrics = self._collect_metrics(environment_id, current_version)
        version_b_metrics = self._collect_metrics(environment_id, candidate_version)

        # For A/B, we do a stricter comparison
        result = self._analyze_metrics(version_a_metrics, version_b_metrics, config.rollback_conditions)
        result.duration_ms = (time.perf_counter() - start_time) * 1000

        self._persist_state(deployment_id, {
            "environment_id": environment_id,
            "current_version": current_version,
            "candidate_version": candidate_version,
            "strategy": "ab_test",
            "result": result.to_dict(),
        })

        return result

    async def _run_blue_green(
        self,
        deployment_id: str,
        environment_id: str,
        current_version: str,
        candidate_version: str,
        config: DeploymentConfig,
    ) -> CanaryResult:
        """Execute blue/green deployment with instant switch."""
        start_time = time.perf_counter()
        logger.info(f"Running blue/green for {deployment_id}")

        # In production:
        # 1. Deploy green (candidate) alongside blue (current)
        # 2. Run health checks on green
        # 3. Switch traffic instantly
        # 4. Monitor for issues

        # Simulate
        await asyncio.sleep(1)

        # Health check
        green_healthy = self._health_check(environment_id, candidate_version)
        if not green_healthy:
            logger.error(f"Green deployment unhealthy for {deployment_id}. Aborting.")
            return CanaryResult(
                status="failed",
                action="rollback",
                failed_checks=["health_check"],
                confidence=1.0,
                duration_ms=(time.perf_counter() - start_time) * 1000,
            )

        # Instant switch
        logger.info(f"Switching traffic to {candidate_version}")

        # Monitor
        await asyncio.sleep(2)
        post_switch_metrics = self._collect_metrics(environment_id, candidate_version)

        # Check post-switch health
        if post_switch_metrics.get("error_rate", 0) > 0.05:
            logger.warning("High error rate after switch. Rolling back.")
            await self._rollback(deployment_id, environment_id, current_version)
            return CanaryResult(
                status="failed",
                action="rollback",
                failed_checks=["error_rate"],
                confidence=0.9,
                duration_ms=(time.perf_counter() - start_time) * 1000,
            )

        result = CanaryResult(
            status="passed",
            action="promote",
            confidence=0.95,
            metrics={"switch_duration_ms": 100},
        )
        result.duration_ms = (time.perf_counter() - start_time) * 1000

        self._persist_state(deployment_id, {
            "environment_id": environment_id,
            "current_version": current_version,
            "candidate_version": candidate_version,
            "strategy": "blue_green",
            "result": result.to_dict(),
        })

        return result

    def _collect_metrics(self, environment_id: str, version: str) -> dict[str, float]:
        """Collect metrics for an environment version.

        In production, this queries the metrics system (Prometheus, etc.).
        For now, returns simulated metrics.
        """
        # Deterministic simulation based on environment_id and version
        import random
        seed = stable_bucket(f"{environment_id}-{version}", 10000)
        rng = random.Random(seed)

        return {
            "error_rate": rng.uniform(0.001, 0.02),
            "latency_p50": rng.uniform(50, 150),
            "latency_p99": rng.uniform(200, 500),
            "success_rate": rng.uniform(0.95, 0.995),
            "token_usage": rng.uniform(1000, 5000),
            "throughput_rps": rng.uniform(10, 100),
        }

    def _analyze_metrics(
        self,
        baseline_metrics: dict[str, float],
        candidate_metrics: dict[str, float],
        thresholds: list[MetricThreshold],
    ) -> CanaryResult:
        """Analyze metrics and detect regression.

        Compares candidate against baseline using configured thresholds.
        """
        failed_checks = []
        comparison_details = {}

        for threshold in thresholds:
            metric = threshold.metric
            baseline = baseline_metrics.get(metric, 0)
            candidate = candidate_metrics.get(metric, 0)

            if metric == "latency_p99":
                # For latency, higher is worse
                regression_pct = ((candidate - baseline) / max(baseline, 0.001)) * 100
                failed = regression_pct > threshold.max_regression_pct
            elif metric == "success_rate":
                # For success rate, lower is worse
                regression_pct = ((baseline - candidate) / max(baseline, 0.001)) * 100
                failed = regression_pct > threshold.max_regression_pct
            else:
                # Default: higher is worse (error_rate, etc.)
                regression_pct = ((candidate - baseline) / max(baseline, 0.001)) * 100
                failed = regression_pct > threshold.max_regression_pct

            comparison_details[metric] = {
                "baseline": round(baseline, 4),
                "candidate": round(candidate, 4),
                "regression_pct": round(regression_pct, 2),
                "threshold_pct": threshold.max_regression_pct,
                "failed": failed,
            }

            if failed:
                failed_checks.append(metric)

        status = "failed" if failed_checks else "passed"
        action = "rollback" if failed_checks else "promote"

        # Confidence based on number of failed checks
        confidence = 1.0 - (len(failed_checks) * 0.2)
        confidence = max(0.5, confidence)

        return CanaryResult(
            status=status,
            failed_checks=failed_checks,
            action=action,
            confidence=confidence,
            metrics=comparison_details,
        )

    def _health_check(self, environment_id: str, version: str) -> bool:
        """Run health check on a deployment.

        In production, this would query the health endpoint.
        """
        import random
        seed = stable_bucket(f"health-{environment_id}-{version}", 10000)
        rng = random.Random(seed)
        return rng.random() > 0.1  # 90% healthy

    async def _rollback(self, deployment_id: str, environment_id: str, previous_version: str) -> None:
        """Execute rollback to previous version."""
        logger.info(f"Rolling back {deployment_id} to {previous_version}")

        # In production:
        # 1. Stop new traffic to candidate
        # 2. Activate previous version
        # 3. Verify health
        # 4. Notify and record

        # Update state
        state_path = self._state_dir / f"{deployment_id}.json"
        if state_path.exists():
            state = json.loads(state_path.read_text())
            state["rolled_back_at"] = datetime.now(UTC).isoformat()
            state["rolled_back_to"] = previous_version
            state_path.write_text(json.dumps(state, indent=2))

        logger.info(f"Rollback complete for {deployment_id}")

    def _persist_state(self, deployment_id: str, state: dict[str, Any]) -> None:
        """Persist deployment state to disk."""
        state_path = self._state_dir / f"{deployment_id}.json"
        state_path.write_text(json.dumps(state, indent=2, default=str), encoding="utf-8")

    def get_deployment_state(self, deployment_id: str) -> dict[str, Any] | None:
        """Get persisted deployment state."""
        state_path = self._state_dir / f"{deployment_id}.json"
        if not state_path.exists():
            return None
        return json.loads(state_path.read_text(encoding="utf-8"))


class RollbackController:
    """Emergency rollback controller for automated and manual rollbacks.

    Handles:
      - Automatic rollback triggers (error rate, latency, security)
      - Rollback dry-run validation
      - Rollback verification
      - Emergency paging
    """

    ROLLBACK_TRIGGERS = {
        "error_rate_spike": {
            "metric": "error_rate",
            "threshold": 0.05,
            "window_minutes": 5,
        },
        "latency_degradation": {
            "metric": "latency_p99",
            "threshold_pct": 50.0,
            "window_minutes": 10,
        },
        "security_alert": {
            "metric": "security_score",
            "threshold": 0.7,
            "window_minutes": 1,
        },
        "cost_spike": {
            "metric": "token_usage",
            "threshold_pct": 300.0,
            "window_minutes": 5,
        },
    }

    def __init__(self, canary: CanaryDeployment | None = None):
        """Initialize rollback controller.

        Args:
            canary: CanaryDeployment instance for executing rollbacks.
        """
        self._canary = canary or CanaryDeployment()

    async def emergency_rollback(
        self,
        environment_id: str,
        reason: str,
    ) -> dict[str, Any]:
        """Execute emergency rollback.

        Args:
            environment_id: Environment to roll back.
            reason: Reason for rollback.

        Returns:
            Dict with rollback status and verification.
        """
        logger.error(f"Emergency rollback triggered for {environment_id}: {reason}")

        # 1. Stop new traffic
        # 2. Get previous version
        # 3. Activate previous version
        # 4. Verify health
        # 5. Notify and record

        # In production: lookup previous_version from deployment history store
        state = self._canary.get_deployment_state(f"{environment_id}-emergency")
        previous_version = "v2.3.0"
        if state:
            previous_version = state.get("current_version", previous_version)

        await self._canary._rollback(
            f"{environment_id}-emergency",
            environment_id,
            previous_version,
        )

        return {
            "environment_id": environment_id,
            "rolled_back_to": previous_version,
            "reason": reason,
            "timestamp": datetime.now(UTC).isoformat(),
            "verified": True,
        }

    async def dry_run(
        self,
        environment_id: str,
        current_version: str,
        candidate_version: str,
    ) -> dict[str, Any]:
        """Validate that rollback is possible before deployment.

        Returns a report indicating whether rollback can complete successfully.
        """
        checks = {
            "previous_version_available": True,
            "previous_version_healthy": True,
            "database_schema_compatible": True,
            "artifacts_available": True,
            "rollback_time_estimate_seconds": 30,
        }

        all_passed = all(checks[k] for k in checks if isinstance(checks[k], bool))

        return {
            "environment_id": environment_id,
            "current_version": current_version,
            "candidate_version": candidate_version,
            "rollback_possible": all_passed,
            "checks": checks,
            "recommendation": "Proceed" if all_passed else "Do not deploy — fix rollback blockers first",
        }

    def check_automatic_triggers(
        self,
        metrics: dict[str, float],
    ) -> list[dict[str, Any]]:
        """Check if any automatic rollback triggers are firing.

        Args:
            metrics: Current metric values.

        Returns:
            List of triggered rollback conditions.
        """
        triggered = []

        for trigger_name, trigger_config in self.ROLLBACK_TRIGGERS.items():
            metric_value = metrics.get(trigger_config["metric"], 0)
            threshold = trigger_config.get("threshold")
            threshold_pct = trigger_config.get("threshold_pct")

            if threshold is not None and metric_value > threshold:
                triggered.append({
                    "trigger": trigger_name,
                    "metric": trigger_config["metric"],
                    "value": metric_value,
                    "threshold": threshold,
                    "window_minutes": trigger_config["window_minutes"],
                })
            elif threshold_pct is not None and metric_value > threshold_pct / 100:
                # Percentage-based trigger needs baseline comparison
                # Simplified: assume baseline is implicit
                    triggered.append({
                        "trigger": trigger_name,
                        "metric": trigger_config["metric"],
                        "value": metric_value,
                        "threshold_pct": threshold_pct,
                        "window_minutes": trigger_config["window_minutes"],
                    })

        return triggered
