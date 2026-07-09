"""Shared id + dict-access helpers for the per-framework instrumentations.

Previously each instrumentation (``openai``, ``anthropic``,
``langchain``, ``crewai``, ``autogen``, ``llama_index``) carried
its own copy of ``_trace_id_or_random`` — five files, identical
bodies. Two of them (OpenAI + Anthropic) also carried a copy of
``_get_attr``.

Duplicated code is a divergence hazard: a fix to one copy
(e.g. switching the random source to ``secrets.token_hex`` for
cryptographic randomness, or changing the trace-context lookup
to honour a contextvar) would silently leave the others emitting
a different ``trace_id`` on the wire. Extracted here so the six
instrumentations share a single source of truth. The wire shape
is unchanged — existing downstream consumers (gateway's
``trace_id`` + ``event_id`` columns, the portal's URL fragments)
keep working without any contract change.

Mirrors ``sdk/ts-ai/src/ids.ts``, which holds the TypeScript
SDK's equivalent shared helpers.
"""

from __future__ import annotations

import uuid
from typing import Any

from eden_sdk.trace import current_trace


def _trace_id_or_random() -> str:
    """Return the active trace id, or a fresh random one.

    Centralised so callers don't have to handle the Optional
    return type of :func:`current_trace` (mypy-friendly).
    Reuses the per-event trace id when one is active so the
    framework event can be joined with the LLM event in the
    gateway's SQL filter (``WHERE trace_id = ?``).
    """
    ctx = current_trace()
    return ctx.trace_id if ctx is not None else uuid.uuid4().hex


def _get_attr(obj: Any, name: str) -> Any:
    """Look up a field on either a dict or an attribute-bearing object.

    Many upstream SDKs return Pydantic models (``SimpleNamespace``,
    ``BaseModel``) for streaming chunks but plain dicts elsewhere
    in the same response. A naive ``getattr`` raises on the dict
    path and a naive ``obj[name]`` raises on the model path. The
    shared helper handles both shapes with a single signature.
    """
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


__all__ = ["_trace_id_or_random", "_get_attr"]
