"""ActionCompletionJudge — Galileo Luna-2 agentic metric.

Measures whether the agent's chosen action actually completes
the task it set out to do. Differs from ``CorrectnessJudge``
(which scores the *final* answer) by scoring the *action* that
the agent decided to take at each step.

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


_ACTION_COMPLETION_PROMPT = """You are evaluating whether an agent's chosen action moves it toward completing its task.

Task / goal:
{goal}

Chosen action:
{action}

Action result (may be empty):
{result}

On a scale of 0.0 (action does not advance the goal, or makes no progress) to 1.0 (action fully completes the goal), rate the action.

Return your answer as a JSON object: {{"score": <float>, "rationale": "<one short sentence>"}}
"""


class ActionCompletionJudge(Judge):
    """Galileo Luna-2: action completion score per step."""

    name = "action_completion"
    version = "2026-06-10"
    model_slot = "fast"

    def matches(self, event: TelemetryEvent) -> bool:
        if not super().matches(event):
            return False
        payload = event.payload or {}
        return bool(payload.get("action") or payload.get("tool_call"))

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        if ctx.llm_client is None:
            return cast(JudgeScore, self._low_confidence(event, ctx, reason="no llm_client"))

        action, goal, result = _extract_action_goal_result(event)
        if not action or not goal:
            return cast(JudgeScore, self._low_confidence(event, ctx, reason="missing_action_or_goal"))

        prompt = _ACTION_COMPLETION_PROMPT.format(
            goal=goal[:500], action=action[:500], result=result[:500]
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
            logger.debug("action_completion judge failed: %s", exc)
            return cast(JudgeScore, self._low_confidence(event, ctx, reason="llm_error"))


def _extract_action_goal_result(event) -> tuple:
    payload = event.payload or {}
    action = (
        payload.get("action")
        or payload.get("tool_call")
        or payload.get("chosen_action")
        or ""
    )
    goal = payload.get("goal") or payload.get("task") or payload.get("spec") or ""
    result = payload.get("result") or payload.get("tool_result") or ""
    return action, goal, result
