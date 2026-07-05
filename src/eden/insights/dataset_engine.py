"""Dataset Generation Engine — auto-promote traces to structured, versioned datasets.

Phase 6.3: Every trace is a potential dataset entry.
"""

from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any
from uuid import uuid4

from eden.insights.unified_trace_model import Outcome, Realm, UnifiedTrace

logger = logging.getLogger(__name__)


class DatasetType(Enum):
    REGRESSION_SUITE = "regression_suite"
    EDGE_CASE_COLLECTION = "edge_case_collection"
    ADVERSARIAL_SUITE = "adversarial_suite"
    PERFORMANCE_BENCHMARK = "performance_benchmark"
    DISPARITY_COLLECTION = "disparity_collection"
    GOLDEN_PATH = "golden_path"


class AutoPromote(Enum):
    ALWAYS = "always"
    NEVER = "never"
    CONFIDENCE_THRESHOLD = "confidence_threshold"


@dataclass
class DatasetRule:
    """Rule defining which traces become dataset entries."""

    name: str
    description: str = ""
    # Filters
    realm: Realm | None = None
    outcome: Outcome | None = None
    min_confidence: float = 0.0
    tags_include: list[str] = field(default_factory=list)
    tags_exclude: list[str] = field(default_factory=list)
    custom_filter: Callable[[UnifiedTrace], bool] | None = None
    # Extraction
    extract_input: str = ""
    extract_expected: str = ""
    extract_metadata: dict[str, str] = field(default_factory=dict)
    # Target
    dataset_type: DatasetType = DatasetType.REGRESSION_SUITE
    dataset_name: str = ""
    auto_promote: AutoPromote = AutoPromote.CONFIDENCE_THRESHOLD
    confidence_threshold: float = 0.8

    def matches(self, trace: UnifiedTrace) -> bool:
        """Check if a trace matches this rule's filters."""
        if self.realm and trace.realm != self.realm:
            return False
        if self.outcome and trace.outcome != self.outcome:
            return False
        trace_tags = set(trace.tags)
        if self.tags_include and not all(t in trace_tags for t in self.tags_include):
            return False
        if self.tags_exclude and any(t in trace_tags for t in self.tags_exclude):
            return False
        return not (self.custom_filter and not self.custom_filter(trace))


@dataclass
class DatasetEntry:
    """A single entry in a dataset."""

    entry_id: str
    source_trace_id: str
    source_realm: str
    extracted_at: datetime
    extract_rule: str
    dataset_id: str
    input_data: dict[str, Any] = field(default_factory=dict)
    expected_data: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    lineage: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "entry_id": self.entry_id,
            "source_trace_id": self.source_trace_id,
            "source_realm": self.source_realm,
            "extracted_at": self.extracted_at.isoformat(),
            "extract_rule": self.extract_rule,
            "dataset_id": self.dataset_id,
            "input": self.input_data,
            "expected": self.expected_data,
            "metadata": self.metadata,
            "lineage": self.lineage,
        }


@dataclass
class Dataset:
    """A versioned dataset."""

    dataset_id: str
    name: str
    dataset_type: DatasetType
    version: str
    tenant_id: str
    project_id: str = "default"
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    entry_count: int = 0
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "name": self.name,
            "dataset_type": self.dataset_type.value,
            "version": self.version,
            "tenant_id": self.tenant_id,
            "project_id": self.project_id,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "entry_count": self.entry_count,
            "tags": self.tags,
            "metadata": self.metadata,
        }


class DatasetGenerationEngine:
    """Engine for generating datasets from traces with auto-promotion rules."""

    DEFAULT_RULES: list[DatasetRule] = [
        DatasetRule(
            name="production_failures",
            description="All production realm failures with high confidence",
            realm=Realm.PRODUCTION,
            outcome=Outcome.FAILURE,
            min_confidence=0.9,
            dataset_type=DatasetType.REGRESSION_SUITE,
            dataset_name="prod_failures",
            auto_promote=AutoPromote.ALWAYS,
        ),
        DatasetRule(
            name="env_prod_disparities",
            description="Comparative traces with high disparity scores",
            realm=Realm.COMPARATIVE,
            tags_include=["auto_generated"],
            custom_filter=lambda t: any(t.metrics.get(k, 0) > 0.6 for k in [
                "action_divergence", "outcome_divergence", "coverage_gap"
            ]),
            dataset_type=DatasetType.DISPARITY_COLLECTION,
            dataset_name="disparity_cases",
            auto_promote=AutoPromote.ALWAYS,
        ),
        DatasetRule(
            name="edge_cases",
            description="Rare states and boundary conditions",
            realm=Realm.ENVIRONMENT,
            tags_include=["rare_state", "edge_case"],
            dataset_type=DatasetType.EDGE_CASE_COLLECTION,
            dataset_name="edge_cases",
            auto_promote=AutoPromote.CONFIDENCE_THRESHOLD,
            confidence_threshold=0.8,
        ),
        DatasetRule(
            name="reward_hacking_cases",
            description="Detected reward hacking traces",
            realm=Realm.ENVIRONMENT,
            tags_include=["reward_hacking"],
            dataset_type=DatasetType.ADVERSARIAL_SUITE,
            dataset_name="adversarial_cases",
            auto_promote=AutoPromote.ALWAYS,
        ),
        DatasetRule(
            name="golden_paths",
            description="Successful production traces for few-shot examples",
            realm=Realm.PRODUCTION,
            outcome=Outcome.SUCCESS,
            tags_include=["golden"],
            dataset_type=DatasetType.GOLDEN_PATH,
            dataset_name="golden_paths",
            auto_promote=AutoPromote.CONFIDENCE_THRESHOLD,
            confidence_threshold=0.85,
        ),
        DatasetRule(
            name="performance_outliers",
            description="High-latency or token-heavy traces",
            realm=None,
            custom_filter=lambda t: t.duration_ms > 30000 or t.metrics.get("total_tokens", 0) > 8000,
            dataset_type=DatasetType.PERFORMANCE_BENCHMARK,
            dataset_name="performance_outliers",
            auto_promote=AutoPromote.NEVER,  # Require manual review
        ),
    ]

    def __init__(self, rules: list[DatasetRule] | None = None):
        self.rules = rules or list(self.DEFAULT_RULES)
        # In-memory stores — production would use PostgreSQL + S3
        self._datasets: dict[str, Dataset] = {}
        self._entries: dict[str, list[DatasetEntry]] = defaultdict(list)
        self._rule_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"matches": 0, "promoted": 0})

    def add_rule(self, rule: DatasetRule) -> None:
        self.rules.append(rule)

    def remove_rule(self, name: str) -> bool:
        original_len = len(self.rules)
        self.rules = [r for r in self.rules if r.name != name]
        return len(self.rules) < original_len

    def process_trace(self, trace: UnifiedTrace) -> list[DatasetEntry]:
        """Process a single trace against all rules and create entries."""
        created = []
        for rule in self.rules:
            if not rule.matches(trace):
                self._rule_stats[rule.name]["matches"] += 0  # no match
                continue

            self._rule_stats[rule.name]["matches"] += 1

            # Determine if we should auto-promote
            should_promote = False
            if rule.auto_promote == AutoPromote.ALWAYS:
                should_promote = True
            elif rule.auto_promote == AutoPromote.CONFIDENCE_THRESHOLD:
                # Use trace insights for confidence
                max_confidence = max(
                    (i.get("confidence", 0.5) for i in trace.insights),
                    default=0.5
                )
                should_promote = max_confidence >= rule.confidence_threshold
            elif rule.auto_promote == AutoPromote.NEVER:
                should_promote = False

            if not should_promote:
                if rule.auto_promote != AutoPromote.NEVER:
                    logger.debug(f"Rule '{rule.name}' matched but did not auto-promote trace {trace.trace_id}")
                continue

            entry = self._create_entry(trace, rule)
            if entry:
                self._store_entry(entry, rule)
                created.append(entry)
                self._rule_stats[rule.name]["promoted"] += 1

        return created

    def process_batch(self, traces: list[UnifiedTrace]) -> dict[str, list[DatasetEntry]]:
        """Process multiple traces and return entries grouped by dataset."""
        results: dict[str, list[DatasetEntry]] = defaultdict(list)
        for trace in traces:
            entries = self.process_trace(trace)
            for entry in entries:
                results[entry.dataset_id].append(entry)
        return dict(results)

    def _create_entry(self, trace: UnifiedTrace, rule: DatasetRule) -> DatasetEntry | None:
        """Extract data from trace according to rule."""
        try:
            dataset_id = f"ds_{rule.dataset_name}_{trace.tenant_id}"[:64]

            # Build input data from trace
            input_data = self._extract_input(trace, rule)

            # Build expected data
            expected_data = self._extract_expected(trace, rule)

            # Build lineage
            lineage = [
                f"{trace.trace_id} ({trace.realm.value}, {trace.started_at.isoformat() if trace.started_at else 'unknown'})",
                f"→ extracted by rule '{rule.name}'",
                f"→ added to dataset '{rule.dataset_name}'",
            ]

            return DatasetEntry(
                entry_id=f"entry_{str(uuid4())[:16]}",
                source_trace_id=trace.trace_id,
                source_realm=trace.realm.value,
                extracted_at=datetime.now(UTC),
                extract_rule=rule.name,
                dataset_id=dataset_id,
                input_data=input_data,
                expected_data=expected_data,
                metadata={
                    "agent_id": trace.agent_id,
                    "agent_version": trace.agent_version,
                    "environment_id": trace.environment_id,
                    "outcome": trace.outcome.value,
                    "tags": trace.tags,
                    "rule_description": rule.description,
                },
                lineage=lineage,
            )
        except Exception as e:
            logger.warning(f"Failed to create dataset entry for trace {trace.trace_id}: {e}")
            return None

    def _extract_input(self, trace: UnifiedTrace, rule: DatasetRule) -> dict[str, Any]:
        """Extract input data from trace."""
        input_data: dict[str, Any] = {}

        # Extract from first LLM span or env step
        llm_spans = [s for s in trace.spans if s.span_type.value == "llm.completion"]
        if llm_spans:
            first_llm = llm_spans[0]
            messages = first_llm.payload.get("messages", [])
            input_data["prompt"] = messages
            input_data["model"] = first_llm.payload.get("model", "")

        # Extract from env steps
        env_spans = [s for s in trace.spans if s.span_type.value == "env.step"]
        if env_spans:
            first_step = env_spans[0]
            input_data["observation"] = first_step.payload.get("observation", "")
            input_data["initial_state"] = first_step.payload.get("state_snapshot", "")

        # Add trace metadata
        input_data["trace_id"] = trace.trace_id
        input_data["agent_id"] = trace.agent_id
        input_data["task_description"] = trace.metadata.get("task_description", "")

        return input_data

    def _extract_expected(self, trace: UnifiedTrace, rule: DatasetRule) -> dict[str, Any]:
        """Extract expected/correct data from trace."""
        expected: dict[str, Any] = {}

        if trace.outcome == Outcome.SUCCESS:
            # For successful traces, extract the final outcome as expected
            env_spans = [s for s in trace.spans if s.span_type.value == "env.step"]
            if env_spans:
                last_step = env_spans[-1]
                expected["final_action"] = last_step.payload.get("action", "")
                expected["final_reward"] = last_step.payload.get("reward", 0)
                expected["terminated"] = last_step.payload.get("terminated", False)
        else:
            # For failures, extract error information
            expected["error_category"] = trace.insights[0].get("category", "unknown") if trace.insights else "unknown"
            expected["expected_outcome"] = "success"
            expected["actual_outcome"] = trace.outcome.value

        # Include tool results as expected outputs
        tool_spans = [s for s in trace.spans if s.span_type.value == "tool.invoke"]
        if tool_spans:
            expected["tool_results"] = [
                {
                    "tool_name": s.payload.get("tool_name", ""),
                    "success": s.payload.get("success", True),
                    "result": s.payload.get("result", {}),
                }
                for s in tool_spans
            ]

        return expected

    def _store_entry(self, entry: DatasetEntry, rule: DatasetRule) -> None:
        """Store entry in the appropriate dataset."""
        dataset_id = entry.dataset_id

        # Create dataset if it doesn't exist
        if dataset_id not in self._datasets:
            self._datasets[dataset_id] = Dataset(
                dataset_id=dataset_id,
                name=rule.dataset_name,
                dataset_type=rule.dataset_type,
                version=self._generate_version(),
                tenant_id=entry.metadata.get("tenant_id", "unknown"),
                tags=[rule.dataset_type.value],
            )

        self._entries[dataset_id].append(entry)
        self._datasets[dataset_id].entry_count = len(self._entries[dataset_id])
        self._datasets[dataset_id].updated_at = datetime.now(UTC)

    def _generate_version(self) -> str:
        """Generate a version string."""
        now = datetime.now(UTC)
        return f"{now.strftime('%Y.%m.%d-%H%M%S')}"

    def get_dataset(self, dataset_id: str) -> Dataset | None:
        return self._datasets.get(dataset_id)

    def list_datasets(self, tenant_id: str) -> list[Dataset]:
        return [d for d in self._datasets.values() if d.tenant_id == tenant_id]

    def get_entries(self, dataset_id: str, limit: int = 1000, offset: int = 0) -> list[DatasetEntry]:
        entries = self._entries.get(dataset_id, [])
        return entries[offset:offset + limit]

    def export_dataset(
        self,
        dataset_id: str,
        format_type: str = "jsonl",
        split_ratio: tuple[float, float] | None = None,
    ) -> dict[str, Any]:
        """Export a dataset to a portable format."""
        dataset = self._datasets.get(dataset_id)
        if not dataset:
            raise ValueError(f"Dataset not found: {dataset_id}")

        entries = self._entries.get(dataset_id, [])
        data = [e.to_dict() for e in entries]

        result = {
            "dataset_id": dataset_id,
            "name": dataset.name,
            "format": format_type,
            "total_entries": len(data),
            "version": dataset.version,
        }

        if format_type == "jsonl":
            lines = [json.dumps(e, default=str) for e in data]
            result["data"] = "\n".join(lines)
        elif format_type == "json":
            result["data"] = json.dumps(data, indent=2, default=str)
        elif format_type == "csv":
            # Simplified CSV export
            if data:
                import csv
                import io
                output = io.StringIO()
                # Flatten nested dicts for CSV
                flat_data = []
                for entry in data:
                    flat = {
                        "entry_id": entry.get("entry_id", ""),
                        "source_trace_id": entry.get("source_trace_id", ""),
                        "extract_rule": entry.get("extract_rule", ""),
                        "input": json.dumps(entry.get("input", {})),
                        "expected": json.dumps(entry.get("expected", {})),
                    }
                    flat_data.append(flat)
                writer = csv.DictWriter(output, fieldnames=flat_data[0].keys())
                writer.writeheader()
                writer.writerows(flat_data)
                result["data"] = output.getvalue()
            else:
                result["data"] = ""
        elif format_type == "openai-eval":
            # OpenAI eval format
            openai_data = []
            for entry in data:
                openai_data.append({
                    "input": entry.get("input", {}),
                    "ideal": entry.get("expected", {}),
                    "metadata": entry.get("metadata", {}),
                })
            result["data"] = json.dumps(openai_data, indent=2, default=str)

        if split_ratio and data:
            split_point = int(len(data) * split_ratio[0] / (split_ratio[0] + split_ratio[1]))
            result["train"] = data[:split_point]
            result["test"] = data[split_point:]
            result["train_count"] = len(result["train"])
            result["test_count"] = len(result["test"])

        return result

    def get_stats(self) -> dict[str, Any]:
        """Return engine statistics."""
        return {
            "total_datasets": len(self._datasets),
            "total_entries": sum(len(e) for e in self._entries.values()),
            "rules": {
                name: dict(stats)
                for name, stats in self._rule_stats.items()
            },
            "datasets_by_type": dict(
                Counter(d.dataset_type.value for d in self._datasets.values())
            ),
        }


