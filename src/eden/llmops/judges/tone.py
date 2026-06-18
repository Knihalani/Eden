"""ToneJudge — built-in judge that scores LLM output for tone and
style adherence. Useful for customer-facing chatbots where the
brand voice matters.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import Judge, JudgeContext, JudgeScore
from .hallucination import _extract_text_and_spec, _parse_judge_response

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


_TONE_PROMPT = """You evaluate the tone and style of an LLM response.

Target style (may be empty — judge on professional, helpful tone as a default):
{style}

Response:
{response}

Return JSON: {{"score": <float 0.0-1.0>, "rationale": "<one sentence>"}}
0.0 = rude, off-brand, or unprofessional.
1.0 = on-brand, warm, and clear.
"""


class ToneJudge(Judge):
    """LLM-as-judge for tone / style adherence."""

    name = "tone"
    version = "2026-06-03"
    model_slot = "fast"

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        if ctx.llm_client is None:
            return self._unknown(event, ctx, reason="no llm_client")

        text, _task = _extract_text_and_spec(event)
        if not text:
            return self._unknown(event, ctx, reason="empty_response")

        # Look for an explicit style hint in the event tags / attributes.
        style_hint = ""
        for attr_val in (event.attributes or {}).values():
            if isinstance(attr_val, str) and attr_val.startswith("style:"):
                style_hint = attr_val[len("style:"):]
                break
        for tag in event.tags or []:
            if isinstance(tag, str) and tag.startswith("style:"):
                style_hint = tag[len("style:"):]
                break

        prompt = _TONE_PROMPT.format(
            style=style_hint or "(default: professional, warm, concise)",
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
            logger.debug(f"tone judge failed: {exc}")
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
