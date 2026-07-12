"""CorrectnessJudge — built-in judge that scores LLM output for
task correctness (did it actually answer the user's question?).

Patterned after HallucinationJudge but focused on a different axis.
Shares the same prompt parser.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import Judge, JudgeContext, JudgeScore
from ._sampling import production_sample_matches
from .hallucination import _extract_text_and_spec, _parse_judge_response

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


_CORRECTNESS_PROMPT = """You are an exacting evaluator. Judge whether the following LLM response correctly and completely addresses the task.

Task:
{task}

Response:
{response}

Return JSON: {{"score": <float 0.0-1.0>, "rationale": "<one sentence>"}}
0.0 = the response is wrong, incomplete, or off-topic.
1.0 = the response is correct, complete, and on-target.
"""


class CorrectnessJudge(Judge):
    """LLM-as-judge for task correctness."""

    name = "correctness"
    version = "2026-06-03"
    model_slot = "fast"

    def matches(self, event: TelemetryEvent) -> bool:
        if not super().matches(event):
            return False
        return production_sample_matches(event)

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        if ctx.llm_client is None:
            return self._unknown(event, ctx, reason="no llm_client")

        text, task = _extract_text_and_spec(event)
        if not text:
            return self._unknown(event, ctx, reason="empty_response")

        prompt = _CORRECTNESS_PROMPT.format(
            task=task[:400] if task else "(no task description available)",
            response=text[:1200],
        )
        t0 = time.monotonic()
        try:
            resp = ctx.llm_client.call(
                agent=f"judge_{self.name}",
                prompt=prompt,
                slot=self.model_slot,
                max_tokens=120,
            )
            latency_ms = (time.monotonic() - t0) * 1000.0
            score, rationale = _parse_judge_response(resp.content)
            return JudgeScore(
                judge_name=self.name,
                judge_version=self.version,
                trace_id=ctx.trace_id or event.trace_id,
                span_id=event.span_id,
                score=score,
                rationale=rationale,
                model=getattr(resp, "model", "") or "unknown",
                latency_ms=latency_ms,
                metadata={"event_id": event.event_id},
            )
        except Exception as exc:
            logger.debug(f"correctness judge failed: {exc}")
            return self._unknown(event, ctx, reason=f"judge_error:{type(exc).__name__}")

    def _unknown(
        self, event: TelemetryEvent, ctx: JudgeContext, *, reason: str
    ) -> JudgeScore:
        return JudgeScore(
            judge_name=self.name,
            judge_version=self.version,
            trace_id=ctx.trace_id or event.trace_id,
            span_id=event.span_id,
            score=0.5,
            rationale=f"no_score:{reason}",
            model="n/a",
            metadata={"event_id": event.event_id, "reason": reason},
        )
