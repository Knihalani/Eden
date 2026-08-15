"""Dataset Generation Engine — auto-promote traces to structured, versioned datasets.

Phase 6.3: Every trace is a potential dataset entry.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
from collections import Counter, defaultdict
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any, TypeVar
from uuid import uuid4

from eden.datasets.hub import DatasetHub, DatasetRecord
from eden.insights.unified_trace_model import Outcome, Realm, UnifiedTrace

logger = logging.getLogger(__name__)

_T = TypeVar("_T")


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
            custom_filter=lambda t: any(
                t.metrics.get(k, 0) > 0.6
                for k in ["action_divergence", "outcome_divergence", "coverage_gap"]
            ),
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
            custom_filter=lambda t: (
                t.duration_ms > 30000 or t.metrics.get("total_tokens", 0) > 8000
            ),
            dataset_type=DatasetType.PERFORMANCE_BENCHMARK,
            dataset_name="performance_outliers",
            auto_promote=AutoPromote.NEVER,  # Require manual review
        ),
    ]

    def __init__(self, rules: list[DatasetRule] | None = None, hub: DatasetHub | None = None):
        self.rules = rules or list(self.DEFAULT_RULES)
        # FEAT-75: durability fix. Generated datasets/entries used to live
        # only in ``self._datasets`` / ``self._entries`` in-memory dicts,
        # so every promoted trace vanished on process restart despite being
        # API-reachable. ``DatasetHub`` (backed by the ``datasets`` /
        # ``dataset_items`` Postgres tables) is now the single source of
        # truth: writes go straight to it (``_persist_entry``) and reads
        # (``get_dataset``, ``list_datasets``, ``get_entries``, ...) query
        # it directly rather than a local cache. No rehydration step is
        # needed on startup — a fresh engine instance backed by the same
        # ``DatasetHub``/database already sees everything, since the engine
        # itself carries no durable state.
        self._hub = hub or DatasetHub()
        # Everything below is a process-local *derived* cache, not a store
        # of record — it only exists to serve the handful of pre-existing,
        # tenant-less call sites (``get_stats``, and ``Dataset.dataset_type``
        # which DatasetHub's schema has no column for) with reasonable
        # answers. Losing it on restart costs nothing but a little
        # bookkeeping accuracy, never dataset content.
        self._rule_stats: dict[str, dict[str, int]] = defaultdict(
            lambda: {"matches": 0, "promoted": 0}
        )
        self._known_dataset_types: dict[str, DatasetType] = {}
        self._known_entry_counts: dict[str, int] = defaultdict(int)

    @staticmethod
    def _run(coro: Coroutine[Any, Any, _T]) -> _T:
        """Bridge a DatasetHub async call into this engine's sync interface.

        The engine's public methods (``process_trace``, ``get_dataset``, ...)
        stay synchronous on purpose so ``InsightsService`` /
        ``api/routes/insights.py`` — which call them without ``await`` —
        don't need to change. DatasetHub's persistence methods are async
        (they talk to Postgres via an async client), so we run them to
        completion here:
          - No event loop running in this thread → just run it directly.
          - Called from inside a running loop (e.g. a FastAPI async handler
            invoking a service method without ``await``) → run the coroutine
            on a dedicated worker thread with its own loop so we don't try
            to nest event loops.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(coro)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, coro).result()

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
                    (i.get("confidence", 0.5) for i in trace.insights), default=0.5
                )
                should_promote = max_confidence >= rule.confidence_threshold
            elif rule.auto_promote == AutoPromote.NEVER:
                should_promote = False

            if not should_promote:
                if rule.auto_promote != AutoPromote.NEVER:
                    logger.debug(
                        f"Rule '{rule.name}' matched but did not auto-promote trace {trace.trace_id}"
                    )
                continue

            entry = self._create_entry(trace, rule)
            if entry:
                self._store_entry(trace, entry, rule)
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
            expected["error_category"] = (
                trace.insights[0].get("category", "unknown") if trace.insights else "unknown"
            )
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

    def _store_entry(self, trace: UnifiedTrace, entry: DatasetEntry, rule: DatasetRule) -> None:
        """Persist entry (and its dataset, if new) via DatasetHub.

        ``entry.dataset_id`` was set to a placeholder in ``_create_entry``;
        it gets overwritten below with DatasetHub's real (UUID) id once the
        row actually exists, so callers grouping by ``entry.dataset_id``
        (e.g. ``process_batch``) key on the durable id.
        """
        record = self._run(self._persist_entry(trace.tenant_id, entry, rule))
        entry.dataset_id = record.id
        self._known_dataset_types[record.id] = rule.dataset_type
        self._known_entry_counts[record.id] += 1

    async def _persist_entry(
        self, org_id: str, entry: DatasetEntry, rule: DatasetRule
    ) -> DatasetRecord:
        """Find-or-create the dataset for ``rule``, then append the item.

        ``datasets`` has a ``UNIQUE (org_id, name)`` constraint, so we mirror
        ``DatasetHub.promote_trace``'s own find-by-name-before-create pattern
        rather than blindly calling ``create_dataset`` every time.
        """
        existing = await self._hub.list_datasets(org_id)
        match = next((d for d in existing if d.name == rule.dataset_name), None)
        if match is None:
            match = await self._hub.create_dataset(
                org_id,
                name=rule.dataset_name,
                description=rule.description,
                source_type="auto_generated",
                source_ref=rule.name,
            )
        await self._hub.add_dataset_item(
            match.id,
            input_data=json.dumps(entry.input_data, default=str),
            expected_output=json.dumps(entry.expected_data, default=str),
            payload=entry.to_dict(),
            origin_trace_id=entry.source_trace_id,
        )
        # Re-fetch so row_count reflects the item we just added.
        refreshed = await self._hub.get_dataset(org_id, match.id)
        return refreshed or match

    def _to_dataset(self, record: DatasetRecord) -> Dataset:
        """Translate a DatasetHub ``DatasetRecord`` into this module's
        ``Dataset`` shape (what ``InsightsService`` / the API routes expect).

        DatasetHub's schema has no ``dataset_type`` column, so it's
        recovered from ``source_ref`` (the rule name we stored it under) by
        matching against ``self.rules``, falling back to this process's
        write-time cache, then a safe default — best-effort, same spirit as
        the other process-local caches on this class.
        """
        rule = next((r for r in self.rules if r.name == record.source_ref), None)
        dataset_type = (
            rule.dataset_type
            if rule is not None
            else self._known_dataset_types.get(record.id, DatasetType.REGRESSION_SUITE)
        )
        return Dataset(
            dataset_id=record.id,
            name=record.name,
            dataset_type=dataset_type,
            version=str(record.version),
            tenant_id=record.org_id,
            created_at=self._parse_ts(record.created_at),
            updated_at=self._parse_ts(record.updated_at),
            entry_count=record.row_count,
            tags=[dataset_type.value],
        )

    @staticmethod
    def _parse_ts(value: str) -> datetime:
        if value:
            try:
                return datetime.fromisoformat(value)
            except ValueError:
                pass
        return datetime.now(UTC)

    @staticmethod
    def _entry_from_row(row: dict[str, Any]) -> DatasetEntry:
        """Reconstruct a ``DatasetEntry`` from a persisted ``dataset_items``
        row. The full entry (including lineage/metadata) was stored in
        ``payload`` at write time via ``entry.to_dict()``."""
        payload = row.get("payload") or {}
        if isinstance(payload, str):
            payload = json.loads(payload)
        extracted_at_raw = payload.get("extracted_at")
        extracted_at = None
        if extracted_at_raw:
            try:
                extracted_at = datetime.fromisoformat(extracted_at_raw)
            except ValueError:
                extracted_at = None
        return DatasetEntry(
            entry_id=payload.get("entry_id") or str(row.get("id", "")),
            source_trace_id=payload.get("source_trace_id") or row.get("origin_trace_id") or "",
            source_realm=payload.get("source_realm", ""),
            extracted_at=extracted_at or datetime.now(UTC),
            extract_rule=payload.get("extract_rule", ""),
            dataset_id=payload.get("dataset_id") or str(row.get("dataset_id", "")),
            input_data=payload.get("input", {}),
            expected_data=payload.get("expected", {}),
            metadata=payload.get("metadata", {}),
            lineage=payload.get("lineage", []),
        )

    def get_dataset(self, dataset_id: str) -> Dataset | None:
        record = self._run(self._hub.get_dataset_by_id(dataset_id))
        return self._to_dataset(record) if record else None

    def list_datasets(self, tenant_id: str) -> list[Dataset]:
        records = self._run(self._hub.list_datasets(tenant_id))
        return [self._to_dataset(r) for r in records]

    def get_entries(
        self, dataset_id: str, limit: int = 1000, offset: int = 0
    ) -> list[DatasetEntry]:
        rows = self._run(self._hub.list_dataset_items(dataset_id, limit=limit, offset=offset))
        return [self._entry_from_row(r) for r in rows]

    def export_dataset(
        self,
        dataset_id: str,
        format_type: str = "jsonl",
        split_ratio: tuple[float, float] | None = None,
    ) -> dict[str, Any]:
        """Export a dataset to a portable format."""
        dataset = self.get_dataset(dataset_id)
        if not dataset:
            raise ValueError(f"Dataset not found: {dataset_id}")

        entries = self.get_entries(dataset_id, limit=1_000_000)
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
                openai_data.append(
                    {
                        "input": entry.get("input", {}),
                        "ideal": entry.get("expected", {}),
                        "metadata": entry.get("metadata", {}),
                    }
                )
            result["data"] = json.dumps(openai_data, indent=2, default=str)

        if split_ratio and data:
            split_point = int(len(data) * split_ratio[0] / (split_ratio[0] + split_ratio[1]))
            result["train"] = data[:split_point]
            result["test"] = data[split_point:]
            result["train_count"] = len(result["train"])
            result["test_count"] = len(result["test"])

        return result

    def get_stats(self) -> dict[str, Any]:
        """Return engine statistics.

        This endpoint has no tenant/org argument (matching its pre-existing
        signature), while DatasetHub is org-scoped — a true global count
        would mean enumerating every org. ``total_datasets``/`total_entries``/
        ``datasets_by_type`` are therefore process-local tallies of what
        *this* engine instance has written since it started (same caveat the
        original in-memory implementation effectively had once a process
        restarted, just now scoped to "this process" instead of "ever").
        Dataset/entry *content* itself is never at risk — that always lives
        in DatasetHub and is read fresh via ``get_dataset``/``get_entries``.
        """
        return {
            "total_datasets": len(self._known_dataset_types),
            "total_entries": sum(self._known_entry_counts.values()),
            "rules": {name: dict(stats) for name, stats in self._rule_stats.items()},
            "datasets_by_type": dict(Counter(t.value for t in self._known_dataset_types.values())),
        }
