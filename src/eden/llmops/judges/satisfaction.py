"""SatisfactionJudge — proxy for user satisfaction from
rephrasing, escalation, abandonment, and other signals.

A real implementation consumes the ``user_satisfaction_signals``
and ``user_feedback`` tables (migration 020) to compute a
per-trace satisfaction score. The stub returns a low-confidence
score of 0.5 with a TODO.

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from .base import Judge, JudgeContext, JudgeScore

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


class SatisfactionJudge(Judge):
    """Proxy for user satisfaction from behavioural signals."""

    name = "satisfaction"
    version = "2026-06-10"
    model_slot = "fast"

    def matches(self, event: TelemetryEvent) -> bool:
        if not super().matches(event):
            return False
        payload = event.payload or {}
        return any(
            key in payload
            for key in ("openai", "anthropic", "bedrock", "gemini", "langfuse")
        )

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        # A real implementation would query the user_feedback /
        # user_satisfaction_signals tables for the trace and
        # aggregate. The stub returns a neutral 0.5.
        return JudgeScore(
            judge_name=self.name,
            judge_version=self.version,
            trace_id=ctx.trace_id or event.trace_id,
            span_id=None,
            score=0.5,
            rationale="Stub: no user-satisfaction signals aggregated yet",
            model=self.model_slot,
            metadata={"stub": True, "reason": "no_satisfaction_data"},
        )
