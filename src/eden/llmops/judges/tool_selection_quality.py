"""ToolSelectionQualityJudge — Galileo Luna-2 agentic metric.

Measures whether the agent picked the *best* available tool
(out of the tools that were available at the step) for the
current subgoal.

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import Judge, JudgeContext, JudgeScore
from ._sampling import production_sample_matches
from .hallucination import _parse_judge_response

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


_TOOL_SELECTION_PROMPT = """You are evaluating whether an agent picked the best available tool for a given subgoal.

Subgoal:
{goal}

Available tools (name → description):
{available_tools}

Chosen tool:
{chosen}

On a scale of 0.0 (the chosen tool is clearly wrong or far from optimal) to 1.0 (the chosen tool is the unambiguous best pick for the subgoal), rate the selection.

Return your answer as a JSON object: {{"score": <float>, "rationale": "<one short sentence>"}}
"""


class ToolSelectionQualityJudge(Judge):
    """Galileo Luna-2: tool-selection quality per step."""

    name = "tool_selection_quality"
    version = "2026-06-10"
    model_slot = "fast"

    def matches(self, event: TelemetryEvent) -> bool:
        if not super().matches(event):
            return False
        payload = event.payload or {}
        return bool(payload.get("available_tools")) and bool(
            payload.get("chosen") or payload.get("chosen_tool")
        ) and production_sample_matches(event)

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        if ctx.llm_client is None:
            return self._low_confidence(event, ctx, reason="no llm_client")

        available, chosen, goal = _extract_tool_selection(event)
        if not available or not chosen:
            return self._low_confidence(event, ctx, reason="missing_tools")

        prompt = _TOOL_SELECTION_PROMPT.format(
            goal=goal[:400],
            available_tools=str(available)[:1000],
            chosen=chosen[:200],
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
            logger.debug("tool_selection_quality judge failed: %s", exc)
            return self._low_confidence(event, ctx, reason="llm_error")


def _extract_tool_selection(event) -> tuple:
    payload = event.payload or {}
    available = payload.get("available_tools") or []
    chosen = payload.get("chosen") or payload.get("chosen_tool") or ""
    goal = payload.get("goal") or payload.get("subgoal") or ""
    return available, chosen, goal
