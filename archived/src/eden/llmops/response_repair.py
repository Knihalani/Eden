"""Structural repair for OpenAI-shaped chat completion responses.

Repairs malformed tool-call JSON in gateway responses without a
second LLM call. Never invents tool names or argument keys.
"""

from __future__ import annotations

import json
import re
import uuid
from copy import deepcopy
from typing import Any


def repair_chat_completion_response(
    shaped: dict[str, Any],
) -> tuple[dict[str, Any], int]:
    """Return a copy of *shaped* with tool-call fields repaired.

    Returns ``(repaired_response, repair_count)``.
    """
    out = deepcopy(shaped)
    repairs = 0
    for choice in out.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        tool_calls = message.get("tool_calls")
        if not tool_calls:
            continue
        repaired_calls: list[dict[str, Any]] = []
        for tc in tool_calls:
            if not isinstance(tc, dict):
                repaired_calls.append(tc)
                continue
            fixed, n = _repair_tool_call(tc)
            repairs += n
            repaired_calls.append(fixed)
        message["tool_calls"] = repaired_calls
    return out, repairs


def _repair_tool_call(tc: dict[str, Any]) -> tuple[dict[str, Any], int]:
    repairs = 0
    out = dict(tc)

    if not out.get("type"):
        out["type"] = "function"
        repairs += 1

    tc_id = out.get("id")
    if not isinstance(tc_id, str) or not tc_id.strip():
        out["id"] = f"call_{uuid.uuid4().hex[:24]}"
        repairs += 1

    fn = out.get("function")
    if not isinstance(fn, dict):
        out["function"] = {"name": "", "arguments": "{}"}
        return out, repairs + 1

    fn_out = dict(fn)
    args = fn_out.get("arguments")
    if args is None or (isinstance(args, str) and not args.strip()):
        fn_out["arguments"] = "{}"
        repairs += 1
    elif isinstance(args, str):
        fixed, fixed_n = _repair_json_string(args)
        if fixed_n:
            fn_out["arguments"] = fixed
            repairs += fixed_n
    elif isinstance(args, dict):
        fn_out["arguments"] = json.dumps(args, separators=(",", ":"))
        repairs += 1
    else:
        fn_out["arguments"] = "{}"
        repairs += 1

    out["function"] = fn_out
    return out, repairs


def _repair_json_string(raw: str) -> tuple[str, int]:
    try:
        json.loads(raw)
        return raw, 0
    except json.JSONDecodeError:
        pass

    candidate = raw.strip()
    candidate = _heuristic_json_repair(candidate)
    try:
        json.loads(candidate)
        return candidate, 1
    except json.JSONDecodeError:
        return raw, 0


def _heuristic_json_repair(text: str) -> str:
    """Best-effort JSON repair for common model mistakes."""
    t = text.strip()
    # Trailing commas before } or ]
    t = re.sub(r",\s*([}\]])", r"\1", t)
    # Single-quoted strings -> double-quoted (simple cases)
    if "'" in t and '"' not in t:
        t = t.replace("'", '"')
    # Unclosed object/array — close once
    open_braces = t.count("{") - t.count("}")
    open_brackets = t.count("[") - t.count("]")
    if open_braces > 0:
        t += "}" * open_braces
    if open_brackets > 0:
        t += "]" * open_brackets
    return t
