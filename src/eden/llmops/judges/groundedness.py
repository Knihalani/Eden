"""GroundednessJudge — measures whether an LLM answer is supported
by the retrieved context (or other supplied context).

Mirrors the structure of ``HallucinationJudge`` (see
``src/eden/llmops/judges/hallucination.py``) but reads the
``retrieval_logs`` payload to find the supplied context and asks
the LLM to verify every claim in the answer against it.

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any, cast

from .base import Judge, JudgeContext, JudgeScore

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


_GROUNDEDNESS_PROMPT = """You are a careful fact-checker. The following is an LLM-generated response, and the context that was supplied to it.

Context (may be truncated):
{context}

Response to evaluate:
{response}

On a scale of 0.0 (response has claims not supported by context) to 1.0 (every claim is grounded in the context), rate the response.

Return your answer as a JSON object: {{"score": <float>, "rationale": "<one short sentence>"}}
"""


class GroundednessJudge(Judge):
    """LLM-as-judge for groundedness / citation support."""

    name = "groundedness"
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
        if ctx.llm_client is None:
            return self._low_confidence(event, ctx, reason="no llm_client")

        text, context = _extract_text_and_context(event)
        if not text or not context:
            return self._low_confidence(event, ctx, reason="missing_text_or_context")

        prompt = _GROUNDEDNESS_PROMPT.format(
            context=context[:1500], response=text[:1200]
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
            return cast(JudgeScore, data)
        except Exception as exc:
            logger.debug("groundedness judge failed: %s", exc)
            return self._low_confidence(event, ctx, reason="llm_error")


def _extract_text_and_context(event) -> tuple:
    payload = event.payload or {}
    text = payload.get("response_text") or payload.get("output_text") or ""
    context = payload.get("context") or payload.get("retrieved_context") or ""
    return text, context


def _parse_judge_response(resp, event, ctx) -> Any:
    from .hallucination import _parse_judge_response  # reuse the parser
    return _parse_judge_response(resp, event, ctx)
