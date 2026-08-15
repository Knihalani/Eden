"""Comparative Analysis Engine — detects environment vs production behavior gaps.

Phase 6.3: Systematically compare environment test results against production
telemetry to find scenarios missing from the environment or behaviors that diverge.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.insights.unified_trace_model import Outcome, SpanType, UnifiedTrace
from eden.insights.utils import sequence_similarity

logger = logging.getLogger(__name__)


@dataclass
class DisparityDimension:
    name: str
    env_value: float
    prod_value: float
    gap: float
    severity: str  # critical, high, medium, low
    explanation: str = ""


@dataclass
class DisparityReport:
    report_id: str
    tenant_id: str
    env_trace_id: str
    prod_trace_id: str
    generated_at: datetime
    overall_score: float  # 0.0–1.0, higher = more divergent
    dimensions: list[DisparityDimension] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "report_id": self.report_id,
            "tenant_id": self.tenant_id,
            "env_trace_id": self.env_trace_id,
            "prod_trace_id": self.prod_trace_id,
            "generated_at": self.generated_at.isoformat(),
            "overall_score": self.overall_score,
            "dimensions": [
                {
                    "name": d.name,
                    "env_value": d.env_value,
                    "prod_value": d.prod_value,
                    "gap": d.gap,
                    "severity": d.severity,
                    "explanation": d.explanation,
                }
                for d in self.dimensions
            ],
            "recommendations": self.recommendations,
            "metadata": self.metadata,
        }


class ComparativeAnalysisEngine:
    """Compares environment and production traces to detect disparities.

    Operates on pairs of traces (environment + production) and produces
    structured DisparityReports with actionable recommendations.
    """

    def __init__(self):
        self._disparity_thresholds = {
            "critical": 0.6,
            "high": 0.4,
            "medium": 0.2,
            "low": 0.1,
        }

    def compare(
        self,
        env_trace: UnifiedTrace,
        prod_trace: UnifiedTrace,
        tenant_id: str,
    ) -> DisparityReport:
        """Compare an environment trace against its production counterpart."""
        report_id = f"disp_{env_trace.trace_id}_{prod_trace.trace_id}"[:64]
        dimensions: list[DisparityDimension] = []

        # Action divergence
        action_dim = self._compare_actions(env_trace, prod_trace)
        if action_dim:
            dimensions.append(action_dim)

        # Outcome divergence
        outcome_dim = self._compare_outcomes(env_trace, prod_trace)
        if outcome_dim:
            dimensions.append(outcome_dim)

        # Latency gap
        latency_dim = self._compare_latency(env_trace, prod_trace)
        if latency_dim:
            dimensions.append(latency_dim)

        # Coverage gap
        coverage_dim = self._compare_coverage(env_trace, prod_trace)
        if coverage_dim:
            dimensions.append(coverage_dim)

        # Tool usage gap
        tool_dim = self._compare_tool_usage(env_trace, prod_trace)
        if tool_dim:
            dimensions.append(tool_dim)

        # Error pattern gap
        error_dim = self._compare_error_patterns(env_trace, prod_trace)
        if error_dim:
            dimensions.append(error_dim)

        # Overall score = max gap weighted by severity
        overall_score = self._compute_overall_score(dimensions)

        recommendations = self._generate_recommendations(dimensions)

        return DisparityReport(
            report_id=report_id,
            tenant_id=tenant_id,
            env_trace_id=env_trace.trace_id,
            prod_trace_id=prod_trace.trace_id,
            generated_at=datetime.now(UTC),
            overall_score=overall_score,
            dimensions=dimensions,
            recommendations=recommendations,
            metadata={
                "env_agent_version": env_trace.agent_version,
                "prod_agent_version": prod_trace.agent_version,
                "env_env_version": env_trace.environment_version,
            },
        )

    def batch_compare(
        self,
        trace_pairs: list[tuple[UnifiedTrace, UnifiedTrace]],
        tenant_id: str,
    ) -> list[DisparityReport]:
        """Compare multiple trace pairs in batch."""
        reports = []
        for env_trace, prod_trace in trace_pairs:
            try:
                report = self.compare(env_trace, prod_trace, tenant_id)
                reports.append(report)
            except Exception as e:
                logger.warning(f"Failed to compare traces {env_trace.trace_id} vs {prod_trace.trace_id}: {e}")
        return reports

    def _compare_actions(
        self,
        env_trace: UnifiedTrace,
        prod_trace: UnifiedTrace,
    ) -> DisparityDimension | None:
        env_actions = self._extract_actions(env_trace)
        prod_actions = self._extract_actions(prod_trace)

        if not env_actions and not prod_actions:
            return None

        # Jaccard distance on action sets
        env_set = set(env_actions)
        prod_set = set(prod_actions)
        union = env_set | prod_set
        intersection = env_set & prod_set
        jaccard = 1.0 - (len(intersection) / len(union)) if union else 0.0

        # Sequence edit distance ratio
        seq_similarity = sequence_similarity(env_actions, prod_actions)

        gap = (jaccard + (1.0 - seq_similarity)) / 2.0
        severity = self._severity_for_gap(gap)

        explanation = f"Environment actions: {len(env_actions)}, Production actions: {len(prod_actions)}. "
        if jaccard > 0.5:
            explanation += f"Different action sets (Jaccard={jaccard:.2f}). "
        if seq_similarity < 0.7:
            explanation += f"Different action order (seq similarity={seq_similarity:.2f})."

        return DisparityDimension(
            name="action_divergence",
            env_value=len(env_actions),
            prod_value=len(prod_actions),
            gap=gap,
            severity=severity,
            explanation=explanation.strip(),
        )

    def _compare_outcomes(
        self,
        env_trace: UnifiedTrace,
        prod_trace: UnifiedTrace,
    ) -> DisparityDimension | None:
        env_outcome = env_trace.outcome.value
        prod_outcome = prod_trace.outcome.value

        if env_outcome == prod_outcome:
            return None

        gap = 1.0  # Any outcome mismatch is full divergence
        severity = "critical" if prod_trace.outcome == Outcome.SUCCESS and env_trace.outcome != Outcome.SUCCESS else "high"

        explanation = (
            f"Environment outcome: {env_outcome}, Production outcome: {prod_outcome}. "
            f"The environment {'does not replicate' if env_trace.outcome != Outcome.SUCCESS else 'over-predicts'} success."
        )

        return DisparityDimension(
            name="outcome_divergence",
            env_value=1.0 if env_trace.outcome == Outcome.SUCCESS else 0.0,
            prod_value=1.0 if prod_trace.outcome == Outcome.SUCCESS else 0.0,
            gap=gap,
            severity=severity,
            explanation=explanation,
        )

    def _compare_latency(
        self,
        env_trace: UnifiedTrace,
        prod_trace: UnifiedTrace,
    ) -> DisparityDimension | None:
        env_lat = env_trace.duration_ms
        prod_lat = prod_trace.duration_ms

        if env_lat <= 0 or prod_lat <= 0:
            return None

        ratio = max(env_lat, prod_lat) / max(min(env_lat, prod_lat), 1.0)
        gap = min(1.0, abs(ratio - 1.0) / 4.0)  # Normalize: 4x difference = full gap
        severity = self._severity_for_gap(gap)

        explanation = (
            f"Environment latency: {env_lat:.0f}ms, Production: {prod_lat:.0f}ms. "
            f"Ratio: {ratio:.1f}x."
        )

        return DisparityDimension(
            name="latency_gap",
            env_value=env_lat,
            prod_value=prod_lat,
            gap=gap,
            severity=severity,
            explanation=explanation,
        )

    def _compare_coverage(
        self,
        env_trace: UnifiedTrace,
        prod_trace: UnifiedTrace,
    ) -> DisparityDimension | None:
        env_states = self._extract_states(env_trace)
        prod_states = self._extract_states(prod_trace)

        if not env_states and not prod_states:
            return None

        env_set = set(env_states)
        prod_set = set(prod_states)

        missing_in_env = len(prod_set - env_set)
        missing_in_prod = len(env_set - prod_set)
        total_unique = len(env_set | prod_set)

        gap = missing_in_env / max(total_unique, 1) if total_unique > 0 else 0.0
        severity = self._severity_for_gap(gap)

        explanation = (
            f"Environment states: {len(env_set)}, Production states: {len(prod_set)}. "
            f"Missing in environment: {missing_in_env}. Missing in production: {missing_in_prod}."
        )

        return DisparityDimension(
            name="coverage_gap",
            env_value=len(env_set),
            prod_value=len(prod_set),
            gap=gap,
            severity=severity,
            explanation=explanation,
        )

    def _compare_tool_usage(
        self,
        env_trace: UnifiedTrace,
        prod_trace: UnifiedTrace,
    ) -> DisparityDimension | None:
        env_tools = self._extract_tools(env_trace)
        prod_tools = self._extract_tools(prod_trace)

        if not env_tools and not prod_tools:
            return None

        env_counts = {t: env_tools.count(t) for t in set(env_tools)}
        prod_counts = {t: prod_tools.count(t) for t in set(prod_tools)}
        all_tools = set(env_counts.keys()) | set(prod_counts.keys())

        total_diff = sum(abs(env_counts.get(t, 0) - prod_counts.get(t, 0)) for t in all_tools)
        total_calls = sum(env_counts.values()) + sum(prod_counts.values())

        gap = min(1.0, total_diff / max(total_calls, 1)) if total_calls > 0 else 0.0
        severity = self._severity_for_gap(gap)

        explanation = (
            f"Environment tool calls: {len(env_tools)}, Production: {len(prod_tools)}. "
            f"Tools used: env={set(env_counts.keys())}, prod={set(prod_counts.keys())}."
        )

        return DisparityDimension(
            name="tool_usage_gap",
            env_value=len(env_tools),
            prod_value=len(prod_tools),
            gap=gap,
            severity=severity,
            explanation=explanation,
        )

    def _compare_error_patterns(
        self,
        env_trace: UnifiedTrace,
        prod_trace: UnifiedTrace,
    ) -> DisparityDimension | None:
        env_errors = self._extract_error_categories(env_trace)
        prod_errors = self._extract_error_categories(prod_trace)

        if not env_errors and not prod_errors:
            return None

        env_set = set(env_errors)
        prod_set = set(prod_errors)

        only_in_prod = len(prod_set - env_set)
        only_in_env = len(env_set - prod_set)
        total = len(env_set | prod_set)

        gap = only_in_prod / max(total, 1) if total > 0 else 0.0
        severity = "critical" if only_in_prod > 0 else self._severity_for_gap(gap)

        explanation = (
            f"Environment error types: {env_set or 'none'}, Production: {prod_set or 'none'}. "
            f"Only in production: {only_in_prod}. Only in environment: {only_in_env}."
        )

        return DisparityDimension(
            name="error_pattern_gap",
            env_value=len(env_errors),
            prod_value=len(prod_errors),
            gap=gap,
            severity=severity,
            explanation=explanation,
        )

    def _extract_actions(self, trace: UnifiedTrace) -> list[str]:
        return [
            str(s.payload.get("action", ""))
            for s in trace.spans
            if s.span_type == SpanType.ENV_STEP and s.payload.get("action")
        ]

    def _extract_states(self, trace: UnifiedTrace) -> list[str]:
        return [
            str(s.payload.get("state_snapshot", ""))
            for s in trace.spans
            if s.span_type == SpanType.ENV_STEP and s.payload.get("state_snapshot")
        ]

    def _extract_tools(self, trace: UnifiedTrace) -> list[str]:
        return [
            str(s.payload.get("tool_name", ""))
            for s in trace.spans
            if s.span_type == SpanType.TOOL_INVOCATION and s.payload.get("tool_name")
        ]

    def _extract_error_categories(self, trace: UnifiedTrace) -> list[str]:
        return [i.get("category", "") for i in trace.insights if i.get("category")]

    def _severity_for_gap(self, gap: float) -> str:
        if gap >= self._disparity_thresholds["critical"]:
            return "critical"
        if gap >= self._disparity_thresholds["high"]:
            return "high"
        if gap >= self._disparity_thresholds["medium"]:
            return "medium"
        if gap >= self._disparity_thresholds["low"]:
            return "low"
        return "info"

    def _compute_overall_score(self, dimensions: list[DisparityDimension]) -> float:
        if not dimensions:
            return 0.0
        # Weight by severity
        weights = {"critical": 1.0, "high": 0.8, "medium": 0.5, "low": 0.2, "info": 0.0}
        weighted_sum = sum(d.gap * weights.get(d.severity, 0.2) for d in dimensions)
        total_weight = sum(weights.get(d.severity, 0.2) for d in dimensions)
        return min(1.0, weighted_sum / max(total_weight, 0.01))

    def _generate_recommendations(self, dimensions: list[DisparityDimension]) -> list[str]:
        recs = []
        dim_map = {d.name: d for d in dimensions}

        if "outcome_divergence" in dim_map:
            recs.append(
                "Environment does not replicate production outcomes. Review task equivalence and reward structure."
            )
        if "action_divergence" in dim_map:
            recs.append(
                "Different action sequences detected. Add environment variants covering divergent paths."
            )
        if "coverage_gap" in dim_map:
            d = dim_map["coverage_gap"]
            if d.gap > 0.3:
                recs.append(
                    f"{d.gap:.0%} of production states are missing from environment. Generate covering scenarios."
                )
        if "latency_gap" in dim_map:
            d = dim_map["latency_gap"]
            if d.gap > 0.2:
                recs.append(
                    f"Significant latency gap ({d.gap:.0%}). Adjust environment timing to match production."
                )
        if "tool_usage_gap" in dim_map:
            recs.append(
                "Different tool usage patterns. Ensure environment exercises the same tool set."
            )
        if "error_pattern_gap" in dim_map:
            d = dim_map["error_pattern_gap"]
            if d.gap > 0.0:
                recs.append(
                    f"Production errors not seen in environment ({d.gap:.0%}). Add adversarial tests."
                )

        if not recs:
            recs.append("No significant disparities detected. Environment fidelity is good.")

        return recs
