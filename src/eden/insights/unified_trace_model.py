"""Unified Trace Model (UTM) — normalizes traces from all three realms.

Phase 6.3: Single schema spans environment, production, and comparative realms.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any
from uuid import uuid4

logger = logging.getLogger(__name__)


class Realm(Enum):
    ENVIRONMENT = "environment"
    PRODUCTION = "production"
    COMPARATIVE = "comparative"


class Outcome(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    PARTIAL = "partial"
    TIMEOUT = "timeout"
    CRASH = "crash"


class SpanType(Enum):
    LLM_COMPLETION = "llm.completion"
    TOOL_INVOCATION = "tool.invoke"
    ENV_STEP = "env.step"
    REASONING = "reasoning"
    USER_INTERACTION = "user.interaction"
    SYSTEM = "system"


@dataclass
class Span:
    span_id: str
    parent_id: str | None = None
    name: str = ""
    span_type: SpanType = SpanType.SYSTEM
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    duration_ms: float = 0.0
    metrics: dict[str, float] = field(default_factory=dict)
    attributes: dict[str, str] = field(default_factory=dict)
    payload: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["span_type"] = self.span_type.value
        d["started_at"] = self.started_at.isoformat() if self.started_at else None
        d["ended_at"] = self.ended_at.isoformat() if self.ended_at else None
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Span:
        data = dict(data)
        data["span_type"] = SpanType(data.get("span_type", "system"))
        if data.get("started_at"):
            data["started_at"] = datetime.fromisoformat(data["started_at"])
        if data.get("ended_at"):
            data["ended_at"] = datetime.fromisoformat(data["ended_at"])
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class UnifiedTrace:
    trace_id: str
    tenant_id: str
    project_id: str = "default"
    realm: Realm = Realm.ENVIRONMENT
    agent_id: str = ""
    agent_version: str = ""
    environment_id: str | None = None
    environment_version: str | None = None
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    duration_ms: float = 0.0
    outcome: Outcome = Outcome.SUCCESS
    metrics: dict[str, float] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, str] = field(default_factory=dict)
    spans: list[Span] = field(default_factory=list)
    insights: list[dict[str, Any]] = field(default_factory=list)
    # Normalization provenance
    source_format: str = "native"
    normalization_version: str = "1.0"

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "tenant_id": self.tenant_id,
            "project_id": self.project_id,
            "realm": self.realm.value,
            "agent_id": self.agent_id,
            "agent_version": self.agent_version,
            "environment_id": self.environment_id,
            "environment_version": self.environment_version,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "duration_ms": self.duration_ms,
            "outcome": self.outcome.value,
            "metrics": self.metrics,
            "tags": self.tags,
            "metadata": self.metadata,
            "spans": [s.to_dict() for s in self.spans],
            "insights": self.insights,
            "source_format": self.source_format,
            "normalization_version": self.normalization_version,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> UnifiedTrace:
        data = dict(data)
        data["realm"] = Realm(data.get("realm", "environment"))
        data["outcome"] = Outcome(data.get("outcome", "success"))
        if data.get("started_at"):
            data["started_at"] = datetime.fromisoformat(data["started_at"])
        if data.get("ended_at"):
            data["ended_at"] = datetime.fromisoformat(data["ended_at"])
        data["spans"] = [Span.from_dict(s) for s in data.get("spans", [])]
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    def content_hash(self) -> str:
        """Deterministic hash for deduplication."""
        payload = json.dumps(self.to_dict(), sort_keys=True, default=str)
        return hashlib.sha256(payload.encode()).hexdigest()[:32]

    def fingerprint(self) -> str:
        """Semantic fingerprint for similarity matching."""
        parts = [
            self.realm.value,
            self.agent_id,
            self.environment_id or "",
            self.outcome.value,
            ",".join(sorted(self.tags)),
        ]
        # Include tool names from spans
        tool_names = sorted({
            s.payload.get("tool_name", "")
            for s in self.spans
            if s.span_type == SpanType.TOOL_INVOCATION and s.payload.get("tool_name")
        })
        parts.append(",".join(tool_names))
        return hashlib.sha256("|".join(parts).encode()).hexdigest()[:24]


class TraceNormalizer:
    """Normalizes traces from various sources into the Unified Trace Model."""

    @staticmethod
    def from_environment_trace(tenant_id: str, raw: dict[str, Any]) -> UnifiedTrace:
        """Normalize an environment realm trace (from Eden pipeline)."""
        trace = UnifiedTrace(
            trace_id=raw.get("trace_id", str(uuid4())),
            tenant_id=tenant_id,
            project_id=raw.get("project_id", "default"),
            realm=Realm.ENVIRONMENT,
            agent_id=raw.get("agent_id", ""),
            agent_version=raw.get("agent_version", ""),
            environment_id=raw.get("environment_id"),
            environment_version=raw.get("environment_version"),
            source_format="eden_environment",
        )

        # Parse timestamps
        if raw.get("started_at"):
            trace.started_at = _parse_timestamp(raw["started_at"])
        if raw.get("ended_at"):
            trace.ended_at = _parse_timestamp(raw["ended_at"])
        if trace.started_at and trace.ended_at:
            trace.duration_ms = (trace.ended_at - trace.started_at).total_seconds() * 1000

        # Outcome
        outcome = raw.get("outcome", "success")
        trace.outcome = Outcome(outcome) if outcome in [o.value for o in Outcome] else Outcome.SUCCESS

        # Metrics
        trace.metrics = raw.get("metrics", {})
        trace.tags = raw.get("tags", [])
        trace.metadata = {k: str(v) for k, v in raw.get("metadata", {}).items()}

        # Spans
        for span_data in raw.get("spans", []):
            trace.spans.append(_normalize_span(span_data))

        # Insights from pipeline
        trace.insights = raw.get("insights", [])

        return trace

    @staticmethod
    def from_production_trace(tenant_id: str, raw: dict[str, Any]) -> UnifiedTrace:
        """Normalize a production realm trace (from SDK auto-instrumentation)."""
        trace = UnifiedTrace(
            trace_id=raw.get("trace_id", str(uuid4())),
            tenant_id=tenant_id,
            project_id=raw.get("project_id", "default"),
            realm=Realm.PRODUCTION,
            agent_id=raw.get("agent_id", ""),
            agent_version=raw.get("agent_version", ""),
            source_format="eden_sdk",
        )

        if raw.get("started_at"):
            trace.started_at = _parse_timestamp(raw["started_at"])
        if raw.get("ended_at"):
            trace.ended_at = _parse_timestamp(raw["ended_at"])
        if trace.started_at and trace.ended_at:
            trace.duration_ms = (trace.ended_at - trace.started_at).total_seconds() * 1000

        outcome = raw.get("outcome", "success")
        trace.outcome = Outcome(outcome) if outcome in [o.value for o in Outcome] else Outcome.SUCCESS
        trace.metrics = raw.get("metrics", {})
        trace.tags = raw.get("tags", [])
        trace.metadata = {k: str(v) for k, v in raw.get("metadata", {}).items()}

        # Normalize SDK spans
        for span_data in raw.get("spans", []):
            trace.spans.append(_normalize_sdk_span(span_data))

        # Auto-classify errors
        trace.insights = _auto_classify_errors(trace)

        return trace

    @staticmethod
    def from_comparative_metrics(
        tenant_id: str,
        env_trace_id: str,
        prod_trace_id: str,
        metrics: dict[str, Any],
    ) -> UnifiedTrace:
        """Create a comparative trace from disparity metrics."""
        trace = UnifiedTrace(
            trace_id=f"cmp_{env_trace_id}_{prod_trace_id}"[:64],
            tenant_id=tenant_id,
            realm=Realm.COMPARATIVE,
            source_format="eden_comparative",
            metadata={
                "env_trace_id": env_trace_id,
                "prod_trace_id": prod_trace_id,
            },
            metrics={
                "action_divergence": metrics.get("action_divergence", 0.0),
                "outcome_divergence": 1.0 if metrics.get("outcome_mismatch") else 0.0,
                "latency_gap_ratio": metrics.get("latency_gap", {}).get("ratio", 1.0),
                "coverage_gap": metrics.get("coverage_gap", {}).get("gap", 0.0),
                "tool_usage_gap": metrics.get("tool_usage_gap", 0.0),
                "error_pattern_gap": metrics.get("error_pattern_gap", 0.0),
            },
            tags=["comparative", "auto_generated"],
        )

        # Create a single comparative span
        trace.spans.append(Span(
            span_id=str(uuid4()),
            name="comparative_analysis",
            span_type=SpanType.SYSTEM,
            payload={"disparity_dimensions": metrics},
        ))

        return trace


def _normalize_span(data: dict[str, Any]) -> Span:
    """Normalize a raw span dict into a Span."""
    span_type = data.get("span_type", "system")
    try:
        st = SpanType(span_type)
    except ValueError:
        st = SpanType.SYSTEM

    started = _parse_timestamp(data.get("started_at")) if data.get("started_at") else datetime.now(UTC)
    ended = _parse_timestamp(data.get("ended_at")) if data.get("ended_at") else None
    duration = data.get("duration_ms", 0.0)
    if not duration and started and ended:
        duration = (ended - started).total_seconds() * 1000

    return Span(
        span_id=data.get("span_id", str(uuid4())),
        parent_id=data.get("parent_id"),
        name=data.get("name", ""),
        span_type=st,
        started_at=started,
        ended_at=ended,
        duration_ms=duration,
        metrics=data.get("metrics", {}),
        attributes={k: str(v) for k, v in data.get("attributes", {}).items()},
        payload=data.get("payload", {}),
        events=data.get("events", []),
    )


def _normalize_sdk_span(data: dict[str, Any]) -> Span:
    """Normalize a span from the Eden SDK / OpenTelemetry format."""
    span_kind = data.get("kind", "internal")
    name = data.get("name", "")

    # Map OTel span kinds to our types
    span_type = SpanType.SYSTEM
    if "llm" in name.lower() or "completion" in name.lower():
        span_type = SpanType.LLM_COMPLETION
    elif "tool" in name.lower():
        span_type = SpanType.TOOL_INVOCATION
    elif "reasoning" in name.lower() or "think" in name.lower():
        span_type = SpanType.REASONING
    elif "env" in name.lower() or "step" in name.lower():
        span_type = SpanType.ENV_STEP
    elif "user" in name.lower():
        span_type = SpanType.USER_INTERACTION

    started = _parse_timestamp(data.get("start_time")) if data.get("start_time") else datetime.now(UTC)
    ended = _parse_timestamp(data.get("end_time")) if data.get("end_time") else None
    duration = data.get("duration_ms", 0.0)
    if not duration and started and ended:
        duration = (ended - started).total_seconds() * 1000

    # Extract attributes as payload
    attributes = data.get("attributes", {})
    payload = {}
    if "llm" in name.lower():
        payload = {
            "model": attributes.get("llm.model", ""),
            "provider": attributes.get("llm.provider", ""),
            "prompt_tokens": attributes.get("llm.prompt_tokens", 0),
            "completion_tokens": attributes.get("llm.completion_tokens", 0),
            "cost_usd": attributes.get("llm.cost_usd", 0.0),
        }
    elif "tool" in name.lower():
        payload = {
            "tool_name": attributes.get("tool.name", ""),
            "arguments": attributes.get("tool.arguments", {}),
            "result": attributes.get("tool.result", {}),
            "success": attributes.get("tool.success", True),
        }

    return Span(
        span_id=data.get("span_id", str(uuid4())),
        parent_id=data.get("parent_id"),
        name=name,
        span_type=span_type,
        started_at=started,
        ended_at=ended,
        duration_ms=duration,
        metrics=data.get("metrics", {}),
        attributes={k: str(v) for k, v in attributes.items()},
        payload=payload,
        events=data.get("events", []),
    )


def _auto_classify_errors(trace: UnifiedTrace) -> list[dict[str, Any]]:
    """Auto-classify production errors into taxonomy."""
    insights = []

    for span in trace.spans:
        if span.span_type != SpanType.LLM_COMPLETION:
            continue

        payload = span.payload
        completion = payload.get("completion", "")
        if not completion:
            continue

        completion_lower = completion.lower()

        # Hallucination indicators
        if any(kw in completion_lower for kw in ["i'm not sure", "i don't know", " hallucination", "confabulation"]):
            insights.append({
                "insight_id": f"ins_{span.span_id}_hallucination",
                "detector": "error_classifier",
                "severity": "medium",
                "confidence": 0.7,
                "category": "hallucination",
                "summary": "Potential hallucination detected in LLM completion",
                "span_id": span.span_id,
            })

        # Tool misuse indicators
        if span.span_type == SpanType.TOOL_INVOCATION:
            if not payload.get("success", True):
                insights.append({
                    "insight_id": f"ins_{span.span_id}_tool_misuse",
                    "detector": "error_classifier",
                    "severity": "high",
                    "confidence": 0.85,
                    "category": "tool_misuse",
                    "summary": f"Tool {payload.get('tool_name', 'unknown')} invocation failed",
                    "span_id": span.span_id,
                })

    # Loop detection
    tool_sequence = [
        s.payload.get("tool_name", "")
        for s in trace.spans
        if s.span_type == SpanType.TOOL_INVOCATION and s.payload.get("tool_name")
    ]
    if len(tool_sequence) >= 6:
        # Check for repeating pattern
        for window_size in range(2, min(4, len(tool_sequence) // 2 + 1)):
            pattern = tuple(tool_sequence[:window_size])
            repeats = sum(
                1
                for i in range(0, len(tool_sequence) - window_size + 1, window_size)
                if tuple(tool_sequence[i:i + window_size]) == pattern
            )
            if repeats >= 3:
                insights.append({
                    "insight_id": f"ins_{trace.trace_id}_loop",
                    "detector": "error_classifier",
                    "severity": "high",
                    "confidence": 0.8,
                    "category": "loop",
                    "summary": f"Detected repeating tool pattern: {pattern}",
                    "repeats": repeats,
                })
                break

    return insights


def _parse_timestamp(ts: Any) -> datetime:
    """Parse various timestamp formats."""
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=UTC)
    if isinstance(ts, (int, float)):
        # Assume milliseconds if > 1e10, seconds otherwise
        if ts > 1e10:
            return datetime.fromtimestamp(ts / 1000, tz=UTC)
        return datetime.fromtimestamp(ts, tz=UTC)
    if isinstance(ts, str):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            pass
        # Try common formats
        for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S"):
            try:
                return datetime.strptime(ts, fmt).replace(tzinfo=UTC)
            except ValueError:
                continue
    return datetime.now(UTC)
