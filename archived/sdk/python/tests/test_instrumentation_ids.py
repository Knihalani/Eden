"""Tests for the shared instrumentation id + dict-access helpers.

These helpers used to be copy-pasted into every per-framework
instrumentation file (``openai``, ``anthropic``, ``langchain``,
``crewai``, ``autogen``, ``llama_index``) -- six files, identical
bodies. The dedup into ``eden_sdk._instrumentation_ids`` is a
single source of truth for the ``trace_id`` shape the gateway
joins on, plus a small ``_get_attr`` that handles both Pydantic
and dict shapes for streaming chunks.

These tests pin:
  * the wire-shape of the trace id (``uuid4().hex``),
  * that an active trace context short-circuits the random path,
  * that ``_get_attr`` handles both dict and object shapes,
  * that ``None`` is returned for ``None`` input (used pervasively
    in streaming chunk extractors where a field may be missing).
"""

from __future__ import annotations

import re
import uuid
from types import SimpleNamespace

from eden_sdk._instrumentation_ids import _get_attr, _trace_id_or_random
from eden_sdk.trace import TraceContext, _active_trace, current_trace


def test_trace_id_or_random_returns_uuid_hex_when_no_context():
    """No active trace context -> a fresh ``uuid4().hex``.

    The shape (32 lowercase hex chars) is the wire contract --
    changing it would break the gateway's SQL filter on the
    ``trace_id`` column.
    """
    assert current_trace() is None
    tid = _trace_id_or_random()
    assert re.fullmatch(r"[0-9a-f]{32}", tid), tid
    # Two consecutive calls produce different ids (no caching).
    assert _trace_id_or_random() != tid


def test_trace_id_or_random_uses_active_context():
    """When a TraceContext is active, the helper returns its
    ``trace_id`` -- so a framework event can be joined with the
    LLM event on the gateway side.
    """
    expected = uuid.uuid4().hex
    ctx = TraceContext(trace_id=expected, name="t", start=0.0, attributes={})
    token = _active_trace.set(ctx)
    try:
        assert _trace_id_or_random() == expected
    finally:
        _active_trace.reset(token)


def test_get_attr_returns_none_for_none_input():
    """Streaming chunk extractors pass ``chunk.usage`` (may be
    missing). The helper must return ``None`` instead of raising
    so the caller's ``or {}`` / ``or None`` fallback chain works.
    """
    assert _get_attr(None, "anything") is None


def test_get_attr_dict_shape():
    """Plain dict access for OpenAI-style streaming chunks."""
    d = {"model": "gpt-4o", "usage": {"prompt_tokens": 10}}
    assert _get_attr(d, "model") == "gpt-4o"
    assert _get_attr(d, "usage") == {"prompt_tokens": 10}
    assert _get_attr(d, "missing") is None


def test_get_attr_object_shape():
    """Attribute access for Pydantic / SimpleNamespace shapes
    (Anthropic's streaming event objects, LangChain's
    ``AIMessageChunk``, etc.)."""
    obj = SimpleNamespace(model="claude-3-5-sonnet", usage=None)
    assert _get_attr(obj, "model") == "claude-3-5-sonnet"
    assert _get_attr(obj, "usage") is None
    assert _get_attr(obj, "missing") is None
