"""Auto-instrumentation for the ``cohere`` Python SDK's Chat API v2.

Patches ``cohere.v2.client.V2Client.chat`` / ``.chat_stream`` and the
async counterparts on ``AsyncV2Client`` (both reachable through the
top-level ``cohere.ClientV2`` / ``cohere.AsyncClientV2`` exports,
which inherit from these classes). The legacy v1 Chat API
(``cohere.Client.chat`` / ``.chat_stream``, ``NonStreamedChatResponse``
with a ``meta.billed_units`` shape) is intentionally left to the
generic HTTP-capture path: v1 predates typed tool-calling and is
superseded by v2 in Cohere's own docs, and giving it a second,
differently-shaped native wrapper would double the surface this
module has to keep correct for no material benefit.

Response shape (verified against ``cohere.v2.types.v2chat_response.
V2ChatResponse`` / ``cohere.types.usage.Usage``):

  - ``V2ChatResponse`` has NO ``model`` field — unlike OpenAI/Groq/
    Mistral, the model is read back off the *request* kwargs instead.
  - ``usage.billed_units.{input_tokens,output_tokens}`` is the actual
    billed amount; ``usage.tokens.{input_tokens,output_tokens}`` is
    the raw (pre-billing) count. We report ``billed_units`` when
    present (matches what the customer is actually charged), falling
    back to ``tokens``.
  - ``usage.cached_tokens`` maps to ``cache_read_input_tokens``.
  - Tool calls live at ``message.tool_calls[].function.{name,arguments}``.

Streaming (``chat_stream``) yields a discriminated union of SSE-style
events (``type: "content-delta" | "tool-call-start" | "message-end" |
...``) rather than OpenAI-shaped chunks:

  - ``content-delta``: ``event.delta.message.content.text`` is the
    text token.
  - ``tool-call-start``: ``event.delta.message.tool_calls`` is a
    single ``ToolCallV2`` (one tool call per event, keyed by
    ``event.index``) — NOT a list, unlike OpenAI/Groq/Mistral's
    ``delta.tool_calls[]``.
  - ``message-end``: ``event.delta.usage`` / ``event.delta.finish_reason``
    carry the final usage + finish reason.
"""

from __future__ import annotations

import functools
import logging
import secrets
import time
from typing import Any

from eden_sdk._instrumentation_ids import _get_attr, _trace_id_or_random
from eden_sdk._tokens import extract_usage, normalize_model_name
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import TraceContext, current_span, current_trace

logger = logging.getLogger("eden_sdk.instrumentation.cohere")

_installed = False
_originals: dict[str, Any] = {}

_EMPTY_USAGE: dict[str, int | None] = {
    "input_tokens": None,
    "output_tokens": None,
    "cache_read_tokens": None,
    "cache_creation_tokens": None,
}


def install() -> None:
    """Patch the Cohere v2 sync/async Chat API in place."""
    global _installed
    if _installed:
        return
    try:
        from cohere.v2.client import AsyncV2Client, V2Client
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"cohere not importable: {exc}") from exc

    if "sync_chat" not in _originals:
        _originals["sync_chat"] = V2Client.chat
        V2Client.chat = _wrap_sync(_originals["sync_chat"])
    if "sync_chat_stream" not in _originals:
        _originals["sync_chat_stream"] = V2Client.chat_stream
        V2Client.chat_stream = _wrap_sync_stream_entry(_originals["sync_chat_stream"])
    if "async_chat" not in _originals:
        _originals["async_chat"] = AsyncV2Client.chat
        AsyncV2Client.chat = _wrap_async(_originals["async_chat"])
    if "async_chat_stream" not in _originals:
        _originals["async_chat_stream"] = AsyncV2Client.chat_stream
        AsyncV2Client.chat_stream = _wrap_async_stream_entry(_originals["async_chat_stream"])
    _installed = True
    logger.debug("eden: cohere v2 chat/chat_stream patched")


def uninstall() -> None:
    """Reverse the patches (used by tests and ``eden.uninstrument()``)."""
    global _installed
    if not _installed:
        return
    try:
        from cohere.v2.client import AsyncV2Client, V2Client
    except Exception:  # noqa: BLE001
        _installed = False
        _originals.clear()
        return
    if "sync_chat" in _originals:
        V2Client.chat = _originals["sync_chat"]
    if "sync_chat_stream" in _originals:
        V2Client.chat_stream = _originals["sync_chat_stream"]
    if "async_chat" in _originals:
        AsyncV2Client.chat = _originals["async_chat"]
    if "async_chat_stream" in _originals:
        AsyncV2Client.chat_stream = _originals["async_chat_stream"]
    _installed = False
    _originals.clear()


# ── Non-streaming ────────────────────────────────────────────────────


def _wrap_sync(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return original(self, *args, **kwargs)
        t0 = time.perf_counter()
        try:
            resp = original(self, *args, **kwargs)
            _enqueue_cohere_event(kwargs, resp, (time.perf_counter() - t0) * 1000.0, None)
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_cohere_event(kwargs, None, (time.perf_counter() - t0) * 1000.0, repr(exc))
            raise

    return wrapper


def _wrap_async(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return await original(self, *args, **kwargs)
        t0 = time.perf_counter()
        try:
            resp = await original(self, *args, **kwargs)
            _enqueue_cohere_event(kwargs, resp, (time.perf_counter() - t0) * 1000.0, None)
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_cohere_event(kwargs, None, (time.perf_counter() - t0) * 1000.0, repr(exc))
            raise

    return wrapper


def _extract_cohere_usage(usage: Any) -> dict[str, int | None]:
    """Normalize a Cohere v2 ``Usage`` object into the shared shape.

    Prefers ``billed_units`` (what the caller is actually charged
    for) over the raw ``tokens`` count; ``cached_tokens`` maps to
    ``cache_read_tokens``.
    """
    if usage is None:
        return dict(_EMPTY_USAGE)
    billed = _get_attr(usage, "billed_units")
    tokens = _get_attr(usage, "tokens")
    base = extract_usage(billed) if billed is not None else (extract_usage(tokens) if tokens is not None else dict(_EMPTY_USAGE))
    if base["cache_read_tokens"] is None:
        cached = _get_attr(usage, "cached_tokens")
        if isinstance(cached, (int, float)) and not isinstance(cached, bool):
            base = dict(base)
            base["cache_read_tokens"] = int(cached)
    return base


def _extract_tool_calls(message: Any) -> tuple[int, list[str]]:
    tool_calls = _get_attr(message, "tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return 0, []
    names: list[str] = []
    for tc in tool_calls:
        fn = _get_attr(tc, "function")
        name = _get_attr(fn, "name") if fn is not None else None
        if isinstance(name, str) and name:
            names.append(name)
    return len(tool_calls), names


def _enqueue_cohere_event(
    kwargs: dict[str, Any],
    response: Any,
    duration_ms: float,
    error: str | None,
) -> None:
    cfg = get_config()
    if not cfg.enabled:
        return
    # V2ChatResponse carries no `model` field — the request kwargs
    # are the only source of truth.
    model = kwargs.get("model")
    payload: dict[str, Any] = {
        "duration_ms": duration_ms,
        "request_payload": {k: v for k, v in kwargs.items() if k in (
            "model", "messages", "tools", "tool_choice", "temperature",
            "max_tokens", "p", "k", "seed", "stop_sequences",
            "presence_penalty", "frequency_penalty", "response_format",
            "safety_mode", "documents", "citation_options",
        )},
        "model": model,
        "model_normalized": normalize_model_name(model) if isinstance(model, str) else None,
    }
    if error is not None:
        payload["error"] = {"message": error}
        payload["outcome"] = "error"
    else:
        payload["outcome"] = "success"
    if response is not None:
        finish_reason = _get_attr(response, "finish_reason")
        if finish_reason:
            payload["finish_reason"] = finish_reason
        usage = _get_attr(response, "usage")
        u = _extract_cohere_usage(usage)
        payload["input_tokens"] = u["input_tokens"]
        payload["output_tokens"] = u["output_tokens"]
        payload["cache_read_input_tokens"] = u["cache_read_tokens"]
        message = _get_attr(response, "message")
        tool_call_count, tool_names = _extract_tool_calls(message)
        if tool_call_count:
            payload["tool_call_count"] = tool_call_count
            payload["tool_names"] = tool_names

    payload.setdefault("trace_id", _trace_id_or_random())
    payload.setdefault("span_id", secrets.token_hex(8))
    _cur = current_span()
    if _cur is not None:
        payload.setdefault("parent_span_id", _cur.span_id)
    if error is not None:
        attrs = payload.get("attributes")
        if not isinstance(attrs, dict):
            attrs = {}
            payload["attributes"] = attrs
        attrs.setdefault("error", error)
        attrs.setdefault("eden.error", error)
    trace_ctx: TraceContext | None = current_trace()
    if trace_ctx is not None:
        name = (trace_ctx.name or "").strip()
        if name and name != "trace":
            payload.setdefault("agent_id", name)

    get_default_client().enqueue(TraceEvent(payload=payload, source_format="cohere"))


# ── Streaming ─────────────────────────────────────────────────────────


def _wrap_sync_stream_entry(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return original(self, *args, **kwargs)
        return _wrap_sync_stream(original, self, args, kwargs)

    return wrapper


def _wrap_async_stream_entry(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return original(self, *args, **kwargs)
        return _wrap_async_stream(original, self, args, kwargs)

    return wrapper


def _wrap_sync_stream(original, self, args, kwargs):
    """Wrap a sync ``chat_stream`` call.

    Cohere's stream is a generator (not an awaitable-then-iterable
    like OpenAI/Groq), so ``chat_stream(...)`` itself returns the
    iterator directly — the wrapper is a plain generator function,
    not an async IIFE around ``original(...)``.
    """
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_cohere_{_uuid.uuid4().hex[:16]}"
    client = get_default_client()
    buffer = client._chunk_buffer if hasattr(client, "_chunk_buffer") else None
    _cap_text = bool(getattr(client.config, "capture_chunk_text", False))
    model = kwargs.get("model")

    def _gen():
        t_first = None
        t_prev = None
        t_last = start
        itl_sum = 0.0
        itl_count = 0
        chunk_count = 0
        output_tokens = 0
        finish_reason = None
        usage: dict[str, int | None] = dict(_EMPTY_USAGE)
        tool_call_names: dict[int, str] = {}
        status = "success"
        error_type = None
        try:
            upstream = original(self, *args, **kwargs)
            for event in upstream:
                chunk_count += 1
                now = time.perf_counter()
                t_last = now
                prev = t_prev
                if t_first is None:
                    t_first = now
                elif prev is not None:
                    itl_sum += now - prev
                    itl_count += 1
                t_prev = now

                etype = _get_attr(event, "type")
                text = None
                if etype == "content-delta":
                    delta = _get_attr(event, "delta")
                    msg = _get_attr(delta, "message") if delta is not None else None
                    content = _get_attr(msg, "content") if msg is not None else None
                    text = _get_attr(content, "text") if content is not None else None
                    if isinstance(text, str) and text:
                        output_tokens += max(1, len(text) // 4)
                elif etype == "tool-call-start":
                    idx = _get_attr(event, "index")
                    idx = idx if isinstance(idx, int) else 0
                    delta = _get_attr(event, "delta")
                    msg = _get_attr(delta, "message") if delta is not None else None
                    tc = _get_attr(msg, "tool_calls") if msg is not None else None
                    fn = _get_attr(tc, "function") if tc is not None else None
                    name = _get_attr(fn, "name") if fn is not None else None
                    if isinstance(name, str) and name:
                        tool_call_names[idx] = name
                elif etype == "message-end":
                    delta = _get_attr(event, "delta")
                    fr = _get_attr(delta, "finish_reason") if delta is not None else None
                    if fr:
                        finish_reason = fr
                    ev_usage = _get_attr(delta, "usage") if delta is not None else None
                    if ev_usage is not None:
                        usage = _extract_cohere_usage(ev_usage)

                if buffer is not None:
                    tpot_ms = None
                    if prev is not None and isinstance(text, str) and text:
                        tpot_ms = ((now - prev) * 1000.0) / max(1, (len(text) + 3) // 4)
                    buffer.append({
                        "event_id": stream_event_id,
                        "trace_id": trace_id,
                        "chunk_index": chunk_count - 1,
                        "delta_text": (text if isinstance(text, str) else None) if _cap_text else None,
                        "ttft_ms": (t_first - start) * 1000.0 if t_first is not None else None,
                        "itl_ms": (now - prev) * 1000.0 if prev is not None else None,
                        "tpot_ms": tpot_ms,
                        "received_at_client_ms": int(time.time() * 1000),
                    })
                yield event
        except Exception as exc:
            status = "error"
            error_type = type(exc).__name__
            raise
        finally:
            if isinstance(usage.get("output_tokens"), int) and usage["output_tokens"] > 0:
                output_tokens = usage["output_tokens"]
            ttft_ms = (t_first - start) * 1000.0 if t_first is not None else 0.0
            completion_ms = (t_last - start) * 1000.0
            itl_avg = (itl_sum / itl_count * 1000.0) if itl_count > 0 else 0.0
            tpot = ((completion_ms - ttft_ms) / (output_tokens - 1)) if output_tokens > 1 else 0.0
            payload = {
                "event_id": stream_event_id,
                "trace_id": trace_id,
                "duration_ms": completion_ms,
                "stream": True,
                "chunk_count": chunk_count,
                "ttft_ms": ttft_ms,
                "itl_ms_avg": itl_avg,
                "tpot_ms": tpot,
                "completion_duration_ms": completion_ms,
                "output_tokens": output_tokens,
                "input_tokens": usage["input_tokens"],
                "cache_read_input_tokens": usage["cache_read_tokens"],
                "finish_reason": finish_reason,
                "tool_call_count": len(tool_call_names),
                "tool_names": list(tool_call_names.values()),
                "model": model,
                "model_normalized": normalize_model_name(model) if isinstance(model, str) else None,
                "outcome": status,
                "error_type": error_type,
            }
            cfg = get_config()
            if cfg.enabled:
                get_default_client().enqueue(TraceEvent(payload=payload, source_format="cohere"))

    return _gen()


def _wrap_async_stream(original, self, args, kwargs):
    """Async variant of :func:`_wrap_sync_stream`."""
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_cohere_{_uuid.uuid4().hex[:16]}"
    client = get_default_client()
    buffer = client._chunk_buffer if hasattr(client, "_chunk_buffer") else None
    _cap_text = bool(getattr(client.config, "capture_chunk_text", False))
    model = kwargs.get("model")

    async def _agen():
        t_first = None
        t_prev = None
        t_last = start
        itl_sum = 0.0
        itl_count = 0
        chunk_count = 0
        output_tokens = 0
        finish_reason = None
        usage: dict[str, int | None] = dict(_EMPTY_USAGE)
        tool_call_names: dict[int, str] = {}
        status = "success"
        error_type = None
        try:
            upstream = original(self, *args, **kwargs)
            async for event in upstream:
                chunk_count += 1
                now = time.perf_counter()
                t_last = now
                prev = t_prev
                if t_first is None:
                    t_first = now
                elif prev is not None:
                    itl_sum += now - prev
                    itl_count += 1
                t_prev = now

                etype = _get_attr(event, "type")
                text = None
                if etype == "content-delta":
                    delta = _get_attr(event, "delta")
                    msg = _get_attr(delta, "message") if delta is not None else None
                    content = _get_attr(msg, "content") if msg is not None else None
                    text = _get_attr(content, "text") if content is not None else None
                    if isinstance(text, str) and text:
                        output_tokens += max(1, len(text) // 4)
                elif etype == "tool-call-start":
                    idx = _get_attr(event, "index")
                    idx = idx if isinstance(idx, int) else 0
                    delta = _get_attr(event, "delta")
                    msg = _get_attr(delta, "message") if delta is not None else None
                    tc = _get_attr(msg, "tool_calls") if msg is not None else None
                    fn = _get_attr(tc, "function") if tc is not None else None
                    name = _get_attr(fn, "name") if fn is not None else None
                    if isinstance(name, str) and name:
                        tool_call_names[idx] = name
                elif etype == "message-end":
                    delta = _get_attr(event, "delta")
                    fr = _get_attr(delta, "finish_reason") if delta is not None else None
                    if fr:
                        finish_reason = fr
                    ev_usage = _get_attr(delta, "usage") if delta is not None else None
                    if ev_usage is not None:
                        usage = _extract_cohere_usage(ev_usage)

                if buffer is not None:
                    tpot_ms = None
                    if prev is not None and isinstance(text, str) and text:
                        tpot_ms = ((now - prev) * 1000.0) / max(1, (len(text) + 3) // 4)
                    buffer.append({
                        "event_id": stream_event_id,
                        "trace_id": trace_id,
                        "chunk_index": chunk_count - 1,
                        "delta_text": (text if isinstance(text, str) else None) if _cap_text else None,
                        "ttft_ms": (t_first - start) * 1000.0 if t_first is not None else None,
                        "itl_ms": (now - prev) * 1000.0 if prev is not None else None,
                        "tpot_ms": tpot_ms,
                        "received_at_client_ms": int(time.time() * 1000),
                    })
                yield event
        except Exception as exc:
            status = "error"
            error_type = type(exc).__name__
            raise
        finally:
            if isinstance(usage.get("output_tokens"), int) and usage["output_tokens"] > 0:
                output_tokens = usage["output_tokens"]
            ttft_ms = (t_first - start) * 1000.0 if t_first is not None else 0.0
            completion_ms = (t_last - start) * 1000.0
            itl_avg = (itl_sum / itl_count * 1000.0) if itl_count > 0 else 0.0
            tpot = ((completion_ms - ttft_ms) / (output_tokens - 1)) if output_tokens > 1 else 0.0
            payload = {
                "event_id": stream_event_id,
                "trace_id": trace_id,
                "duration_ms": completion_ms,
                "stream": True,
                "chunk_count": chunk_count,
                "ttft_ms": ttft_ms,
                "itl_ms_avg": itl_avg,
                "tpot_ms": tpot,
                "completion_duration_ms": completion_ms,
                "output_tokens": output_tokens,
                "input_tokens": usage["input_tokens"],
                "cache_read_input_tokens": usage["cache_read_tokens"],
                "finish_reason": finish_reason,
                "tool_call_count": len(tool_call_names),
                "tool_names": list(tool_call_names.values()),
                "model": model,
                "model_normalized": normalize_model_name(model) if isinstance(model, str) else None,
                "outcome": status,
                "error_type": error_type,
            }
            cfg = get_config()
            if cfg.enabled:
                get_default_client().enqueue(TraceEvent(payload=payload, source_format="cohere"))

    return _agen()
