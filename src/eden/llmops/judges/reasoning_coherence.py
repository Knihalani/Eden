"""ReasoningCoherenceJudge — Galileo Luna-2 agentic metric.

Measures whether the agent's reasoning (the chain of thought
before each action) is internally coherent and consistent with
the observed environment.

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, cast

from .base import Judge, JudgeContext, JudgeScore
from .hallucination import _parse_judge_response

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


_REASONING_COHERENCE_PROMPT = """You are evaluating the internal coherence of an agent's reasoning chain.

Reasoning / chain of thought:
{reasoning}

Observation / environment state (may be empty):
{observation}

Action taken:
{action}

On a scale of 0.0 (the reasoning is contradictory, hallucinates environment state, or doesn't justify the action) to 1.0 (the reasoning is internally consistent and clearly justifies the action), rate it.

Return your answer as a JSON object: {{"score": <float>, "rationale": "<one short sentence>"}}
"""


class ReasoningCoherenceJudge(Judge):
    """Galileo Luna-2: reasoning coherence per step."""

    name = "reasoning_coherence"
    version = "2026-06-10"
    model_slot = "fast"

    def matches(self, event: TelemetryEvent) -> bool:
        if not super().matches(event):
            return False
        payload = event.payload or {}
        return bool(payload.get("reasoning") or payload.get("thought"))

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        if ctx.llm_client is None:
            return self._low_confidence(event, ctx, reason="no llm_client")

        reasoning, observation, action = _extract_reasoning(event)
        if not reasoning:
            return self._low_confidence(event, ctx, reason="missing_reasoning")

        prompt = _REASONING_COHERENCE_PROMPT.format(
            reasoning=reasoning[:1500],
            observation=observation[:500],
            action=action[:300],
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
            logger.debug("reasoning_coherence judge failed: %s", exc)
            return self._low_confidence(event, ctx, reason="llm_error")


def _extract_reasoning(event) -> tuple:
    payload = event.payload or {}
    reasoning = payload.get("reasoning") or payload.get("thought") or ""
    observation = payload.get("observation") or payload.get("env_state") or ""
    action = (
        payload.get("action")
        or payload.get("chosen_action")
        or payload.get("tool_call")
        or ""
    )
    return reasoning, observation, action
