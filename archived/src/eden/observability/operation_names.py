"""FEAT-23 — shared ``gen_ai.operation.name`` derivation.

Both the OTel dual-emit exporter (``otel_exporter.py``) and the
multi-format ingestion route (``api/routes/ingestion.py``) need to map
a :class:`~eden.observability.telemetry_collector.TelemetryEvent` onto
an OTel GenAI ``operation.name`` value. This module is the single
source of truth for that mapping so the two call sites can't drift.

The table below only covers Eden's LLM-call-shaped ``event_type``
values (all bucketed to well-known OTel GenAI operations). It
deliberately does NOT cover Eden's own ``tool.call`` / agent-to-agent
event shapes — those are handled by :func:`derive_operation_name`
before falling back to the table, so a tool call or an agent handoff
is never silently mislabeled as ``"chat"``.
"""

from __future__ import annotations

from typing import Any

# Map Eden's event_type onto OTel ``gen_ai.operation.name`` values
# (the OTel GenAI spec keeps a closed list of well-known operations).
_OPERATION_NAME_MAP: dict[str, str] = {
    "openai.chat_completion": "chat",
    "openai.responses": "responses",
    "anthropic.message": "chat",
    "anthropic.messages": "chat",
    "bedrock.invoke_model": "invoke_model",
    "gemini.generate_content": "generate_content",
    "helicone.llm_call": "chat",
    "langfuse.generation": "chat",
    "otel.chat": "chat",
    "otel.text_completion": "text_completion",
    "otel.embeddings": "embeddings",
    "otel.generate_content": "generate_content",
    # Eden-native tool-call spans — FEAT-23. Previously absent, which
    # meant every tool call fell through to the "chat" default below.
    "tool.call": "execute_tool",
}


def derive_operation_name(event: Any) -> str:
    """Return the ``gen_ai.operation.name`` for a TelemetryEvent-like object.

    Precedence:

    1. Agent-to-agent hop — flagged either by a ``parent_agent_span_id``
       attribute or an ``a2a`` attribute sub-document (both set by
       ``wrap_a2a_invocation`` / ``build_a2a_attributes`` in
       ``eden.sdk.a2a``) — always ``"invoke_agent"``, regardless of
       ``event_type``.
    2. Exact ``event_type`` -> operation lookup (``_OPERATION_NAME_MAP``).
    3. ``otel.<operation>`` event types not already in the table fall
       back to ``<operation>`` verbatim (covers OTel GenAI operations
       Eden doesn't special-case yet, e.g. ``invoke_agent``,
       ``create_agent``) instead of being mislabeled as ``"chat"``.
    4. ``"chat"`` — matches pre-FEAT-23 behavior for everything else.
    """
    attributes = getattr(event, "attributes", None) or {}
    if attributes.get("parent_agent_span_id") or attributes.get("a2a"):
        return "invoke_agent"

    event_type = getattr(event, "event_type", None) or ""
    if event_type in _OPERATION_NAME_MAP:
        return _OPERATION_NAME_MAP[event_type]
    if event_type.startswith("otel."):
        suffix = event_type.split(".", 1)[1]
        if suffix:
            return suffix
    return "chat"
