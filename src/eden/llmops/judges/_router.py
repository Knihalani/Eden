"""ModelRouter bridge for built-in and rubric judges."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eden.llm.client import LLMResponse
from eden.llm.internal_router import route_sync

if TYPE_CHECKING:
    from eden.llmops.judges.base import JudgeContext


def route_judge_call(
    ctx: JudgeContext,
    *,
    agent: str,
    prompt: str,
    max_tokens: int = 120,
    output_type: str = "json",
) -> LLMResponse:
    """Score a trace/event through ``ModelRouter`` (sync judge path)."""
    return route_sync(
        agent,
        prompt,
        slot=ctx.model_slot,
        output_type=output_type,
        llm_client=ctx.llm_client,
        max_tokens=max_tokens,
        expected_min_length=1,
        requires_quality_check=False,
        description=f"LLM judge: {agent}",
    )
