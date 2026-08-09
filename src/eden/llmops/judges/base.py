"""Phase 7.1b — LLM-as-judge abstraction.

A ``Judge`` scores a single ``TelemetryEvent`` and emits a
``JudgeScore``. Built-in judges (hallucination, correctness, tone)
ship here; customers can register their own via ``JudgeRegistry``.

The pipeline is:
  1. ``JudgeRegistry.for_event(event)`` returns the judges whose
     scope matches the event (event_type / agent_id / env).
  2. ``JudgeRunner.run_for_event(event, judges)`` runs each judge
     concurrently and writes results to ``judge_scores``.
  3. A virtual ``JudgeDetector`` in
     ``src/eden/insights/detectors.py`` reads ``judge_scores`` and
     surfaces them as ``Insight`` objects so the existing
     ``InsightsService`` → KB flow runs unchanged.

Failure policy: judges never break the customer's call. Any
exception in a single judge is logged and skipped; other judges
still run.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


@dataclass
class JudgeContext:
    """Context passed to a Judge for one scoring invocation.

    Carries the request-scoped data the judge needs to make its
    decision: the event itself, the LLM client (lazily imported so
    tests can substitute), the model slot to use, and the trace_id
    for downstream correlation.

    Playground/F51 dataset rows are adapted into a
    :class:`~eden.observability.telemetry_collector.TelemetryEvent`
    before scoring — see
    :mod:`eden.playground.llm_judge_adapter`.
    """

    event: TelemetryEvent
    llm_client: Any = None  # OpenRouterClient; lazy so judges can run without one
    model_slot: str = "fast"
    trace_id: str = ""


@dataclass
class JudgeScore:
    """One judge's score for one event. Persisted to ``judge_scores``."""

    judge_name: str
    judge_version: str
    trace_id: str
    span_id: str | None
    score: float
    rationale: str | None
    model: str
    scored_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    latency_ms: float = 0.0
    cost_usd: float = 0.0
    cached: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "judge_name": self.judge_name,
            "judge_version": self.judge_version,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "score": self.score,
            "rationale": self.rationale,
            "model": self.model,
            "scored_at": self.scored_at.isoformat(),
            "latency_ms": self.latency_ms,
            "cost_usd": self.cost_usd,
            "cached": self.cached,
            "metadata": self.metadata,
        }


class Judge(ABC):
    """Abstract base for LLM-as-judge scorers.

    Subclasses set class-level metadata (``name``, ``version``,
    ``model_slot``) and override ``matches(event)`` and
    ``score(event, ctx)``. The default ``matches`` returns True
    for any event with an LLM-style ``event_type`` — override for
    narrower scoping.
    """

    #: Identifier used in ``judge_scores.judge_name`` and the registry.
    name: str = ""
    #: Versioned so judge prompts can iterate without breaking
    #: historical score rows.
    version: str = "0.0.0"
    #: Which LLM slot the judge call should use. ``fast`` is the
    #: default — judge prompts are small. Override per-judge.
    model_slot: str = "fast"
    #: Whether the judge should run synchronously (caller awaits the
    #: score) or be queued for the async Redis tailer. Sync is the
    #: default — async is for high-volume production events.
    sync: bool = True

    @abstractmethod
    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore | list[JudgeScore]:
        """Score one event. May return one score or a list (multi-axis).

        Must not raise — return a low-confidence JudgeScore instead.
        The runner logs and skips failures defensively, but a
        non-raising implementation is the contract.
        """
        ...

    def matches(self, event: TelemetryEvent) -> bool:
        """Return True if this judge applies to ``event``.

        Default: applies to any event with an LLM-style event_type.
        Built-in judges override this for narrower scoping (e.g.
        ``correctness`` only fires on completion events with a payload).
        """
        if event is None or not event.event_type:
            return False
        return any(
            event.event_type.startswith(prefix)
            for prefix in (
                "otel.chat", "otel.embeddings", "otel.text_completion",
                "openai.", "anthropic.", "bedrock.", "gemini.",
                "langfuse.generation", "helicone.llm_call",
                "llm_completion", "llm_completion_stream",
            )
        )
