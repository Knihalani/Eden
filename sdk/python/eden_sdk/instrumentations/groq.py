"""Auto-instrumentation for the ``groq`` Python SDK.

Groq's official SDK (`groq` on PyPI) is a Stainless-generated client
whose ``chat.completions.create`` surface is byte-for-byte shaped like
OpenAI's — same request/response schema (verified against
``groq.types.chat.chat_completion.ChatCompletion`` /
``groq.types.completion_usage.CompletionUsage``: ``prompt_tokens`` /
``completion_tokens`` / ``total_tokens``, identical to OpenAI's
naming), same streaming chunk shape
(``groq.types.chat.chat_completion_chunk.ChatCompletionChunk``).
Previously Groq calls were only reachable via the generic
host-sniffing HTTP-capture path (no structured streaming-delta
parsing, no tool-call parsing, no per-field usage extraction). This
module patches Groq's own ``chat.completions.create`` directly —
mirroring ``openai.py`` — rather than aliasing through the OpenAI
instrumentor, so a Groq-specific response field (``x_groq``,
``usage_breakdown``) can be added here without touching the OpenAI
patch.

Streaming calls (``stream=True``) are wrapped so each chunk is
buffered to ``/ingest/chunks`` (TTFT, ITL, TPOT, output-token
estimates) and a single ``llm_completion_stream`` event lands at the
``groq`` endpoint when the iterator exhausts. Tool calls
(``message.tool_calls`` non-streaming / ``delta.tool_calls`` streaming)
are counted and their function names collected onto the emitted
payload. The patch is best-effort: failures inside the
instrumentation never propagate into user code.
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

logger = logging.getLogger("eden_sdk.instrumentation.groq")

_installed = False
_original_sync_create: Any | None = None
_original_async_create: Any | None = None


def install() -> None:
    """Patch the Groq sync/async ChatCompletion creators in place."""
    global _installed, _original_sync_create, _original_async_create
    if _installed:
        return
    try:
        from groq.resources.chat import completions as chat_completions
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"groq not importable: {exc}") from exc

    if _original_sync_create is None:
        _original_sync_create = chat_completions.Completions.create
        chat_completions.Completions.create = _wrap_sync(_original_sync_create)
    if _original_async_create is None:
        _original_async_create = chat_completions.AsyncCompletions.create
        chat_completions.AsyncCompletions.create = _wrap_async(_original_async_create)
    _installed = True
    logger.debug("eden: groq chat.completions.create patched")


def uninstall() -> None:
    """Reverse the patches (used by tests and ``eden.uninstrument()``)."""
    global _installed, _original_sync_create, _original_async_create
    if not _installed:
        return
    try:
        from groq.resources.chat import completions as chat_completions
    except Exception:  # noqa: BLE001
        _installed = False
        _original_sync_create = None
        _original_async_create = None
        return
    if _original_sync_create is not None:
        chat_completions.Completions.create = _original_sync_create
    if _original_async_create is not None:
        chat_completions.AsyncCompletions.create = _original_async_create
    _installed = False
    _original_sync_create = None
    _original_async_create = None


# ── Wrappers ─────────────────────────────────────────────────────────


def _wrap_sync(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return original(self, *args, **kwargs)
        if _is_stream_request(args, kwargs):
            return _wrap_sync_stream(original, self, args, kwargs)
        t0 = time.perf_counter()
        request_payload = _build_request_payload(args, kwargs)
        try:
            resp = original(self, *args, **kwargs)
            resp_dict = _to_dict(resp)
            _enqueue_groq_event(
                request_payload=request_payload,
                response_payload=resp_dict,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
            )
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_groq_event(
                request_payload=request_payload,
                response_payload=None,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=repr(exc),
            )
            raise

    return wrapper


def _wrap_async(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return await original(self, *args, **kwargs)
        if _is_stream_request(args, kwargs):
            return _wrap_async_stream(original, self, args, kwargs)
        t0 = time.perf_counter()
        request_payload = _build_request_payload(args, kwargs)
        try:
            resp = await original(self, *args, **kwargs)
            resp_dict = _to_dict(resp)
            _enqueue_groq_event(
                request_payload=request_payload,
                response_payload=resp_dict,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
            )
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_groq_event(
                request_payload=request_payload,
                response_payload=None,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=repr(exc),
            )
            raise

    return wrapper


# ── Helpers ───────────────────────────────────────────────────────────


def _build_request_payload(args: tuple, kwargs: dict) -> dict[str, Any]:
    """Extract a serializable dict of the original request.

    ``messages`` is read from ``kwargs``: the Groq SDK, like OpenAI's, declares
    ``create()`` with keyword-only parameters, so ``args`` is empty on every
    real call. Before the 2026-07 remediation ``messages`` appeared only in the
    positional branch below and was missing from this allow-list, so every
    captured Groq span carried settings and no prompt. Same defect as
    ``openai.py`` had; ``anthropic.py`` was always correct. Keep all three
    in step.
    """
    out: dict[str, Any] = {}
    if args:
        out["messages"] = _to_dict(args[0]) if len(args) == 1 else _to_dict(args)
    for k in ("messages", "model", "temperature", "top_p", "max_tokens",
              "max_completion_tokens",
              "tools", "tool_choice", "stream", "user", "response_format",
              "seed", "stop", "presence_penalty", "frequency_penalty", "n",
              "parallel_tool_calls", "reasoning_format", "reasoning_effort",
              "service_tier"):
        if k in kwargs:
            out[k] = _to_dict(kwargs[k])
    return out


def _to_dict(obj: Any) -> Any:
    """Best-effort recursive conversion of pydantic / dataclass / dict to a dict.

    Mirrors ``openai.py``'s ``_to_dict`` — recurses into nested values
    so a Pydantic model containing other Pydantic models ends up as a
    flat ``dict`` of plain Python primitives (which is also how
    ``message.tool_calls`` naturally surfaces on the wire: no special
    tool-call serialisation is needed, the generic recursion handles
    it).
    """
    if obj is None:
        return None
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_dict(v) for v in obj]
    if hasattr(obj, "model_dump"):
        try:
            return _to_dict(obj.model_dump())
        except Exception:  # noqa: BLE001
            pass
    if hasattr(obj, "to_dict"):
        try:
            return _to_dict(obj.to_dict())
        except Exception:  # noqa: BLE001
            pass
    if hasattr(obj, "__dict__"):
        try:
            return {k: _to_dict(v) for k, v in obj.__dict__.items()
                    if not k.startswith("_")}
        except Exception:  # noqa: BLE001
            pass
    return obj


def _extract_tool_calls(response_payload: dict[str, Any] | None) -> tuple[int, list[str]]:
    """Return ``(tool_call_count, tool_names)`` from a non-streaming response dict."""
    if not response_payload:
        return 0, []
    choices = response_payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return 0, []
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    tool_calls = message.get("tool_calls") if isinstance(message, dict) else None
    if not isinstance(tool_calls, list):
        return 0, []
    names = [
        tc["function"]["name"]
        for tc in tool_calls
        if isinstance(tc, dict) and isinstance(tc.get("function"), dict) and tc["function"].get("name")
    ]
    return len(tool_calls), names


def _enqueue_groq_event(
    request_payload: dict[str, Any],
    response_payload: dict[str, Any] | None,
    duration_ms: float,
    error: str | None,
) -> None:
    cfg = get_config()
    if not cfg.enabled:
        return
    payload: dict[str, Any] = {
        "duration_ms": duration_ms,
        "request_payload": request_payload,
    }
    if error is not None:
        payload["error"] = {"message": error}
    if response_payload is not None:
        payload.update(response_payload)
        payload.setdefault("request_payload", request_payload)
        m = payload.get("model")
        if isinstance(m, str):
            payload["model_normalized"] = normalize_model_name(m)
        # Groq's `CompletionUsage` names (`prompt_tokens` /
        # `completion_tokens`) match OpenAI's exactly, but we still
        # flatten into `input_tokens` / `output_tokens` explicitly
        # (rather than relying on callers to dig into the nested
        # `usage` object) so downstream billing rollups see the same
        # flat fields the streaming path and every other native
        # instrumentor (Cohere, Mistral, Bedrock, Gemini) already emit.
        usage = response_payload.get("usage")
        if usage:
            u = extract_usage(usage)
            if u["input_tokens"] is not None:
                payload["input_tokens"] = u["input_tokens"]
            if u["output_tokens"] is not None:
                payload["output_tokens"] = u["output_tokens"]
            if u["cache_read_tokens"] is not None:
                payload["cache_read_input_tokens"] = u["cache_read_tokens"]
        tool_call_count, tool_names = _extract_tool_calls(response_payload)
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

    get_default_client().enqueue(TraceEvent(payload=payload, source_format="groq"))


# ── Streaming ─────────────────────────────────────────────────────────


def _is_stream_request(args: tuple, kwargs: dict) -> bool:
    if kwargs.get("stream"):
        return True
    if args and isinstance(args[0], dict) and args[0].get("stream"):
        return True
    return False


def _wrap_sync_stream(original, self, args, kwargs):
    """Wrap a sync streaming ``create`` call.

    Returns a generator that yields upstream chunks while buffering
    per-chunk metrics into ``/ingest/chunks``. On iterator exhaustion
    one ``llm_completion_stream`` event is enqueued for the ``groq``
    endpoint with TTFT/ITL/TPOT/output-token estimates and any
    accumulated tool-call names.
    """
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_groq_{_uuid.uuid4().hex[:16]}"
    client = get_default_client()
    buffer = client._chunk_buffer if hasattr(client, "_chunk_buffer") else None
    _cap_text = bool(getattr(client.config, "capture_chunk_text", False))

    def _gen():
        model = _extract_model(kwargs)
        t_first = None
        t_prev = None
        t_last = start
        itl_sum = 0.0
        itl_count = 0
        chunk_count = 0
        output_tokens = 0
        usage_output_tokens = None
        usage_input_tokens = None
        usage_cache_read = None
        finish_reason = None
        # Groq (like OpenAI) streams each tool call's name/arguments
        # incrementally across multiple chunks, keyed by ``index``.
        tool_call_names: dict[int, str] = {}
        status = "success"
        error_type = None
        try:
            upstream = original(self, *args, **kwargs)
            for chunk in upstream:
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
                    if u["cache_read_tokens"] is not None:
                        usage_cache_read = u["cache_read_tokens"]
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
                yield chunk
        except Exception as exc:
            status = "error"
            error_type = type(exc).__name__
            raise
        finally:
            if isinstance(usage_output_tokens, int):
                output_tokens = usage_output_tokens
            ttft_ms = (t_first - start) * 1000.0 if t_first is not None else 0.0
            completion_ms = (t_last - start) * 1000.0
            itl_avg = (itl_sum / itl_count * 1000.0) if itl_count > 0 else 0.0
            tpot = ((completion_ms - ttft_ms) / (output_tokens - 1)) if output_tokens > 1 else 0.0
            payload = {
                "event_id": stream_event_id,
                "trace_id": trace_id,
                "duration_ms": completion_ms,
                "request_payload": _build_request_payload(args, kwargs),
                "stream": True,
                "chunk_count": chunk_count,
                "ttft_ms": ttft_ms,
                "itl_ms_avg": itl_avg,
                "tpot_ms": tpot,
                "completion_duration_ms": completion_ms,
                "output_tokens": output_tokens,
                "input_tokens": usage_input_tokens,
                "cache_read_input_tokens": usage_cache_read,
                "finish_reason": finish_reason,
                "tool_call_count": len(tool_call_names),
                "tool_names": list(tool_call_names.values()),
                "model": model,
                "model_normalized": normalize_model_name(model),
                "outcome": status,
                "error_type": error_type,
            }
            cfg = get_config()
            if cfg.enabled:
                get_default_client().enqueue(TraceEvent(payload=payload, source_format="groq"))

    return _gen()


def _wrap_async_stream(original, self, args, kwargs):
    """Async-streaming variant of :func:`_wrap_sync_stream`."""
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_groq_{_uuid.uuid4().hex[:16]}"
    client = get_default_client()
    buffer = client._chunk_buffer if hasattr(client, "_chunk_buffer") else None
    _cap_text = bool(getattr(client.config, "capture_chunk_text", False))

    async def _agen():
        model = _extract_model(kwargs)
        t_first = None
        t_prev = None
        t_last = start
        itl_sum = 0.0
        itl_count = 0
        chunk_count = 0
        output_tokens = 0
        usage_output_tokens = None
        usage_input_tokens = None
        usage_cache_read = None
        finish_reason = None
        tool_call_names: dict[int, str] = {}
        status = "success"
        error_type = None
        try:
            upstream = await original(self, *args, **kwargs)
            async for chunk in upstream:
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
                    if u["cache_read_tokens"] is not None:
                        usage_cache_read = u["cache_read_tokens"]
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
                yield chunk
        except Exception as exc:
            status = "error"
            error_type = type(exc).__name__
            raise
        finally:
            if isinstance(usage_output_tokens, int):
                output_tokens = usage_output_tokens
            ttft_ms = (t_first - start) * 1000.0 if t_first is not None else 0.0
            completion_ms = (t_last - start) * 1000.0
            itl_avg = (itl_sum / itl_count * 1000.0) if itl_count > 0 else 0.0
            tpot = ((completion_ms - ttft_ms) / (output_tokens - 1)) if output_tokens > 1 else 0.0
            payload = {
                "event_id": stream_event_id,
                "trace_id": trace_id,
                "duration_ms": completion_ms,
                "request_payload": _build_request_payload(args, kwargs),
                "stream": True,
                "chunk_count": chunk_count,
                "ttft_ms": ttft_ms,
                "itl_ms_avg": itl_avg,
                "tpot_ms": tpot,
                "completion_duration_ms": completion_ms,
                "output_tokens": output_tokens,
                "input_tokens": usage_input_tokens,
                "cache_read_input_tokens": usage_cache_read,
                "finish_reason": finish_reason,
                "tool_call_count": len(tool_call_names),
                "tool_names": list(tool_call_names.values()),
                "model": model,
                "model_normalized": normalize_model_name(model),
                "outcome": status,
                "error_type": error_type,
            }
            cfg = get_config()
            if cfg.enabled:
                get_default_client().enqueue(TraceEvent(payload=payload, source_format="groq"))

    return _agen()


def _extract_model(kwargs: dict) -> str | None:
    m = kwargs.get("model")
    return m if isinstance(m, str) else None
