"""Eden LLMOps — Production Model Monitoring.

Detects model degradation, hallucinations, latency spikes, cost inflation,
and pass-rate drift. Uses LLM-as-judge for hallucination detection and
statistical process control for trend monitoring.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any


class AlertSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


logger = logging.getLogger(__name__)


@dataclass
class MonitoringAlert:
    alert_id: str
    dimension: str
    severity: AlertSeverity
    message: str
    metric_value: float
    baseline_value: float
    threshold: float
    model_family: str
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    acknowledged: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "alert_id": self.alert_id,
            "dimension": self.dimension,
            "severity": self.severity.value,
            "message": self.message,
            "metric_value": self.metric_value,
            "baseline_value": self.baseline_value,
            "threshold": self.threshold,
            "model_family": self.model_family,
            "created_at": self.created_at.isoformat(),
            "acknowledged": self.acknowledged,
        }


@dataclass
class ModelHealthSnapshot:
    model_family: str
    model_version: str
    timestamp: datetime
    output_drift_kl: float
    hallucination_rate: float
    token_efficiency: float
    latency_p95_ms: float
    cost_per_env_usd: float
    pass_rate: float
    overall_score: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_family": self.model_family,
            "model_version": self.model_version,
            "timestamp": self.timestamp.isoformat(),
            "output_drift_kl": self.output_drift_kl,
            "hallucination_rate": self.hallucination_rate,
            "token_efficiency": self.token_efficiency,
            "latency_p95_ms": self.latency_p95_ms,
            "cost_per_env_usd": self.cost_per_env_usd,
            "pass_rate": self.pass_rate,
            "overall_score": self.overall_score,
        }


class ProductionMonitor:
    """Monitors model performance in production with multi-dimension alerting.

    Tracks: output drift, hallucination rate, token efficiency, latency,
    cost inflation, and pass-rate drift. Uses EWMA and 3-sigma bounds
    for statistical process control.
    """

    # Alert thresholds
    DRIFT_KL_THRESHOLD = 0.1
    HALLUCINATION_RATE_THRESHOLD = 0.05
    TOKEN_EFFICIENCY_SPIKE = 0.20  # 20% increase
    LATENCY_DEGRADATION = 2.0      # 2x baseline
    COST_INFLATION = 0.15         # 15% MoM
    PASS_RATE_DEGRADATION = 0.05  # 5% drop

    def __init__(self) -> None:
        self._snapshots: dict[str, list[ModelHealthSnapshot]] = {}  # model -> snapshots
        self._alerts: list[MonitoringAlert] = []
        self._baselines: dict[str, dict[str, float]] = {}  # model -> {metric: value}
        self._ewma: dict[str, dict[str, float]] = {}       # model -> {metric: ewma}
        self._ewma_var: dict[str, dict[str, float]] = {}  # model -> {metric: variance}
        self._ewma_alpha = 0.3

    def record_snapshot(self, snapshot: ModelHealthSnapshot) -> list[MonitoringAlert]:
        """Record a health snapshot and evaluate alerts."""
        key = f"{snapshot.model_family}:{snapshot.model_version}"
        self._snapshots.setdefault(key, []).append(snapshot)

        # Auto-establish baseline if not set
        if key not in self._baselines:
            self._baselines[key] = {
                "output_drift_kl": snapshot.output_drift_kl,
                "hallucination_rate": snapshot.hallucination_rate,
                "token_efficiency": snapshot.token_efficiency,
                "latency_p95_ms": snapshot.latency_p95_ms,
                "cost_per_env_usd": snapshot.cost_per_env_usd,
                "pass_rate": snapshot.pass_rate,
            }

        # Update EWMA
        if key not in self._ewma:
            self._ewma[key] = {}
            self._ewma_var[key] = {}

        metrics = {
            "output_drift_kl": snapshot.output_drift_kl,
            "hallucination_rate": snapshot.hallucination_rate,
            "token_efficiency": snapshot.token_efficiency,
            "latency_p95_ms": snapshot.latency_p95_ms,
            "cost_per_env_usd": snapshot.cost_per_env_usd,
            "pass_rate": snapshot.pass_rate,
        }

        for m_name, value in metrics.items():
            prev_ewma = self._ewma[key].get(m_name, value)
            prev_var = self._ewma_var[key].get(m_name, 0.0)
            new_ewma = self._ewma_alpha * value + (1 - self._ewma_alpha) * prev_ewma
            # Welford-like variance update
            diff = value - prev_ewma
            new_var = (1 - self._ewma_alpha) * prev_var + self._ewma_alpha * diff * diff
            self._ewma[key][m_name] = new_ewma
            self._ewma_var[key][m_name] = new_var

        # Evaluate alerts
        alerts = self._evaluate_alerts(key, snapshot)
        self._alerts.extend(alerts)
        return alerts

    def _evaluate_alerts(
        self,
        key: str,
        snapshot: ModelHealthSnapshot,
    ) -> list[MonitoringAlert]:
        alerts: list[MonitoringAlert] = []
        baseline = self._baselines.get(key, {})
        ewma_stats = self._ewma.get(key, {})
        ewma_var = self._ewma_var.get(key, {})

        def _sigma(metric: str) -> float:
            v = ewma_var.get(metric, 0.0)
            return math.sqrt(v) if v > 0 else 0.0

        # Output drift
        if snapshot.output_drift_kl > self.DRIFT_KL_THRESHOLD:
            alerts.append(MonitoringAlert(
                alert_id=f"drift_{key}_{int(time.time())}",
                dimension="output_drift",
                severity=AlertSeverity.CRITICAL if snapshot.output_drift_kl > 0.2 else AlertSeverity.WARNING,
                message=f"Output drift KL divergence {snapshot.output_drift_kl:.3f} exceeds threshold {self.DRIFT_KL_THRESHOLD}",
                metric_value=snapshot.output_drift_kl,
                baseline_value=baseline.get("output_drift_kl", 0.0),
                threshold=self.DRIFT_KL_THRESHOLD,
                model_family=snapshot.model_family,
            ))

        # Hallucination rate
        if snapshot.hallucination_rate > self.HALLUCINATION_RATE_THRESHOLD:
            alerts.append(MonitoringAlert(
                alert_id=f"hallucination_{key}_{int(time.time())}",
                dimension="hallucination_rate",
                severity=AlertSeverity.CRITICAL,
                message=f"Hallucination rate {snapshot.hallucination_rate:.2%} exceeds threshold {self.HALLUCINATION_RATE_THRESHOLD:.2%}",
                metric_value=snapshot.hallucination_rate,
                baseline_value=baseline.get("hallucination_rate", 0.0),
                threshold=self.HALLUCINATION_RATE_THRESHOLD,
                model_family=snapshot.model_family,
            ))

        # Token efficiency spike
        base_eff = baseline.get("token_efficiency", 0.0)
        if base_eff > 0 and snapshot.token_efficiency > base_eff * (1 + self.TOKEN_EFFICIENCY_SPIKE):
            alerts.append(MonitoringAlert(
                alert_id=f"token_efficiency_{key}_{int(time.time())}",
                dimension="token_efficiency",
                severity=AlertSeverity.WARNING,
                message=f"Token efficiency degraded: {snapshot.token_efficiency:.2f} vs baseline {base_eff:.2f}",
                metric_value=snapshot.token_efficiency,
                baseline_value=base_eff,
                threshold=base_eff * (1 + self.TOKEN_EFFICIENCY_SPIKE),
                model_family=snapshot.model_family,
            ))

        # Latency degradation (3-sigma)
        lat_sigma = _sigma("latency_p95_ms")
        lat_ewma = ewma_stats.get("latency_p95_ms", baseline.get("latency_p95_ms", 0))
        if lat_sigma > 0 and snapshot.latency_p95_ms > lat_ewma + 3 * lat_sigma:
            alerts.append(MonitoringAlert(
                alert_id=f"latency_{key}_{int(time.time())}",
                dimension="latency_p95_ms",
                severity=AlertSeverity.WARNING,
                message=f"Latency P95 spike: {snapshot.latency_p95_ms:.0f}ms (3σ above EWMA {lat_ewma:.0f}ms)",
                metric_value=snapshot.latency_p95_ms,
                baseline_value=lat_ewma,
                threshold=lat_ewma + 3 * lat_sigma,
                model_family=snapshot.model_family,
            ))

        # Cost inflation
        base_cost = baseline.get("cost_per_env_usd", 0.0)
        if base_cost > 0 and snapshot.cost_per_env_usd > base_cost * (1 + self.COST_INFLATION):
            alerts.append(MonitoringAlert(
                alert_id=f"cost_{key}_{int(time.time())}",
                dimension="cost_per_env_usd",
                severity=AlertSeverity.WARNING,
                message=f"Cost inflation: ${snapshot.cost_per_env_usd:.3f} vs baseline ${base_cost:.3f}",
                metric_value=snapshot.cost_per_env_usd,
                baseline_value=base_cost,
                threshold=base_cost * (1 + self.COST_INFLATION),
                model_family=snapshot.model_family,
            ))

        # Pass rate drift (CUSUM-like)
        base_pass = baseline.get("pass_rate", 1.0)
        if snapshot.pass_rate < base_pass - self.PASS_RATE_DEGRADATION:
            alerts.append(MonitoringAlert(
                alert_id=f"pass_rate_{key}_{int(time.time())}",
                dimension="pass_rate",
                severity=AlertSeverity.CRITICAL,
                message=f"Pass rate dropped to {snapshot.pass_rate:.2%} from baseline {base_pass:.2%}",
                metric_value=snapshot.pass_rate,
                baseline_value=base_pass,
                threshold=base_pass - self.PASS_RATE_DEGRADATION,
                model_family=snapshot.model_family,
            ))

        return alerts

    def get_health_history(
        self,
        model_family: str,
        hours: int = 24,
    ) -> list[ModelHealthSnapshot]:
        key = f"{model_family}:"
        cutoff = datetime.now(UTC) - timedelta(hours=hours)
        all_snapshots: list[ModelHealthSnapshot] = []
        for k, snaps in self._snapshots.items():
            if k.startswith(key):
                all_snapshots.extend([s for s in snaps if s.timestamp >= cutoff])
        return sorted(all_snapshots, key=lambda s: s.timestamp)

    def get_alerts(
        self,
        model_family: str | None = None,
        severity: AlertSeverity | None = None,
        acknowledged: bool | None = None,
        limit: int = 100,
    ) -> list[MonitoringAlert]:
        alerts = self._alerts
        if model_family:
            alerts = [a for a in alerts if a.model_family == model_family]
        if severity:
            alerts = [a for a in alerts if a.severity == severity]
        if acknowledged is not None:
            alerts = [a for a in alerts if a.acknowledged == acknowledged]
        return sorted(alerts, key=lambda a: a.created_at, reverse=True)[:limit]

    def acknowledge_alert(self, alert_id: str) -> MonitoringAlert | None:
        for alert in self._alerts:
            if alert.alert_id == alert_id:
                alert.acknowledged = True
                return alert
        return None

    def get_latest_health(self, model_family: str) -> ModelHealthSnapshot | None:
        key_prefix = f"{model_family}:"
        latest: ModelHealthSnapshot | None = None
        for k, snaps in self._snapshots.items():
            if k.startswith(key_prefix) and snaps:
                candidate = max(snaps, key=lambda s: s.timestamp)
                if latest is None or candidate.timestamp > latest.timestamp:
                    latest = candidate
        return latest

    def get_overall_health(self) -> dict[str, Any]:
        """Aggregate health across all models."""
        all_latest: list[ModelHealthSnapshot] = []
        seen_families: set[str] = set()
        for k, _snaps in self._snapshots.items():
            family = k.split(":")[0]
            if family in seen_families:
                continue
            seen_families.add(family)
            latest = self.get_latest_health(family)
            if latest:
                all_latest.append(latest)

        if not all_latest:
            return {"status": "unknown", "models": [], "unacknowledged_alerts": 0}

        avg_score = sum(s.overall_score for s in all_latest) / len(all_latest)
        status = "healthy" if avg_score > 0.85 else "degraded" if avg_score > 0.70 else "critical"
        unacknowledged = len([a for a in self._alerts if not a.acknowledged])

        return {
            "status": status,
            "avg_overall_score": round(avg_score, 3),
            "models": [s.to_dict() for s in all_latest],
            "unacknowledged_alerts": unacknowledged,
        }

    async def evaluate_hallucination(
        self,
        generated_code: str,
        spec: str,
        ground_truth: str | None = None,
    ) -> dict[str, Any]:
        """Hallucination detection.

        Two-stage check:
          1. **Fast heuristic filter** (always runs) — flags obvious
             LLM failure modes (suspicious imports, low spec
             alignment). Cheap to call on every generation.
          2. **Strong-judge follow-up** (Phase 7.1b) — when
             ``settings.production_monitor_use_llm_judge`` is True, a
             small LLM (default ``fast`` slot) re-scores the output
             using the prompts in
             ``src/eden/llmops/judges/hallucination.py``. The LLM's
             score replaces the heuristic score so the heuristic
             becomes a quick pre-filter that *also* emits a low-cost
             score; the LLM only runs when its score is materially
             different.

        Heuristics are deliberately conservative (high recall,
        moderate precision) so the fast path flags anything worth
        a second look.
        """
        # Heuristic pre-filter (cheap, deterministic, runs on every gen)
        heuristic_score = 1.0
        issues: list[str] = []

        # Check for common hallucination patterns
        if "import " in generated_code:
            suspicious = ["fake_module", "nonexistent", "placeholder_lib"]
            for pkg in suspicious:
                if pkg in generated_code.lower():
                    heuristic_score -= 0.15
                    issues.append(f"Suspicious import: {pkg}")

        # Check spec alignment (very basic)
        spec_keywords = set(spec.lower().split())
        code_keywords = set(generated_code.lower().split())
        overlap = len(spec_keywords & code_keywords) / max(len(spec_keywords), 1)
        if overlap < 0.1:
            heuristic_score -= 0.2
            issues.append("Low spec alignment")

        heuristic_score = max(0.0, min(1.0, heuristic_score))

        # If the LLM-judge toggle is off, return the heuristic result.
        try:
            from eden.config import get_settings
            settings = get_settings()
            use_llm = bool(getattr(settings, "production_monitor_use_llm_judge", False))
        except Exception:
            use_llm = False

        if not use_llm:
            return {
                "hallucination_detected": heuristic_score < 0.85,
                "confidence": heuristic_score,
                "issues": issues,
                "categories": {
                    "api_correctness": round(heuristic_score, 2),
                    "logic_correctness": round(heuristic_score, 2),
                    "type_safety": round(heuristic_score, 2),
                    "dependency_correctness": round(heuristic_score, 2),
                },
            }

        # LLM-judge path. Build a minimal TelemetryEvent-shaped
        # object that the HallucinationJudge can score.
        try:
            from eden.llm.client import OpenRouterClient
            from eden.llmops.judges.base import JudgeContext
            from eden.llmops.judges.hallucination import HallucinationJudge

            class _E:
                __slots__ = (
                    "event_id", "trace_id", "span_id", "event_type",
                    "payload", "attributes", "tags", "source_format",
                    "tenant_id", "agent_id", "environment_id",
                    "metrics", "duration_ms", "outcome", "name",
                    "timestamp", "realm", "project_id",
                    "agent_version", "parent_span_id",
                )
            ev = _E()
            for f in _E.__slots__:
                setattr(ev, f, None)
            ev.event_type = "eden.production_monitor.hallucination"
            ev.event_id = f"pm_hallu_{int(1e9 * 0)}"  # placeholder
            ev.trace_id = "production_monitor"
            ev.payload = {
                "task": spec,
                "ground_truth": ground_truth,
                "openai": {"first_message_content": generated_code},
            }

            llm_client = OpenRouterClient()
            judge = HallucinationJudge()
            score_obj = await judge.score(
                ev, JudgeContext(event=ev, llm_client=llm_client)
            )
            llm_score = max(0.0, min(1.0, score_obj.score))
            return {
                "hallucination_detected": llm_score < 0.85,
                "confidence": llm_score,
                "issues": issues,
                "rationale": score_obj.rationale,
                "judge_model": score_obj.model,
                "categories": {
                    "api_correctness": round(llm_score, 2),
                    "logic_correctness": round(llm_score, 2),
                    "type_safety": round(llm_score, 2),
                    "dependency_correctness": round(llm_score, 2),
                },
                "heuristic_score": round(heuristic_score, 3),
            }
        except Exception as exc:
            # LLM judge path failed (no client, network error, etc).
            # Fall back to the heuristic result so the pipeline
            # never blocks.
            logger.debug(
                f"production_monitor LLM judge failed; using heuristic: {exc}"
            )
            return {
                "hallucination_detected": heuristic_score < 0.85,
                "confidence": heuristic_score,
                "issues": issues,
                "judge_error": type(exc).__name__,
                "categories": {
                    "api_correctness": round(heuristic_score, 2),
                    "logic_correctness": round(heuristic_score, 2),
                    "type_safety": round(heuristic_score, 2),
                    "dependency_correctness": round(heuristic_score, 2),
                },
            }
