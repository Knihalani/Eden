"""F49 span → playground seeding — load + extract a stored span request.

Mirrors the extraction precedence of the time-travel replayer's
``_re_execute_step``: an explicit ``prompt`` / ``system_prompt`` (top
level or nested under ``payload["request"]``) wins over the recorded
``messages`` array, and the model falls back across ``model`` /
``model_version`` at both levels. Kept as a small standalone helper so
the playground does not import the replayer wholesale.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# ``telemetry_events`` rows that carry an LLM request payload.
_SPAN_EVENT_TYPES: tuple[str, ...] = ("agent.step", "llm_call")

_SELECT_SPAN_STEP = """
    SELECT event_id, trace_id, span_id, name, payload, attributes,
           duration_ms, timestamp
    FROM telemetry_events
    WHERE trace_id = $1
      AND tenant_id = $2
      AND event_type = ANY($3::text[])
"""


async def fetch_span_step(
    *, org_id: str, trace_id: str, span_id: str | None = None
) -> dict[str, Any] | None:
    """Return the stored request-bearing event for a span, if any.

    Queries ``telemetry_events`` (keyed by ``tenant_id``, not ``org_id``
    — same convention as time-travel's ``_get_parent_steps``) for the
    given span, falling back to the trace's first ``agent.step`` /
    ``llm_call`` event when ``span_id`` is absent or matches nothing.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    row = None
    if span_id:
        row = await client.fetchrow(
            _SELECT_SPAN_STEP + " AND span_id = $4 ORDER BY timestamp ASC LIMIT 1",
            trace_id,
            org_id,
            list(_SPAN_EVENT_TYPES),
            span_id,
        )
    if row is None:
        row = await client.fetchrow(
            _SELECT_SPAN_STEP + " ORDER BY timestamp ASC LIMIT 1",
            trace_id,
            org_id,
            list(_SPAN_EVENT_TYPES),
        )
    return dict(row) if row else None


def _first(*vals: Any) -> Any:
    for v in vals:
        if v is not None and v != "" and v != []:
            return v
    return None


def _block_text(content: Any) -> str:
    """Flatten a message ``content`` (string or text-block list) to text."""
    if isinstance(content, list):
        return "\n".join(
            str(block.get("text") or "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return str(content or "")


def extract_span_seed(step: dict[str, Any]) -> dict[str, Any] | None:
    """Extract ``{messages, model, params, tools}`` from a stored step.

    Returns ``None`` when no usable prompt content is stored (neither an
    explicit prompt / system_prompt nor a non-empty messages array), so
    callers never seed a playground from thin air.
    """
    payload: Any = step.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (ValueError, TypeError):
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    request = (
        payload.get("request") if isinstance(payload.get("request"), dict) else {}
    )

    explicit_prompt = _first(payload.get("prompt"), request.get("prompt"))
    explicit_system = _first(
        payload.get("system_prompt"), request.get("system_prompt")
    )
    messages: list[dict[str, Any]] = []
    if explicit_prompt or explicit_system:
        # Prefer explicit prompt / system_prompt (including edits) over
        # reconstructing from messages — same rule as the replayer.
        if explicit_system:
            messages.append({"role": "system", "content": str(explicit_system)})
        if explicit_prompt:
            messages.append({"role": "user", "content": str(explicit_prompt)})
    else:
        raw = _first(payload.get("messages"), request.get("messages")) or []
        for m in raw:
            if not isinstance(m, dict):
                continue
            messages.append(
                {
                    "role": str(m.get("role") or "user"),
                    "content": _block_text(m.get("content")),
                }
            )
    if not any(str(m.get("content") or "").strip() for m in messages):
        return None

    model = _first(
        payload.get("model"),
        payload.get("model_version"),
        request.get("model"),
        request.get("model_version"),
    )
    tools = _first(payload.get("tools"), request.get("tools")) or []
    params: dict[str, Any] = {}
    for key in ("temperature", "max_tokens", "top_p"):
        val = _first(payload.get(key), request.get(key))
        if val is not None:
            params[key] = val
    return {
        "messages": messages,
        "model": str(model) if model else None,
        "tools": list(tools) if isinstance(tools, list) else [],
        "params": params,
    }


__all__ = ["extract_span_seed", "fetch_span_step"]
