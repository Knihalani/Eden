"""RelevanceJudge — measures whether the answer is on-topic for the
user's question.

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import Judge, JudgeContext, JudgeScore
from .hallucination import _parse_judge_response

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


_RELEVANCE_PROMPT = """You are evaluating the relevance of an LLM response to a user's question.

Question:
{question}

Response:
{response}

On a scale of 0.0 (off-topic / does not address the question) to 1.0 (directly and fully addresses the question), rate the response.

Return your answer as a JSON object: {{"score": <float>, "rationale": "<one short sentence>"}}
"""


class RelevanceJudge(Judge):
    """LLM-as-judge for answer-question relevance."""

    name = "relevance"
    version = "2026-06-10"
    model_slot = "fast"

    def matches(self, event: TelemetryEvent) -> bool:
        if not super().matches(event):
            return False
        payload = event.payload or {}
        return bool(payload.get("question") or payload.get("input_text"))

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        if ctx.llm_client is None:
            return self._low_confidence(event, ctx, reason="no llm_client")

        text, question = _extract_text_and_question(event)
        if not text or not question:
            return self._low_confidence(event, ctx, reason="missing_text_or_question")

        prompt = _RELEVANCE_PROMPT.format(
            question=question[:600], response=text[:1200]
        )
        t0 = time.monotonic()
        try:
            resp = ctx.llm_client.call(
                agent=f"judge_{self.name}",
                prompt=prompt,
                slot=self.model_slot,
                max_tokens=120,
            )
            data = _parse_judge_response(resp, event, ctx)
            data.latency_ms = (time.monotonic() - t0) * 1000.0
            return data
        except Exception as exc:
            logger.debug("relevance judge failed: %s", exc)
            return self._low_confidence(event, ctx, reason="llm_error")


def _extract_text_and_question(event) -> tuple:
    payload = event.payload or {}
    text = payload.get("response_text") or payload.get("output_text") or ""
    question = payload.get("question") or payload.get("input_text") or ""
    return text, question
