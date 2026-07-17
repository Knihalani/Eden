"""F39 trigger DSL evaluator — compile JSON triggers to predicates."""

from __future__ import annotations

from typing import Any


def _match_condition(condition: dict[str, Any], context: dict[str, Any]) -> bool:
    event = condition.get("event")
    if event == "tool_result":
        tool_name = condition.get("tool_name")
        result_contains = condition.get("result_contains")
        for call in context.get("recent_tool_calls") or []:
            if tool_name and call.get("tool_name") != tool_name:
                continue
            result = str(call.get("result") or "")
            if result_contains and result_contains not in result:
                continue
            return True
        return False
    if event == "trace_context":
        repeats = condition.get("same_tool_repeats") or {}
        tool = repeats.get("tool")
        min_count = int(repeats.get("min") or 1)
        window = int(repeats.get("window_steps") or 10)
        recent = (context.get("recent_tool_calls") or [])[-window:]
        count = sum(1 for c in recent if c.get("tool_name") == tool)
        return count >= min_count
    if event == "prompt_contains":
        needle = condition.get("text") or ""
        prompt = str(context.get("prompt") or "")
        return needle in prompt
    if event == "tool_call":
        tool = condition.get("tool") or condition.get("tool_name") or "*"
        min_repeats = int(condition.get("min_repeats") or 1)
        recent = context.get("recent_tool_calls") or []
        count = sum(
            1
            for call in recent
            if tool in ("*", "") or str(call.get("tool_name") or "") == tool
        )
        return count >= min_repeats
    if event == "tool_error":
        tool = condition.get("tool") or condition.get("tool_name") or "*"
        for call in context.get("recent_tool_calls") or []:
            if tool not in ("*", "") and str(call.get("tool_name") or "") != tool:
                continue
            if call.get("error") or call.get("is_error"):
                return True
            result = str(call.get("result") or "")
            if "error" in result.lower() or "failed" in result.lower():
                return True
        return False
    return False


def evaluate_trigger(trigger: dict[str, Any], context: dict[str, Any]) -> bool:
    """Return True when the trigger DSL matches the request context."""
    if not trigger:
        return False
    if "all" in trigger:
        return all(_match_condition(c, context) for c in trigger["all"])
    if "any" in trigger:
        return any(_match_condition(c, context) for c in trigger["any"])
    return _match_condition(trigger, context)
