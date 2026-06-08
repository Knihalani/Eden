"""Auto-dataset module — automatically promote high-quality production traces to golden datasets.

Monitors production traces, scores them for quality, and promotes the best
cases into golden datasets for CI/CD evaluation. Acts as a feedback loop
between production and evaluation.

Security & Privacy Notes:
  - Production traces may contain sensitive data (prompts, outputs, PII).
  - This module does NOT scrub PII automatically — traces should be masked
    upstream (e.g. via eden.data_platform.pii.PIIMasker) before promotion.
  - Review and freeze auto-generated datasets before using them in CI.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from eden.evaluation.golden_dataset import (
    GoldenCase,
    GoldenDataset,
    DatasetRegistry,
    EnvironmentCategory,
    DifficultyLevel,
)

logger = logging.getLogger(__name__)


@dataclass
class TraceQualityScore:
    """Quality score for a production trace.

    Attributes:
        trace_id: Original trace identifier.
        overall_score: Composite quality score (0.0-1.0).
        correctness_score: Did the environment produce correct output?
        robustness_score: Did it handle edge cases?
        efficiency_score: Was resource usage reasonable?
        diversity_score: Is this trace meaningfully different from existing cases?
        coverage_delta: Increase in category coverage this trace provides.
    """

    trace_id: str
    overall_score: float = 0.0
    correctness_score: float = 0.0
    robustness_score: float = 0.0
    efficiency_score: float = 0.0
    diversity_score: float = 0.0
    coverage_delta: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "overall_score": round(self.overall_score, 4),
            "correctness_score": round(self.correctness_score, 4),
            "robustness_score": round(self.robustness_score, 4),
            "efficiency_score": round(self.efficiency_score, 4),
            "diversity_score": round(self.diversity_score, 4),
            "coverage_delta": round(self.coverage_delta, 4),
            "metadata": self.metadata,
        }


class TraceQualityScorer:
    """Scores production traces for golden dataset candidacy.

    Uses a multi-factor scoring model:
      - Correctness: output matches expected behavior
      - Robustness: handles variations and edge cases
      - Efficiency: reasonable token usage and latency
      - Diversity: adds coverage not already in the dataset
    """

    WEIGHT_CORRECTNESS = 0.40
    WEIGHT_ROBUSTNESS = 0.25
    WEIGHT_EFFICIENCY = 0.15
    WEIGHT_DIVERSITY = 0.20

    MIN_SCORE_FOR_PROMOTION = 0.80

    def score(
        self,
        trace: dict[str, Any],
        existing_cases: list[GoldenCase],
    ) -> TraceQualityScore:
        """Score a production trace for promotion candidacy.

        Args:
            trace: Production trace data.
            existing_cases: Current golden cases to compare against.

        Returns:
            TraceQualityScore with composite score.
        """
        trace_id = trace.get("trace_id", str(uuid.uuid4()))

        # Extract metrics from trace
        metrics = trace.get("metrics", {})
        test_results = trace.get("test_results", {})
        environment_type = trace.get("environment_type", "unknown")

        # Correctness: based on test pass rate
        passed = test_results.get("passed", 0)
        total = test_results.get("total", 1)
        correctness = passed / max(total, 1)

        # Robustness: based on edge case handling
        edge_cases = test_results.get("edge_cases", {})
        edge_passed = sum(1 for v in edge_cases.values() if v)
        edge_total = max(len(edge_cases), 1)
        robustness = edge_passed / edge_total

        # Efficiency: inverse of normalized resource usage
        tokens_used = metrics.get("tokens_used", 0)
        max_tokens = metrics.get("max_tokens", 1)
        efficiency = 1.0 - min(tokens_used / max(max_tokens, 1), 1.0)

        # Diversity: semantic distance from nearest existing case
        diversity = self._compute_diversity(trace, existing_cases)

        # Coverage delta: new category/tag coverage
        coverage_delta = self._compute_coverage_delta(trace, existing_cases)

        # Composite score
        overall = (
            correctness * self.WEIGHT_CORRECTNESS +
            robustness * self.WEIGHT_ROBUSTNESS +
            efficiency * self.WEIGHT_EFFICIENCY +
            diversity * self.WEIGHT_DIVERSITY
        )

        return TraceQualityScore(
            trace_id=trace_id,
            overall_score=overall,
            correctness_score=correctness,
            robustness_score=robustness,
            efficiency_score=efficiency,
            diversity_score=diversity,
            coverage_delta=coverage_delta,
            metadata={
                "environment_type": environment_type,
                "tokens_used": tokens_used,
                "test_passed": passed,
                "test_total": total,
            },
        )

    def _compute_diversity(
        self,
        trace: dict[str, Any],
        existing_cases: list[GoldenCase],
    ) -> float:
        """Compute semantic diversity from existing cases.

        Returns 1.0 if very different from all existing cases,
        0.0 if identical to an existing case.
        """
        if not existing_cases:
            return 1.0

        trace_desc = trace.get("description", "")
        trace_tags = set(trace.get("tags", []))

        max_similarity = 0.0
        for case in existing_cases:
            # Tag overlap similarity
            case_tags = set(case.tags)
            tag_union = trace_tags | case_tags
            tag_intersection = trace_tags & case_tags
            tag_sim = len(tag_intersection) / max(len(tag_union), 1)

            # Description similarity (simplified: word overlap)
            trace_words = set(trace_desc.lower().split())
            case_words = set(case.description.lower().split())
            word_union = trace_words | case_words
            word_intersection = trace_words & case_words
            word_sim = len(word_intersection) / max(len(word_union), 1)

            similarity = (tag_sim + word_sim) / 2
            max_similarity = max(max_similarity, similarity)

        # Diversity is inverse of max similarity
        return 1.0 - max_similarity

    def _compute_coverage_delta(
        self,
        trace: dict[str, Any],
        existing_cases: list[GoldenCase],
    ) -> float:
        """Compute how much new category/tag coverage this trace adds."""
        trace_tags = set(trace.get("tags", []))
        existing_tags: set[str] = set()
        for case in existing_cases:
            existing_tags.update(case.tags)

        new_tags = trace_tags - existing_tags
        if not new_tags:
            return 0.0
        return len(new_tags) / max(len(trace_tags), 1)

    def should_promote(self, score: TraceQualityScore) -> bool:
        """Determine if a trace should be promoted to golden dataset."""
        return score.overall_score >= self.MIN_SCORE_FOR_PROMOTION


class AutoDatasetPromoter:
    """Automatically promotes high-quality production traces to golden datasets.

    Workflow:
        1. Collect production traces from completed jobs
        2. Score each trace for quality
        3. Filter traces above promotion threshold
    4. Generate golden cases from promoted traces
        5. Add cases to a candidate golden dataset
        6. Freeze dataset after review period
    """

    def __init__(
        self,
        scorer: Optional[TraceQualityScorer] = None,
        registry: Optional[DatasetRegistry] = None,
        state_dir: Optional[Path] = None,
        promotion_threshold: float = 0.80,
    ):
        """Initialize auto-dataset promoter.

        Args:
            scorer: TraceQualityScorer instance.
            registry: DatasetRegistry for managing datasets.
            state_dir: Directory for persisting promotion state.
            promotion_threshold: Minimum score for promotion.
        """
        self._scorer = scorer or TraceQualityScorer()
        self._registry = registry or DatasetRegistry()
        self._state_dir = state_dir or Path("./.eden/auto_datasets")
        self._state_dir.mkdir(parents=True, exist_ok=True)
        self._promotion_threshold = promotion_threshold

    async def process_traces(
        self,
        traces: list[dict[str, Any]],
        target_dataset_id: str = "gd_auto_production",
        category: Optional[EnvironmentCategory] = None,
    ) -> dict[str, Any]:
        """Process a batch of production traces and promote high-quality ones.

        IMPORTANT: Traces passed here are assumed to have already undergone
        PII scrubbing upstream. This method does NOT perform PII masking.
        Ensure eden.data_platform.pii.PIIMasker (or equivalent) has been
        applied before calling this function.
        """
        """Process a batch of production traces and promote high-quality ones.

        Args:
            traces: List of production trace dictionaries.
            target_dataset_id: Dataset ID for auto-promoted cases.
            category: Default category for promoted cases.

        Returns:
            Summary dict with promotion results.
        """
        logger.info(f"Processing {len(traces)} traces for auto-promotion")

        # Get existing cases for diversity scoring
        existing_dataset = self._registry.get(target_dataset_id)
        existing_cases = existing_dataset.cases if existing_dataset else []

        # Score all traces
        scores: list[TraceQualityScore] = []
        for trace in traces:
            try:
                score = self._scorer.score(trace, existing_cases)
                scores.append(score)
            except Exception as e:
                logger.warning(f"Failed to score trace {trace.get('trace_id', '?')}: {e}")

        # Filter for promotion
        promoted = [s for s in scores if s.overall_score >= self._promotion_threshold]
        rejected = [s for s in scores if s.overall_score < self._promotion_threshold]

        logger.info(f"Promoted {len(promoted)} / {len(scores)} traces")

        # Convert promoted traces to golden cases
        new_cases: list[GoldenCase] = []
        for score in promoted:
            trace = next(
                (t for t in traces if t.get("trace_id") == score.trace_id), {}
            )
            case = self._trace_to_golden_case(trace, score, category)
            if case:
                new_cases.append(case)

        # Update or create dataset
        if existing_dataset:
            # Merge new cases into existing dataset
            all_cases = existing_cases + new_cases
            updated = GoldenDataset(
                dataset_id=existing_dataset.dataset_id,
                version=self._bump_version(existing_dataset.version),
                frozen_at=datetime.now(timezone.utc).isoformat(),
                description=existing_dataset.description,
                cases=all_cases,
                overall_pass_criteria=existing_dataset.overall_pass_criteria,
                baseline_version=existing_dataset.version,
                generation_config={
                    **existing_dataset.generation_config,
                    "auto_promoted_count": len(new_cases),
                    "last_promotion": datetime.now(timezone.utc).isoformat(),
                },
            )
            self._registry.register(updated, is_draft=True)
        else:
            # Create new auto-dataset
            new_dataset = GoldenDataset(
                dataset_id=target_dataset_id,
                version="1.0.0",
                frozen_at=datetime.now(timezone.utc).isoformat(),
                description="Auto-promoted golden dataset from production traces",
                cases=new_cases,
                overall_pass_criteria={
                    "min_overall_success_rate": 0.80,
                    "min_category_success_rate": 0.75,
                },
                generation_config={
                    "source": "auto_promotion",
                    "auto_promoted_count": len(new_cases),
                    "created_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            self._registry.register(new_dataset, is_draft=True)

        # Persist state
        self._persist_state(target_dataset_id, {
            "processed": len(traces),
            "promoted": len(promoted),
            "rejected": len(rejected),
            "new_cases": len(new_cases),
            "scores": [s.to_dict() for s in scores],
        })

        return {
            "processed": len(traces),
            "promoted": len(promoted),
            "rejected": len(rejected),
            "new_cases_added": len(new_cases),
            "dataset_id": target_dataset_id,
            "dataset_version": self._registry.get(target_dataset_id).version if self._registry.get(target_dataset_id) else "1.0.0",
            "promotion_threshold": self._promotion_threshold,
        }

    def _trace_to_golden_case(
        self,
        trace: dict[str, Any],
        score: TraceQualityScore,
        default_category: Optional[EnvironmentCategory] = None,
    ) -> Optional[GoldenCase]:
        """Convert a production trace to a golden case."""
        trace_id = trace.get("trace_id") or str(uuid.uuid4())
        description = trace.get("description", "Auto-promoted production trace")
        environment_type = trace.get("environment_type", "custom")

        # Map environment type to category
        category_map = {
            "agent_sandbox": EnvironmentCategory.AGENT_SANDBOX,
            "llm_agent_eval": EnvironmentCategory.LLM_AGENT_EVAL,
            "tool_use": EnvironmentCategory.TOOL_USE,
            "multi_agent": EnvironmentCategory.MULTI_AGENT,
            "adversarial": EnvironmentCategory.ADVERSARIAL,
            "simulation": EnvironmentCategory.SIMULATION,
        }
        category = category_map.get(environment_type, default_category or EnvironmentCategory.CUSTOM)

        # Determine difficulty from complexity metrics
        complexity = trace.get("complexity_metrics", {})
        step_count = complexity.get("max_steps", 10)
        if step_count <= 5:
            difficulty = DifficultyLevel.BEGINNER
        elif step_count <= 15:
            difficulty = DifficultyLevel.INTERMEDIATE
        elif step_count <= 30:
            difficulty = DifficultyLevel.ADVANCED
        else:
            difficulty = DifficultyLevel.EXPERT

        # Build input spec from trace
        input_spec = trace.get("input_spec", {})
        if not input_spec:
            input_spec = {
                "description": description,
                "environment_type": environment_type,
            }

        # Build expected behavior from test results
        test_results = trace.get("test_results", {})
        expected_behavior = {
            "passes_tests": test_results.get("passed", 0) > 0,
            "test_count": test_results.get("total", 0),
        }

        # Pass criteria from score
        pass_criteria = {
            "min_success_rate": score.correctness_score,
            "quality_threshold": score.overall_score,
        }

        case_id = f"auto_{trace_id[:8]}" if len(trace_id) >= 8 else f"auto_{trace_id}_{uuid.uuid4().hex[:6]}"
        return GoldenCase(
            case_id=case_id,
            category=category,
            difficulty=difficulty,
            description=description,
            input_spec=input_spec,
            expected_behavior=expected_behavior,
            pass_criteria=pass_criteria,
            tags=trace.get("tags", ["auto-promoted", environment_type]),
            rationale=f"Auto-promoted from production trace {trace_id} with quality score {score.overall_score:.3f}",
        )

    def _bump_version(self, version: str) -> str:
        """Bump patch version number."""
        parts = version.split(".")
        if len(parts) >= 3:
            try:
                parts[2] = str(int(parts[2]) + 1)
                return ".".join(parts)
            except ValueError:
                pass
        return f"{version}.1"

    def _persist_state(self, dataset_id: str, state: dict[str, Any]) -> None:
        """Persist promotion state to disk."""
        path = self._state_dir / f"{dataset_id}_promotion.json"
        path.write_text(json.dumps(state, indent=2, default=str), encoding="utf-8")

    def load_state(self, dataset_id: str) -> Optional[dict[str, Any]]:
        """Load promotion state from disk."""
        path = self._state_dir / f"{dataset_id}_promotion.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    async def review_and_freeze(
        self,
        dataset_id: str,
        approved: bool = True,
    ) -> Optional[GoldenDataset]:
        """Review an auto-generated dataset and freeze it.

        Args:
            dataset_id: Dataset to review.
            approved: Whether to approve and freeze.

        Returns:
            Frozen GoldenDataset if approved, None otherwise.
        """
        dataset = self._registry.get(dataset_id)
        if not dataset:
            logger.warning(f"Dataset {dataset_id} not found for review")
            return None

        if approved:
            frozen = self._registry.freeze(dataset_id, dataset.version)
            logger.info(f"Frozen auto-dataset {dataset_id}@{dataset.version}")
            return frozen
        else:
            logger.info(f"Auto-dataset {dataset_id} rejected, keeping as draft")
            return None
