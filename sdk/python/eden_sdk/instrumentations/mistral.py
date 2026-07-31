"""Auto-instrumentation for the ``mistralai`` Python SDK.

Only ``mistralai>=2.0`` is supported. The ``mistralai`` PyPI package
did a structural rewrite between 1.x and 2.x: as of 2.x, ``mistralai``
itself is a PEP 420 namespace package with no importable classes of
its own — the actual client lives under ``mistralai.client`` (with
sibling ``mistralai.azure`` / ``mistralai.gcp`` namespaces for those
deployment variants). ``Chat`` moved from ``mistralai.chat.Chat``
(1.x) to ``mistralai.client.chat.Chat`` (2.x); this module targets the
2.x path only (verified against an installed ``mistralai==2.7.2``).

Patches ``mistralai.client.chat.Chat.complete`` / ``.complete_async``
/ ``.stream`` / ``.stream_async`` — the four entry points reachable
via ``Mistral(...).chat.complete(...)`` etc. (``Mistral`` itself is
imported as ``from mistralai.client import Mistral`` in 2.x, not
``from mistralai import Mistral``.)

Response shape (verified against ``mistralai.client.models.usageinfo.
UsageInfo`` / ``mistralai.client.models.chatcompletionresponse.
ChatCompletionResponse``): usage uses OpenAI-shaped snake_case keys
(``prompt_tokens`` / ``completion_tokens`` / ``total_tokens``)
directly — no provider-specific remapping needed, unlike Cohere.

Streaming (``chat.stream``) differs from OpenAI/Groq in one
structural way: it returns an ``EventStream[CompletionEvent]`` whose
items are ``CompletionEvent`` wrappers — the actual OpenAI-shaped
chunk lives at ``event.data`` (``mistralai.client.models.
completionchunk.CompletionChunk``: ``choices[].delta.content``,
``usage``, ``model``), not on the event itself. Tool calls surface at
``message.tool_calls[].function.{name,arguments}`` (non-streaming)
and accumulate incrementally on ``delta.tool_calls[].function.name``
keyed by ``index`` (streaming) — same shape as OpenAI/Groq.
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

logger = logging.getLogger("eden_sdk.instrumentation.mistral")

_installed = False
_originals: dict[str, Any] = {}

_REQUEST_KWARGS = (
    "model", "temperature", "top_p", "max_tokens", "stream", "stop",
    "random_seed", "response_format", "tools", "tool_choice",
    "presence_penalty", "frequency_penalty", "n", "parallel_tool_calls",
    "safe_prompt",
)


def install() -> None:
    """Patch ``mistralai.client.chat.Chat``'s complete/stream methods in place."""
    global _installed
    if _installed:
        return
    try:
        from mistralai.client.chat import Chat
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"mistralai not importable: {exc}") from exc

    if "complete" not in _originals:
        _originals["complete"] = Chat.complete
        Chat.complete = _wrap_sync(_originals["complete"])
    if "complete_async" not in _originals:
        _originals["complete_async"] = Chat.complete_async
        Chat.complete_async = _wrap_async(_originals["complete_async"])
    if "stream" not in _originals:
        _originals["stream"] = Chat.stream
        Chat.stream = _wrap_stream_entry(_originals["stream"])
    if "stream_async" not in _originals:
        _originals["stream_async"] = Chat.stream_async
        Chat.stream_async = _wrap_stream_async_entry(_originals["stream_async"])
    _installed = True
    logger.debug("eden: mistralai chat.complete/stream patched")


def uninstall() -> None:
    """Reverse the patches (used by tests and ``eden.uninstrument()``)."""
    global _installed
    if not _installed:
        return
    try:
        from mistralai.client.chat import Chat
    except Exception:  # noqa: BLE001
        _installed = False
        _originals.clear()
        return
    if "complete" in _originals:
        Chat.complete = _originals["complete"]
    if "complete_async" in _originals:
        Chat.complete_async = _originals["complete_async"]
    if "stream" in _originals:
        Chat.stream = _originals["stream"]
    if "stream_async" in _originals:
        Chat.stream_async = _originals["stream_async"]
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
            _enqueue_mistral_event(kwargs, resp, (time.perf_counter() - t0) * 1000.0, None)
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_mistral_event(kwargs, None, (time.perf_counter() - t0) * 1000.0, repr(exc))
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
            _enqueue_mistral_event(kwargs, resp, (time.perf_counter() - t0) * 1000.0, None)
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_mistral_event(kwargs, None, (time.perf_counter() - t0) * 1000.0, repr(exc))
            raise

    return wrapper


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


def _enqueue_mistral_event(
    kwargs: dict[str, Any],
    response: Any,
    duration_ms: float,
    error: str | None,
) -> None:
    cfg = get_config()
    if not cfg.enabled:
        return
    request_model = kwargs.get("model")
    payload: dict[str, Any] = {
        "duration_ms": duration_ms,
        "request_payload": {k: v for k, v in kwargs.items() if k in _REQUEST_KWARGS},
    }
    if error is not None:
        payload["error"] = {"message": error}
        payload["outcome"] = "error"
        payload["model"] = request_model
        payload["model_normalized"] = normalize_model_name(request_model) if isinstance(request_model, str) else None
    else:
        payload["outcome"] = "success"
        model = _get_attr(response, "model") if response is not None else None
        model = model if isinstance(model, str) else request_model
        payload["model"] = model
        payload["model_normalized"] = normalize_model_name(model) if isinstance(model, str) else None
        usage = _get_attr(response, "usage") if response is not None else None
        u = extract_usage(usage) if usage is not None else {
            "input_tokens": None, "output_tokens": None,
            "cache_read_tokens": None, "cache_creation_tokens": None,
        }
        payload["input_tokens"] = u["input_tokens"]
        payload["output_tokens"] = u["output_tokens"]
        choices = _get_attr(response, "choices") if response is not None else None
        if isinstance(choices, list) and choices:
            message = _get_attr(choices[0], "message")
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

    get_default_client().enqueue(TraceEvent(payload=payload, source_format="mistral"))


# ── Streaming ─────────────────────────────────────────────────────────


def _wrap_stream_entry(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return original(self, *args, **kwargs)
        return _wrap_sync_stream(original, self, args, kwargs)

    return wrapper


def _wrap_stream_async_entry(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return await original(self, *args, **kwargs)
        # ``stream_async`` itself is a plain ``async def`` that
        # returns an ``EventStreamAsync`` (not an async generator),
        # so we await it here and hand the resolved stream to an
        # async-generator wrapper — mirrors the OpenAI SDK's
        # ``_wrap_async_stream`` shape.
        upstream = await original(self, *args, **kwargs)
        return _wrap_async_stream(upstream, kwargs)

    return wrapper


def _unwrap_chunk(event: Any) -> Any:
    """Mistral's streamed items are ``CompletionEvent`` wrappers —
    the actual OpenAI-shaped chunk lives at ``event.data``."""
    data = _get_attr(event, "data")
    return data if data is not None else event


def _wrap_sync_stream(original, self, args, kwargs):
    """Wrap a sync ``chat.stream(...)`` call.

    ``stream()`` returns an ``EventStream`` (a plain iterable, not a
    generator function) — the upstream HTTP call is made eagerly
    when ``original(...)`` is invoked, same as OpenAI's ``create()``
    with ``stream=True``.
    """
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_mistral_{_uuid.uuid4().hex[:16]}"
    client = get_default_client()
    buffer = client._chunk_buffer if hasattr(client, "_chunk_buffer") else None
    _cap_text = bool(getattr(client.config, "capture_chunk_text", False))
    request_model = kwargs.get("model")

    def _gen():
        model = None
        t_first = None
        t_prev = None
        t_last = start
        itl_sum = 0.0
        itl_count = 0
        chunk_count = 0
        output_tokens = 0
        usage_output_tokens = None
        usage_input_tokens = None
        finish_reason = None
        tool_call_names: dict[int, str] = {}
        status = "success"
        error_type = None
        try:
            upstream = original(self, *args, **kwargs)
            for event in upstream:
                chunk = _unwrap_chunk(event)
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
                choices = _get_attr(chunk, "choices") or []
                text = None
                if choices:
                    first = choices[0]
                    delta = _get_attr(first, "delta") or {}
                    text = _get_attr(delta, "content")
                    if isinstance(text, str) and text:
                        output_tokens += max(1, len(text) // 4)
                    fr = _get_attr(first, "finish_reason")
                    if fr:
                        finish_reason = fr
                    delta_tool_calls = _get_attr(delta, "tool_calls")
                    if isinstance(delta_tool_calls, list):
                        for tc in delta_tool_calls:
                            idx = _get_attr(tc, "index")
                            idx = idx if isinstance(idx, int) else 0
                            fn = _get_attr(tc, "function")
                            name = _get_attr(fn, "name") if fn is not None else None
                            if isinstance(name, str) and name and idx not in tool_call_names:
                                tool_call_names[idx] = name
                if not model:
                    m = _get_attr(chunk, "model")
                    if isinstance(m, str):
                        model = m
                usage = _get_attr(chunk, "usage")
                if usage is not None:
                    u = extract_usage(usage)
                    if u["output_tokens"] is not None and u["output_tokens"] > 0:
                        usage_output_tokens = u["output_tokens"]
                    if u["input_tokens"] is not None:
                        usage_input_tokens = u["input_tokens"]
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
            if isinstance(usage_output_tokens, int):
                output_tokens = usage_output_tokens
            final_model = model or request_model
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
                "input_tokens": usage_input_tokens,
                "finish_reason": finish_reason,
                "tool_call_count": len(tool_call_names),
                "tool_names": list(tool_call_names.values()),
                "model": final_model,
                "model_normalized": normalize_model_name(final_model) if isinstance(final_model, str) else None,
                "outcome": status,
                "error_type": error_type,
            }
            cfg = get_config()
            if cfg.enabled:
                get_default_client().enqueue(TraceEvent(payload=payload, source_format="mistral"))

    return _gen()


async def _wrap_async_stream(upstream, kwargs):
    """Async variant of :func:`_wrap_sync_stream`.

    Takes the already-resolved ``EventStreamAsync`` (the caller has
    already awaited ``stream_async(...)``) and returns an async
    generator that replays it while buffering metrics.
    """
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_mistral_{_uuid.uuid4().hex[:16]}"
    client = get_default_client()
    buffer = client._chunk_buffer if hasattr(client, "_chunk_buffer") else None
    _cap_text = bool(getattr(client.config, "capture_chunk_text", False))
    request_model = kwargs.get("model")

    model = None
    t_first = None
    t_prev = None
    t_last = start
    itl_sum = 0.0
    itl_count = 0
    chunk_count = 0
    output_tokens = 0
    usage_output_tokens = None
    usage_input_tokens = None
    finish_reason = None
    tool_call_names: dict[int, str] = {}
    status = "success"
    error_type = None
    try:
        async for event in upstream:
            chunk = _unwrap_chunk(event)
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
            choices = _get_attr(chunk, "choices") or []
            text = None
            if choices:
                first = choices[0]
                delta = _get_attr(first, "delta") or {}
                text = _get_attr(delta, "content")
                if isinstance(text, str) and text:
                    output_tokens += max(1, len(text) // 4)
                fr = _get_attr(first, "finish_reason")
                if fr:
                    finish_reason = fr
                delta_tool_calls = _get_attr(delta, "tool_calls")
                if isinstance(delta_tool_calls, list):
                    for tc in delta_tool_calls:
                        idx = _get_attr(tc, "index")
                        idx = idx if isinstance(idx, int) else 0
                        fn = _get_attr(tc, "function")
                        name = _get_attr(fn, "name") if fn is not None else None
                        if isinstance(name, str) and name and idx not in tool_call_names:
                            tool_call_names[idx] = name
            if not model:
                m = _get_attr(chunk, "model")
                if isinstance(m, str):
                    model = m
            usage = _get_attr(chunk, "usage")
            if usage is not None:
                u = extract_usage(usage)
                if u["output_tokens"] is not None and u["output_tokens"] > 0:
                    usage_output_tokens = u["output_tokens"]
                if u["input_tokens"] is not None:
                    usage_input_tokens = u["input_tokens"]
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
        if isinstance(usage_output_tokens, int):
            output_tokens = usage_output_tokens
        final_model = model or request_model
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
            "input_tokens": usage_input_tokens,
            "finish_reason": finish_reason,
            "tool_call_count": len(tool_call_names),
            "tool_names": list(tool_call_names.values()),
            "model": final_model,
            "model_normalized": normalize_model_name(final_model) if isinstance(final_model, str) else None,
            "outcome": status,
            "error_type": error_type,
        }
        cfg = get_config()
        if cfg.enabled:
            get_default_client().enqueue(TraceEvent(payload=payload, source_format="mistral"))
