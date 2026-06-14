"""Eden LLMOps — Experiment Tracking for Agent Pipelines.

Every environment generation job in Eden is an experiment.
Track hyperparameters, configurations, outputs, and metrics for
reproducibility and comparison.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass
class Experiment:
    experiment_id: str
    experiment_name: str
    experiment_type: str  # prompt_ab | model_comparison | pipeline_config | feature_flag
    pipeline_version: str
    git_commit: str
    config_snapshot: dict[str, Any]
    model_artifact_ids: list[str] = field(default_factory=list)
    prompt_ids: list[str] = field(default_factory=list)
    feature_store_refs: dict[str, Any] = field(default_factory=dict)
    status: str = "running"  # running | completed | failed | aborted
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = None
    created_by: str | None = None
    baseline_experiment_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "experiment_id": self.experiment_id,
            "experiment_name": self.experiment_name,
            "experiment_type": self.experiment_type,
            "pipeline_version": self.pipeline_version,
            "git_commit": self.git_commit,
            "config_snapshot": self.config_snapshot,
            "model_artifact_ids": self.model_artifact_ids,
            "prompt_ids": self.prompt_ids,
            "feature_store_refs": self.feature_store_refs,
            "status": self.status,
            "started_at": self.started_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "created_by": self.created_by,
            "baseline_experiment_id": self.baseline_experiment_id,
        }


@dataclass
class ExperimentRun:
    run_id: str
    experiment_id: str
    job_id: str | None = None
    run_params: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)
    outputs: dict[str, Any] = field(default_factory=dict)
    artifacts: dict[str, Any] = field(default_factory=dict)
    status: str = "running"
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "experiment_id": self.experiment_id,
            "job_id": self.job_id,
            "run_params": self.run_params,
            "metrics": self.metrics,
            "outputs": self.outputs,
            "artifacts": self.artifacts,
            "status": self.status,
            "started_at": self.started_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class ExperimentTracker:
    """In-memory experiment tracker with baseline comparison and regression detection.

    Production would persist to PostgreSQL.
    """

    REGRESSION_THRESHOLD = 0.05  # 5% degradation triggers alert

    def __init__(self) -> None:
        self._experiments: dict[str, Experiment] = {}
        self._runs: dict[str, list[ExperimentRun]] = {}  # experiment_id -> [runs]
        self._baselines: dict[str, str] = {}  # experiment_name -> experiment_id

    def create_experiment(self, experiment: Experiment) -> Experiment:
        self._experiments[experiment.experiment_id] = experiment
        self._runs[experiment.experiment_id] = []
        return experiment

    def get_experiment(self, experiment_id: str) -> Experiment | None:
        return self._experiments.get(experiment_id)

    def list_experiments(
        self,
        experiment_type: str | None = None,
        status: str | None = None,
    ) -> list[Experiment]:
        experiments = list(self._experiments.values())
        if experiment_type:
            experiments = [e for e in experiments if e.experiment_type == experiment_type]
        if status:
            experiments = [e for e in experiments if e.status == status]
        return sorted(experiments, key=lambda e: e.started_at, reverse=True)

    def add_run(self, run: ExperimentRun) -> ExperimentRun:
        self._runs.setdefault(run.experiment_id, []).append(run)
        return run

    def get_runs(self, experiment_id: str) -> list[ExperimentRun]:
        return sorted(
            self._runs.get(experiment_id, []),
            key=lambda r: r.started_at,
            reverse=True,
        )

    def complete_experiment(self, experiment_id: str, status: str = "completed") -> Experiment | None:
        experiment = self._experiments.get(experiment_id)
        if experiment:
            experiment.status = status
            experiment.completed_at = datetime.now(UTC)
        return experiment

    def set_baseline(self, experiment_name: str, experiment_id: str) -> None:
        self._baselines[experiment_name] = experiment_id

    def get_baseline(self, experiment_name: str) -> Experiment | None:
        baseline_id = self._baselines.get(experiment_name)
        if baseline_id:
            return self._experiments.get(baseline_id)
        # Fallback to most recent completed experiment with same name
        candidates = [
            e for e in self._experiments.values()
            if e.experiment_name == experiment_name and e.status == "completed"
        ]
        if candidates:
            return max(candidates, key=lambda e: e.completed_at or e.started_at)
        return None

    def compare_to_baseline(self, experiment_id: str) -> dict[str, Any] | None:
        """Compare experiment metrics to its baseline."""
        experiment = self._experiments.get(experiment_id)
        if not experiment:
            return None

        baseline = self.get_baseline(experiment.experiment_name)
        if not baseline or baseline.experiment_id == experiment_id:
            return None

        baseline_runs = self.get_runs(baseline.experiment_id)
        current_runs = self.get_runs(experiment_id)

        if not baseline_runs or not current_runs:
            return None

        # Aggregate metrics
        baseline_metrics = self._aggregate_metrics(baseline_runs)
        current_metrics = self._aggregate_metrics(current_runs)

        comparisons = {}
        for key in set(baseline_metrics.keys()) | set(current_metrics.keys()):
            b_val = baseline_metrics.get(key, 0.0)
            c_val = current_metrics.get(key, 0.0)
            if isinstance(b_val, (int, float)) and b_val != 0:
                change_pct = (c_val - b_val) / abs(b_val)
            else:
                change_pct = 0.0
            comparisons[key] = {
                "baseline": b_val,
                "current": c_val,
                "change_abs": c_val - b_val,
                "change_pct": round(change_pct, 4),
                "regression": change_pct < -self.REGRESSION_THRESHOLD,
            }

        return {
            "baseline_experiment_id": baseline.experiment_id,
            "comparisons": comparisons,
            "overall_regression": any(c["regression"] for c in comparisons.values()),
        }

    def _aggregate_metrics(self, runs: list[ExperimentRun]) -> dict[str, float]:
        """Average numeric metrics across runs."""
        totals: dict[str, list[float]] = {}
        for run in runs:
            for key, value in run.metrics.items():
                if isinstance(value, (int, float)):
                    totals.setdefault(key, []).append(float(value))
        return {k: sum(v) / len(v) for k, v in totals.items() if v}

    def check_regression(self, experiment_id: str) -> dict[str, Any] | None:
        """Check if experiment shows regression vs baseline."""
        comparison = self.compare_to_baseline(experiment_id)
        if not comparison:
            return None
        regressions = {
            k: v for k, v in comparison["comparisons"].items()
            if v["regression"]
        }
        return {
            "has_regression": len(regressions) > 0,
            "regressions": regressions,
            "threshold": self.REGRESSION_THRESHOLD,
        }

    def auto_rollback_recommendation(self, experiment_id: str) -> dict[str, Any]:
        """Recommend rollback if significant regression detected."""
        regression = self.check_regression(experiment_id)
        if not regression:
            return {"recommend_rollback": False, "reason": "No baseline or no regression detected"}

        if regression["has_regression"]:
            return {
                "recommend_rollback": True,
                "reason": f"Significant regression detected in {len(regression['regressions'])} metrics",
                "regressions": regression["regressions"],
                "recommended_action": "Revert to baseline configuration",
            }
        return {"recommend_rollback": False, "reason": "No significant regression"}
