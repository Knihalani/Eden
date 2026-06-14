"""Detector modules for the Insights Engine.

Six detectors that automatically analyze traces and generate actionable insights:
1. FailurePatternDetector — recurring failure sequences
2. PerformanceAnomalyDetector — latency/token/cost outliers
3. RegressionDetector — metric degradation across versions
4. DisparityDetector — environment vs production gaps
5. RewardHackingDetector — exploit signals in environment traces
6. NovelBehaviorDetector — emergent or unseen behaviors
"""

from __future__ import annotations

import logging
import statistics
from abc import ABC, abstractmethod
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.insights.unified_trace_model import Outcome, SpanType, UnifiedTrace
from eden.insights.utils import BoundedSet

logger = logging.getLogger(__name__)


@dataclass
class Insight:
    insight_id: str
    detector: str
    severity: str  # critical, high, medium, low, info
    confidence: float  # 0.0–1.0
    summary: str
    affected_trace_ids: list[str] = field(default_factory=list)
    pattern: dict[str, Any] = field(default_factory=dict)
    recommended_action: str = ""
    auto_created_dataset: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "insight_id": self.insight_id,
            "detector": self.detector,
            "severity": self.severity,
            "confidence": self.confidence,
            "summary": self.summary,
            "affected_trace_ids": self.affected_trace_ids,
            "pattern": self.pattern,
            "recommended_action": self.recommended_action,
            "auto_created_dataset": self.auto_created_dataset,
            "metadata": self.metadata,
        }


class BaseDetector(ABC):
    """Abstract base for all insight detectors."""

    def __init__(self, name: str, min_confidence: float = 0.7) -> None:
        self.name = name
        self.min_confidence = min_confidence

    @abstractmethod
    def analyze(self, traces: list[UnifiedTrace]) -> list[Insight]:
        """Analyze a batch of traces and return insights."""
        ...

    def _make_id(self, prefix: str, *parts: str) -> str:
        from hashlib import sha256
        content = "|".join([prefix] + list(parts))
        return f"ins_{sha256(content.encode()).hexdigest()[:16]}"


class FailurePatternDetector(BaseDetector):
    """Detects recurring failure patterns across traces.

    Identifies sequences like "tool X returns empty → llm.completion → failure"
    and flags them as systematic issues.
    """

    def __init__(self, min_occurrences: int = 3, min_confidence: float = 0.75) -> None:
        super().__init__("failure_pattern", min_confidence)
        self.min_occurrences = min_occurrences

    def analyze(self, traces: list[UnifiedTrace]) -> list[Insight]:
        insights = []
        failure_traces = [t for t in traces if t.outcome != Outcome.SUCCESS]
        if len(failure_traces) < self.min_occurrences:
            return insights

        # Extract failure sequences
        sequences: dict[str, list[str]] = defaultdict(list)
        for trace in failure_traces:
            seq = self._extract_sequence(trace)
            if seq:
                key = "->".join(seq)
                sequences[key].append(trace.trace_id)

        # Find recurring patterns
        for seq_key, trace_ids in sequences.items():
            if len(trace_ids) >= self.min_occurrences:
                confidence = min(0.99, 0.5 + len(trace_ids) * 0.05)
                parts = seq_key.split("->")
                insights.append(Insight(
                    insight_id=self._make_id("fp", seq_key),
                    detector=self.name,
                    severity="high" if len(trace_ids) >= 5 else "medium",
                    confidence=confidence,
                    summary=f"Recurring failure: {' → '.join(parts)} ({len(trace_ids)} occurrences)",
                    affected_trace_ids=trace_ids[:50],
                    pattern={
                        "sequence": parts,
                        "occurrences": len(trace_ids),
                        "failure_rate": len(trace_ids) / max(len(failure_traces), 1),
                    },
                    recommended_action="Review the sequence for systematic issues; consider environment adjustments",
                    auto_created_dataset=f"ds_failure_pattern_{self._make_id('', seq_key)[:8]}",
                ))

        # Find tool-specific failure clusters
        tool_failures: dict[str, list[str]] = defaultdict(list)
        for trace in failure_traces:
            for span in trace.spans:
                if (
                    span.span_type == SpanType.TOOL_INVOCATION
                    and not span.payload.get("success", True)
                ):
                    tool_name = span.payload.get("tool_name", "unknown")
                    tool_failures[tool_name].append(trace.trace_id)

        for tool_name, trace_ids in tool_failures.items():
            if len(trace_ids) >= self.min_occurrences:
                confidence = min(0.95, 0.6 + len(trace_ids) * 0.04)
                insights.append(Insight(
                    insight_id=self._make_id("tf", tool_name),
                    detector=self.name,
                    severity="high" if len(trace_ids) >= 5 else "medium",
                    confidence=confidence,
                    summary=f"Tool '{tool_name}' fails {len(trace_ids)} times — potential misuse or environment issue",
                    affected_trace_ids=trace_ids[:50],
                    pattern={
                        "tool_name": tool_name,
                        "failure_count": len(trace_ids),
                        "failure_rate": len(trace_ids) / max(len(traces), 1),
                    },
                    recommended_action=f"Investigate {tool_name} usage patterns and environment handling",
                    auto_created_dataset=f"ds_tool_fail_{tool_name[:20]}",
                ))

        return insights

    def _extract_sequence(self, trace: UnifiedTrace) -> list[str]:
        """Extract a simplified event sequence from a trace."""
        seq = []
        for span in trace.spans:
            if span.span_type == SpanType.TOOL_INVOCATION:
                tool = span.payload.get("tool_name", "tool")
                status = "fail" if not span.payload.get("success", True) else "ok"
                seq.append(f"tool.{tool}.{status}")
            elif span.span_type == SpanType.LLM_COMPLETION:
                seq.append("llm")
            elif span.span_type == SpanType.ENV_STEP:
                reward = span.payload.get("reward", 0)
                seq.append(f"env_step(r={reward:.1f})")
        return seq


class PerformanceAnomalyDetector(BaseDetector):
    """Detects performance anomalies: latency spikes, token explosions, cost outliers.

    Uses rolling statistics to flag traces that deviate significantly from baseline.
    """

    def __init__(self, z_threshold: float = 2.5, min_confidence: float = 0.8) -> None:
        super().__init__("performance_anomaly", min_confidence)
        self.z_threshold = z_threshold

    def analyze(self, traces: list[UnifiedTrace]) -> list[Insight]:
        insights = []
        if len(traces) < 5:
            return insights

        # Group by agent_version for version-relative baselines
        by_version: dict[str, list[UnifiedTrace]] = defaultdict(list)
        for t in traces:
            by_version[t.agent_version or "unknown"].append(t)

        for version, version_traces in by_version.items():
            for metric_name, extractor in self._metric_extractors().items():
                values = [(t, extractor(t)) for t in version_traces if extractor(t) is not None]
                if len(values) < 5:
                    continue

                nums = [v for _, v in values]
                try:
                    mean = statistics.mean(nums)
                    stdev = statistics.stdev(nums) if len(nums) > 1 else 0
                except statistics.StatisticsError:
                    continue

                if stdev == 0:
                    continue

                for trace, val in values:
                    z_score = abs(val - mean) / stdev if stdev > 0 else 0
                    if z_score >= self.z_threshold:
                        confidence = min(0.99, 0.7 + (z_score - self.z_threshold) * 0.1)
                        direction = "spike" if val > mean else "drop"
                        insights.append(Insight(
                            insight_id=self._make_id("pa", trace.trace_id, metric_name),
                            detector=self.name,
                            severity="high" if z_score >= 4.0 else "medium",
                            confidence=confidence,
                            summary=f"{metric_name} {direction}: {val:.1f} (z={z_score:.1f}, baseline={mean:.1f})",
                            affected_trace_ids=[trace.trace_id],
                            pattern={
                                "metric": metric_name,
                                "value": val,
                                "baseline_mean": mean,
                                "baseline_stdev": stdev,
                                "z_score": z_score,
                                "direction": direction,
                                "agent_version": version,
                            },
                            recommended_action=f"Investigate {metric_name} {direction} in agent version {version}",
                        ))

        return insights

    def _metric_extractors(self) -> dict[str, Any]:
        return {
            "latency_ms": lambda t: t.duration_ms if t.duration_ms > 0 else None,
            "total_tokens": lambda t: t.metrics.get("total_tokens", 0) or None,
            "prompt_tokens": lambda t: t.metrics.get("prompt_tokens", 0) or None,
            "completion_tokens": lambda t: t.metrics.get("completion_tokens", 0) or None,
            "cost_usd": lambda t: t.metrics.get("cost_usd", 0) or None,
            "llm_calls": lambda t: len([s for s in t.spans if s.span_type == SpanType.LLM_COMPLETION]) or None,
            "tool_calls": lambda t: len([s for s in t.spans if s.span_type == SpanType.TOOL_INVOCATION]) or None,
        }


class RegressionDetector(BaseDetector):
    """Detects statistically significant metric degradation across agent or environment versions.

    Compares latest version against baseline using Welch's t-test approximation.
    """

    def __init__(self, degradation_threshold: float = 0.05, min_samples: int = 5, min_confidence: float = 0.8) -> None:
        super().__init__("regression", min_confidence)
        self.degradation_threshold = degradation_threshold
        self.min_samples = min_samples

    def analyze(self, traces: list[UnifiedTrace]) -> list[Insight]:
        insights = []
        if len(traces) < self.min_samples * 2:
            return insights

        # Group by (agent_version, environment_version)
        by_version: dict[tuple[str, str], list[UnifiedTrace]] = defaultdict(list)
        for t in traces:
            key = (t.agent_version or "unknown", t.environment_version or "unknown")
            by_version[key].append(t)

        # Find the most recent version as "latest"
        version_keys = sorted(by_version.keys(), key=lambda k: k[0], reverse=True)
        if len(version_keys) < 2:
            return insights

        latest = version_keys[0]
        baseline_versions = version_keys[1:]

        # Metrics to check for regression
        metrics_to_check = ["success_rate", "mean_latency_ms", "mean_cost_usd"]

        for metric in metrics_to_check:
            latest_values = self._extract_metric_values(by_version[latest], metric)
            baseline_values = []
            for bv in baseline_versions:
                baseline_values.extend(self._extract_metric_values(by_version[bv], metric))

            if len(latest_values) < self.min_samples or len(baseline_values) < self.min_samples:
                continue

            latest_mean = statistics.mean(latest_values)
            baseline_mean = statistics.mean(baseline_values)

            # Detect regression direction
            if metric == "success_rate":
                is_regression = latest_mean < baseline_mean - self.degradation_threshold
                delta = baseline_mean - latest_mean
            else:
                is_regression = latest_mean > baseline_mean * (1 + self.degradation_threshold)
                delta = latest_mean - baseline_mean

            if not is_regression:
                continue

            # Approximate confidence using overlap
            try:
                latest_stdev = statistics.stdev(latest_values) if len(latest_values) > 1 else 0
                baseline_stdev = statistics.stdev(baseline_values) if len(baseline_values) > 1 else 0
                pooled_stdev = ((latest_stdev ** 2 + baseline_stdev ** 2) / 2) ** 0.5
                if pooled_stdev > 0:
                    effect_size = abs(latest_mean - baseline_mean) / pooled_stdev
                    confidence = min(0.99, 0.6 + effect_size * 0.15)
                else:
                    confidence = 0.7
            except Exception:
                confidence = 0.7

            latest_trace_ids = [t.trace_id for t in by_version[latest]]

            insights.append(Insight(
                insight_id=self._make_id("reg", latest[0], metric),
                detector=self.name,
                severity="high" if delta > self.degradation_threshold * 2 else "medium",
                confidence=confidence,
                summary=f"Regression in {metric}: latest={latest_mean:.3f}, baseline={baseline_mean:.3f} (Δ={delta:.3f})",
                affected_trace_ids=latest_trace_ids[:50],
                pattern={
                    "metric": metric,
                    "latest_version": latest[0],
                    "baseline_versions": [v[0] for v in baseline_versions],
                    "latest_mean": latest_mean,
                    "baseline_mean": baseline_mean,
                    "delta": delta,
                    "latest_samples": len(latest_values),
                    "baseline_samples": len(baseline_values),
                },
                recommended_action=f"Investigate changes between version {latest[0]} and baseline; run targeted benchmarks",
                auto_created_dataset=f"ds_regression_{metric}_{latest[0][:16]}",
            ))

        return insights

    def _extract_metric_values(self, traces: list[UnifiedTrace], metric: str) -> list[float]:
        values = []
        for t in traces:
            if metric == "success_rate":
                values.append(1.0 if t.outcome == Outcome.SUCCESS else 0.0)
            elif metric in t.metrics:
                values.append(float(t.metrics[metric]))
        return values


class DisparityDetector(BaseDetector):
    """Detects environment vs production behavior gaps.

    Analyzes comparative traces to find scenarios present in production
    but missing or divergent in environment testing.
    """

    def __init__(self, divergence_threshold: float = 0.3, min_confidence: float = 0.75) -> None:
        super().__init__("disparity", min_confidence)
        self.divergence_threshold = divergence_threshold

    def analyze(self, traces: list[UnifiedTrace]) -> list[Insight]:
        insights = []
        comparative_traces = [t for t in traces if t.metadata.get("env_trace_id")]
        if len(comparative_traces) < 3:
            return insights

        # Aggregate disparity dimensions
        dimensions = defaultdict(list)
        for t in comparative_traces:
            for dim in ["action_divergence", "outcome_divergence", "latency_gap_ratio", "coverage_gap", "tool_usage_gap", "error_pattern_gap"]:
                if dim in t.metrics:
                    dimensions[dim].append(t.metrics[dim])

        for dim, values in dimensions.items():
            if len(values) < 3:
                continue
            mean_val = statistics.mean(values)
            if mean_val >= self.divergence_threshold:
                confidence = min(0.95, 0.6 + mean_val * 0.3)
                severity = "high" if mean_val > 0.6 else "medium"
                affected = [t.trace_id for t in comparative_traces if t.metrics.get(dim, 0) > self.divergence_threshold]

                recommendations = {
                    "action_divergence": "Add environment variants covering divergent action paths",
                    "outcome_divergence": "Environment does not replicate production outcomes — investigate task equivalence",
                    "latency_gap_ratio": "Adjust environment timing to match production latency profiles",
                    "coverage_gap": "Generate environment scenarios for missing production cases",
                    "tool_usage_gap": "Ensure environment exercises the same tool set as production",
                    "error_pattern_gap": "Add adversarial tests for production error patterns",
                }

                insights.append(Insight(
                    insight_id=self._make_id("disp", dim),
                    detector=self.name,
                    severity=severity,
                    confidence=confidence,
                    summary=f"Environment-prod gap in '{dim}': mean={mean_val:.2f} across {len(values)} comparisons",
                    affected_trace_ids=affected[:50],
                    pattern={
                        "dimension": dim,
                        "mean_value": mean_val,
                        "max_value": max(values),
                        "sample_count": len(values),
                        "threshold": self.divergence_threshold,
                    },
                    recommended_action=recommendations.get(dim, "Review environment fidelity"),
                    auto_created_dataset=f"ds_disparity_{dim[:30]}",
                ))

        # Find specific missing scenarios (coverage gap analysis)
        coverage_traces = [t for t in comparative_traces if t.metrics.get("coverage_gap", 0) > 0.2]
        if len(coverage_traces) >= 3:
            missing_scenarios = Counter()
            for t in coverage_traces:
                for span in t.spans:
                    if span.payload.get("missing_scenarios"):
                        for scenario in span.payload["missing_scenarios"]:
                            missing_scenarios[scenario] += 1

            top_missing = missing_scenarios.most_common(5)
            if top_missing:
                scenarios_text = "; ".join([f"{s} ({c}x)" for s, c in top_missing])
                insights.append(Insight(
                    insight_id=self._make_id("cov", scenarios_text[:40]),
                    detector=self.name,
                    severity="high",
                    confidence=0.85,
                    summary=f"Missing scenarios in environment: {scenarios_text}",
                    affected_trace_ids=[t.trace_id for t in coverage_traces][:50],
                    pattern={
                        "missing_scenarios": dict(top_missing),
                        "coverage_gap_mean": statistics.mean([t.metrics.get("coverage_gap", 0) for t in coverage_traces]),
                    },
                    recommended_action="Generate environment variants covering the top missing scenarios",
                    auto_created_dataset="ds_missing_scenarios",
                ))

        return insights


class RewardHackingDetector(BaseDetector):
    """Detects reward hacking signals in environment traces.

    Analyzes environment step spans for exploit indicators:
    - Reward concentration (single action dominating)
    - Loop detection with accumulating reward
    - Observation manipulation signals
    """

    def __init__(self, min_confidence: float = 0.75) -> None:
        super().__init__("reward_hacking", min_confidence)

    def analyze(self, traces: list[UnifiedTrace]) -> list[Insight]:
        insights = []

        for trace in traces:
            env_spans = [s for s in trace.spans if s.span_type == SpanType.ENV_STEP]
            if len(env_spans) < 3:
                continue

            rewards = [s.payload.get("reward", 0) for s in env_spans]
            actions = [str(s.payload.get("action", "")) for s in env_spans]

            # Reward concentration
            if rewards:
                total_reward = sum(abs(r) for r in rewards)
                if total_reward > 0:
                    max_reward = max(abs(r) for r in rewards)
                    concentration = max_reward / total_reward
                    if concentration > 0.7 and len(rewards) >= 5:
                        confidence = min(0.95, 0.6 + concentration * 0.3)
                        insights.append(Insight(
                            insight_id=self._make_id("rh", trace.trace_id, "concentration"),
                            detector=self.name,
                            severity="high",
                            confidence=confidence,
                            summary=f"Reward concentration: {concentration:.1%} from single step",
                            affected_trace_ids=[trace.trace_id],
                            pattern={
                                "type": "reward_concentration",
                                "concentration": concentration,
                                "max_reward": max_reward,
                                "total_reward": total_reward,
                                "step_count": len(env_spans),
                            },
                            recommended_action="Review reward shaping; consider sparse or shaped rewards",
                        ))

            # Loop with reward accumulation
            if len(actions) >= 6:
                for window_size in range(2, min(4, len(actions) // 2 + 1)):
                    pattern = tuple(actions[:window_size])
                    repeats = 0
                    loop_reward = 0.0
                    for i in range(0, len(actions) - window_size + 1, window_size):
                        if tuple(actions[i:i + window_size]) == pattern:
                            repeats += 1
                            loop_reward += sum(rewards[i:i + window_size])

                    if repeats >= 3 and loop_reward > 0:
                        confidence = min(0.95, 0.6 + repeats * 0.08)
                        insights.append(Insight(
                            insight_id=self._make_id("rh", trace.trace_id, "loop"),
                            detector=self.name,
                            severity="critical" if repeats >= 5 else "high",
                            confidence=confidence,
                            summary=f"Reward loop detected: {repeats} repeats of {pattern} with +{loop_reward:.1f} reward",
                            affected_trace_ids=[trace.trace_id],
                            pattern={
                                "type": "reward_loop",
                                "repeats": repeats,
                                "loop_pattern": list(pattern),
                                "loop_reward": loop_reward,
                            },
                            recommended_action="Add termination conditions or diversity bonuses to break loops",
                        ))
                        break

            # Step explosion without termination
            if len(env_spans) > 50:
                last_rewards = rewards[-10:]
                avg_last = sum(last_rewards) / len(last_rewards) if last_rewards else 0
                if avg_last > 0:
                    insights.append(Insight(
                        insight_id=self._make_id("rh", trace.trace_id, "explosion"),
                        detector=self.name,
                        severity="medium",
                        confidence=0.75,
                        summary=f"Step explosion: {len(env_spans)} steps without termination with positive reward",
                        affected_trace_ids=[trace.trace_id],
                        pattern={
                            "type": "step_explosion",
                            "step_count": len(env_spans),
                            "avg_recent_reward": avg_last,
                        },
                        recommended_action="Add max step limits or early termination conditions",
                    ))

        return insights


class NovelBehaviorDetector(BaseDetector):
    """Detects behaviors never seen before — potential emergent capabilities or bugs.

    Maintains a lightweight bounded in-memory behavior registry. In production,
    this would be backed by a persistent store (PostgreSQL / Redis).
    """

    def __init__(self, min_confidence: float = 0.7, max_behaviors: int = 10000) -> None:
        super().__init__("novel_behavior", min_confidence)
        self._seen_behaviors: BoundedSet[tuple[str, ...]] = BoundedSet(
            max_size=max_behaviors
        )
        self._seen_transitions: BoundedSet[str] = BoundedSet(
            max_size=max_behaviors
        )

    def analyze(self, traces: list[UnifiedTrace]) -> list[Insight]:
        insights = []

        for trace in traces:
            novel_behaviors = []

            # Check for novel tool combinations
            tool_sequence = tuple(
                s.payload.get("tool_name", "")
                for s in trace.spans
                if s.span_type == SpanType.TOOL_INVOCATION and s.payload.get("tool_name")
            )
            if tool_sequence and tool_sequence not in self._seen_behaviors:
                self._seen_behaviors.add(tool_sequence)
                novel_behaviors.append({
                    "type": "novel_tool_sequence",
                    "sequence": list(tool_sequence),
                    "length": len(tool_sequence),
                })

            # Check for novel state transitions
            state_transitions = []
            prev_state = None
            for span in trace.spans:
                if span.span_type == SpanType.ENV_STEP:
                    state = span.payload.get("state_snapshot", "")
                    if prev_state is not None and state != prev_state:
                        transition = f"{hash(prev_state) % 10000}->{hash(state) % 10000}"
                        state_transitions.append(transition)
                    prev_state = state

            unique_transitions = set(state_transitions)
            seen_set = self._seen_transitions.keys()
            new_transitions = unique_transitions - seen_set
            for trans in new_transitions:
                self._seen_transitions.add(trans)
                novel_behaviors.append({
                    "type": "novel_state_transition",
                    "transition": trans,
                })

            # Check for novel error types
            error_categories = set()
            for insight in trace.insights:
                cat = insight.get("category", "")
                if cat:
                    error_categories.add(cat)

            seen_set = self._seen_behaviors.keys()
            new_errors = error_categories - seen_set
            for err in new_errors:
                self._seen_behaviors.add(err)
                novel_behaviors.append({
                    "type": "novel_error_category",
                    "category": err,
                })

            if novel_behaviors:
                confidence = min(0.9, 0.6 + len(novel_behaviors) * 0.05)
                insights.append(Insight(
                    insight_id=self._make_id("nb", trace.trace_id),
                    detector=self.name,
                    severity="medium",
                    confidence=confidence,
                    summary=f"{len(novel_behaviors)} novel behavior(s) detected",
                    affected_trace_ids=[trace.trace_id],
                    pattern={
                        "novel_behaviors": novel_behaviors,
                        "total_seen_behaviors": len(self._seen_behaviors),
                    },
                    recommended_action="Review novel behaviors for emergent capabilities or edge cases; consider adding to test suite",
                    auto_created_dataset=f"ds_novel_{trace.trace_id[:8]}",
                ))

        return insights


class DetectorRegistry:
    """Registry for managing and running all detectors."""

    def __init__(self) -> None:
        self._detectors: dict[str, BaseDetector] = {
            "failure_pattern": FailurePatternDetector(),
            "performance_anomaly": PerformanceAnomalyDetector(),
            "regression": RegressionDetector(),
            "disparity": DisparityDetector(),
            "reward_hacking": RewardHackingDetector(),
            "novel_behavior": NovelBehaviorDetector(),
            # Phase 7.1b — bridges judge_scores rows to the Insights
            # surface. Added after the others so the registry's
            # iteration order (insertion order) puts the LLM-judge
            # bridge near the end of the run.
            "judge_scores_bridge": JudgeDetector(),
        }

    def register(self, name: str, detector: BaseDetector) -> None:
        self._detectors[name] = detector

    def get(self, name: str) -> BaseDetector | None:
        return self._detectors.get(name)

    def run_all(self, traces: list[UnifiedTrace]) -> list[Insight]:
        """Run all registered detectors and return combined insights."""
        all_insights = []
        for name, detector in self._detectors.items():
            try:
                insights = detector.analyze(traces)
                all_insights.extend(insights)
                logger.info(f"Detector '{name}' found {len(insights)} insights")
            except Exception as e:
                logger.warning(f"Detector '{name}' failed: {e}")
        return all_insights

    async def arun_all(self, traces: list[UnifiedTrace]) -> list[Insight]:
        """Async variant of :meth:`run_all`. Calls ``aanalyze`` on
        detectors that have it (e.g. ``JudgeDetector``), falling back
        to ``analyze`` for the rest. Use this from async callers —
        the FastAPI handler for ``run_detectors`` is one.
        """
        import asyncio

        all_insights: list[Insight] = []
        for name, detector in self._detectors.items():
            try:
                if hasattr(detector, "aanalyze") and callable(detector.aanalyze):
                    insights = await detector.aanalyze(traces)
                else:
                    # No async path — run sync, but don't block the
                    # event loop on long detectors. Detectors should
                    # be fast; if a particular detector is slow, the
                    # next phase adds per-detector `arun` overrides.
                    insights = await asyncio.to_thread(
                        detector.analyze, traces
                    )
                all_insights.extend(insights)
                logger.info(f"Detector '{name}' found {len(insights)} insights")
            except Exception as e:
                logger.warning(f"Detector '{name}' failed: {e}")
        return all_insights

    async def arun_selected(
        self,
        traces: list[UnifiedTrace],
        detector_names: list[str],
    ) -> list[Insight]:
        """Async variant of :meth:`run_selected`. Same async-vs-sync
        dispatch logic as :meth:`arun_all`."""
        import asyncio

        all_insights: list[Insight] = []
        for name in detector_names:
            detector = self._detectors.get(name)
            if detector is None:
                continue
            try:
                if hasattr(detector, "aanalyze") and callable(detector.aanalyze):
                    insights = await detector.aanalyze(traces)
                else:
                    insights = await asyncio.to_thread(
                        detector.analyze, traces
                    )
                all_insights.extend(insights)
            except Exception as e:
                logger.warning(f"Detector '{name}' failed: {e}")
        return all_insights

    def run_selected(
        self,
        traces: list[UnifiedTrace],
        detector_names: list[str],
    ) -> list[Insight]:
        all_insights = []
        for name in detector_names:
            detector = self._detectors.get(name)
            if detector:
                try:
                    insights = detector.analyze(traces)
                    all_insights.extend(insights)
                except Exception as e:
                    logger.warning(f"Detector '{name}' failed: {e}")
        return all_insights


# ─────────────────────────────────────────────────────────────────────────────
# Phase 7.1b — JudgeDetector: virtual detector that reads judge_scores
# ─────────────────────────────────────────────────────────────────────────────
#
# The judge infrastructure (src/eden/llmops/judges/) writes raw scores to
# the ``judge_scores`` table. To make those scores flow through the
# existing ``InsightsService`` → KB pipeline unchanged, this detector
# reads the table once and re-emits each row as an ``Insight`` with
# ``detector="judge.<judge_name>"`` and ``confidence=score``.
#
# The detector is virtual in the sense that it doesn't analyze
# traces — it bridges the judges table to the InsightsService
# surface. ``DetectorRegistry.run_all`` calls it like any other
# detector; the ``analyze`` method is sync but the DB read is sync too
# (PostgresClient.fetch is async — we run it via ``asyncio.run`` to
# keep the ``analyze`` contract sync without forcing a refactor).


class JudgeDetector(BaseDetector):
    """Bridges ``judge_scores`` rows to the InsightsService surface."""

    def __init__(self, min_confidence: float = 0.0, lookback_seconds: int = 3600) -> None:
        super().__init__("judge_scores_bridge", min_confidence)
        self.lookback_seconds = lookback_seconds

    def _rows_to_insights(self, rows: list[dict[str, Any]]) -> list[Insight]:
        """Build the Insight list for a batch of judge_scores rows.

        Shared by ``analyze`` (sync path) and ``aanalyze`` (async
        path) so the conversion logic isn't duplicated.
        """
        insights: list[Insight] = []
        for row in rows:
            score = row.get("score")
            if score is None:
                continue
            judge_name = row.get("judge_name") or "unknown"
            rationale = row.get("rationale") or ""
            severity = self._score_to_severity(score, judge_name)
            insights.append(
                Insight(
                    insight_id=self._make_id("judge", str(row.get("judge_run_id") or "")),
                    detector=f"judge.{judge_name}",
                    severity=severity,
                    confidence=float(score),
                    summary=rationale[:280] or f"judge {judge_name} score: {score:.2f}",
                    affected_trace_ids=[str(row.get("trace_id") or "")],
                    pattern={
                        "judge_name": judge_name,
                        "judge_version": row.get("judge_version"),
                        "model": row.get("model"),
                        "span_id": row.get("span_id"),
                    },
                    recommended_action=(
                        "Review the trace output and consider adjusting the prompt or model."
                        if severity in ("high", "critical") else ""
                    ),
                    auto_created_dataset=(
                        f"ds_judge_{judge_name}_lowscore"
                        if severity in ("high", "critical") else None
                    ),
                    metadata={
                        "judge_run_id": str(row.get("judge_run_id") or ""),
                        "judge_version": row.get("judge_version"),
                        "model": row.get("model"),
                        "scored_at": (
                            row.get("scored_at").isoformat()
                            if hasattr(row.get("scored_at"), "isoformat")
                            else str(row.get("scored_at"))
                        ),
                        "latency_ms": row.get("latency_ms"),
                    },
                )
            )
        return insights

    async def _fetch_recent_rows_async(self) -> list[dict[str, Any]]:
        """Async variant: read ``judge_scores`` rows in the lookback
        window. Use this from async callers (the InsightsService is
        called from an async FastAPI handler)."""
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        cutoff = datetime.now(UTC) - timedelta(seconds=self.lookback_seconds)
        rows = await client.fetch(
            """
            SELECT judge_run_id, judge_name, judge_version, trace_id, span_id,
                   score, rationale, model, scored_at, latency_ms
            FROM judge_scores
            WHERE scored_at >= $1
            ORDER BY scored_at DESC
            LIMIT 1000
            """,
            cutoff,
        )
        return [dict(r) for r in rows]

    def _fetch_recent_rows(self) -> list[dict[str, Any]]:
        """Sync wrapper around the async row fetch. Retained for
        backwards compat with callers that don't await.

        Note: this path uses ``asyncio.run`` and so cannot be called
        from inside an event loop. New code should use
        :meth:`_fetch_recent_rows_async` (and the detector's
        :meth:`aanalyze`) instead.
        """
        import asyncio

        try:
            asyncio.get_event_loop()
        except RuntimeError:
            return asyncio.run(self._fetch_recent_rows_async())

        # We're inside an event loop — fall back to the older
        # silent-skip behavior with a clearer debug message so the
        # call site can migrate to ``aanalyze``.
        logger.debug(
            "JudgeDetector._fetch_recent_rows called from async context — "
            "use aanalyze() instead to actually read the rows"
        )
        return []

    async def aanalyze(self, traces: list[UnifiedTrace]) -> list[Insight]:
        """Async equivalent of :meth:`analyze`. Reads the
        ``judge_scores`` table via ``await`` so it works correctly
        when called from an async FastAPI handler.

        The detector doesn't actually use the ``traces`` arg — it
        reads from the table directly so newly-written scores
        appear in the next detector run regardless of which
        UnifiedTrace batch happens to be loaded.
        """
        try:
            rows = await self._fetch_recent_rows_async()
        except Exception as exc:
            logger.warning(f"JudgeDetector async DB read failed: {exc}")
            return []
        return self._rows_to_insights(rows)

    def analyze(self, traces: list[UnifiedTrace]) -> list[Insight]:
        """Sync entry point retained for the BaseDetector contract.

        New callers should prefer :meth:`aanalyze` when running
        inside an async context. This method falls back to the
        silent-skip path when an event loop is already running —
        the deprecation message in :meth:`_fetch_recent_rows`
        points the caller at the right replacement.
        """
        try:
            rows = self._fetch_recent_rows()
        except Exception as exc:
            logger.warning(f"JudgeDetector DB read failed: {exc}")
            return []
        return self._rows_to_insights(rows)

    @staticmethod
    def _score_to_severity(score: float, judge_name: str) -> str:
        """Map a 0-1 score to a severity bucket. Different judges
        interpret low scores as different things — hallucination
        high-score = good, tone high-score = good. We treat all
        judges the same way: low score → critical, high → info.
        """
        if score < 0.3:
            return "critical"
        if score < 0.5:
            return "high"
        if score < 0.7:
            return "medium"
        if score < 0.9:
            return "low"
        return "info"
