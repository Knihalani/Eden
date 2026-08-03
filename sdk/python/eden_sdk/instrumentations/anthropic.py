"""Auto-instrumentation for the ``anthropic`` Python SDK.

Patches ``anthropic.resources.messages.Messages.create`` for both the
sync and async clients. Emits ``anthropic`` format events.
"""

from __future__ import annotations

import functools
import logging
import secrets
import time
from typing import Any

from eden_sdk._instrumentation_ids import _get_attr, _trace_id_or_random
from eden_sdk._tokens import extract_usage, normalize_model_name
from eden_sdk.capture import capture_request_response, limits_from_config
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.instrumentations.openai import _to_dict
from eden_sdk.trace import current_span

logger = logging.getLogger("eden_sdk.instrumentation.anthropic")

_installed = False
_original_sync_create: Any | None = None
_original_async_create: Any | None = None


def install() -> None:
    global _installed, _original_sync_create, _original_async_create
    if _installed:
        return
    try:
        from anthropic.resources import messages as anthropic_messages
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"anthropic not importable: {exc}") from exc

    if _original_sync_create is None:
        _original_sync_create = anthropic_messages.Messages.create
        anthropic_messages.Messages.create = _wrap_sync(_original_sync_create)
    if _original_async_create is None:
        _original_async_create = anthropic_messages.AsyncMessages.create
        anthropic_messages.AsyncMessages.create = _wrap_async(_original_async_create)
    _installed = True
    logger.debug("eden: anthropic messages.create patched")


def uninstall() -> None:
    global _installed, _original_sync_create, _original_async_create
    if not _installed:
        return
    try:
        from anthropic.resources import messages as anthropic_messages
    except Exception:  # noqa: BLE001
        _installed = False
        _original_sync_create = None
        _original_async_create = None
        return
    if _original_sync_create is not None:
        anthropic_messages.Messages.create = _original_sync_create
    if _original_async_create is not None:
        anthropic_messages.AsyncMessages.create = _original_async_create
    _installed = False
    # Drop the captured originals so a subsequent install() re-captures
    # from the (possibly re-imported) target module.
    _original_sync_create = None
    _original_async_create = None


def _wrap_sync(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return original(self, *args, **kwargs)
        if _is_stream_request(kwargs):
            return _wrap_sync_stream(original, self, args, kwargs)
        t0 = time.perf_counter()
        request_payload = _build_request_payload(kwargs)
        try:
            resp = original(self, *args, **kwargs)
            resp_dict = _to_dict(resp)
            _enqueue_anthropic_event(
                request_payload=request_payload,
                response_payload=resp_dict,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
            )
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_anthropic_event(
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
        if _is_stream_request(kwargs):
            return _wrap_async_stream(original, self, args, kwargs)
        t0 = time.perf_counter()
        request_payload = _build_request_payload(kwargs)
        try:
            resp = await original(self, *args, **kwargs)
            resp_dict = _to_dict(resp)
            _enqueue_anthropic_event(
                request_payload=request_payload,
                response_payload=resp_dict,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
            )
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_anthropic_event(
                request_payload=request_payload,
                response_payload=None,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=repr(exc),
            )
            raise

    return wrapper


def _build_request_payload(kwargs: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k in ("model", "messages", "system", "max_tokens", "metadata",
              "stop_sequences", "stream", "temperature", "top_p", "top_k",
              "tools", "tool_choice", "thinking", "service_tier", "extra_headers"):
        if k in kwargs:
            out[k] = _to_dict(kwargs[k])
    return out


def _enqueue_anthropic_event(
    request_payload: dict[str, Any],
    response_payload: dict[str, Any] | None,
    duration_ms: float,
    error: str | None,
) -> None:
    cfg = get_config()
    if not cfg.enabled:
        return
    # Pull model/usage from the *original* response before capture —
    # see openai.py's ``_enqueue_openai_event`` for why: in
    # ``capture_mode="metrics_only"`` response_payload collapses to
    # None below, and that's where model/usage live for this provider.
    _orig_model = None
    _orig_usage = None
    if isinstance(response_payload, dict):
        m = response_payload.get("model")
        _orig_model = m if isinstance(m, str) else None
        _orig_usage = response_payload.get("usage")
    if _orig_model is None and isinstance(request_payload, dict):
        m = request_payload.get("model")
        _orig_model = m if isinstance(m, str) else None
    # Bounded capture before response_payload's fields flatten onto
    # ``payload`` below — see openai.py's ``_enqueue_openai_event``
    # for why truncation must happen first.
    request_payload, response_payload, capture_attrs = capture_request_response(
        request_payload,
        response_payload,
        error=error,
        duration_ms=duration_ms,
        limits=limits_from_config(cfg),
    )
    payload: dict[str, Any] = {
        "duration_ms": duration_ms,
        "request_payload": request_payload,
    }
    if error is not None:
        payload["error"] = {"message": error}
    if response_payload is not None:
        payload.update(response_payload)
        payload.setdefault("request_payload", request_payload)
        # Normalize model name so pricing lookups hit a single row
        # ("claude-3-5-sonnet-20241022" vs "claude-3-5-sonnet").
        m = payload.get("model")
        if isinstance(m, str):
            payload["model_normalized"] = normalize_model_name(m)
    if "model" not in payload and _orig_model is not None:
        payload["model"] = _orig_model
        payload["model_normalized"] = normalize_model_name(_orig_model)
    if "usage" not in payload and _orig_usage is not None:
        payload["usage"] = _orig_usage

    # Always stamp a trace_id — joining the active trace when one
    # exists, otherwise a fresh uuid4 — so the payload shape matches
    # the streaming path (_wrap_sync_stream/_wrap_async_stream below),
    # which has called _trace_id_or_random() unconditionally all
    # along. Previously this only ran inside the `trace_ctx is not
    # None` branch, so a non-streaming call with no active trace
    # shipped no trace_id at all while the equivalent streaming call
    # always did.
    payload.setdefault("trace_id", _trace_id_or_random())
    payload.setdefault("span_id", secrets.token_hex(8))
    _cur = current_span()
    if _cur is not None:
        payload.setdefault("parent_span_id", _cur.span_id)
    attrs = payload.get("attributes")
    if not isinstance(attrs, dict):
        attrs = {}
        payload["attributes"] = attrs
    attrs.update(capture_attrs)
    if error is not None:
        attrs.setdefault("error", error)
        attrs.setdefault("eden.error", error)

    get_default_client().enqueue(
        TraceEvent(payload=payload, source_format="anthropic")
    )



# ── Streaming ─────────────────────────────────────────────────────────


def _is_stream_request(kwargs: dict) -> bool:
    return bool(kwargs.get("stream"))


def _wrap_sync_stream(original, self, args, kwargs):
    """Wrap a sync streaming Anthropic ``create`` call.

    Anthropic streams an event stream (`message_start`,
    `content_block_delta`, `message_delta`, `message_stop`).
    We accumulate text-delta events into a TTFT/ITL/TPOT-buffered
    stream and emit one ``llm_completion_stream`` event when the
    stream ends. Per-chunk metrics also go to ``/ingest/chunks``.
    """
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_anthropic_{_uuid.uuid4().hex[:16]}"
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
        usage_cache_write = None
        finish_reason = None
        status = "success"
        error_type = None
        try:
            upstream = original(self, *args, **kwargs)
            for event in upstream:
                chunk_count += 1
                now = time.perf_counter()
                t_last = now
                # Capture the interval to the previous chunk BEFORE
                # updating ``t_prev`` — otherwise the per-chunk
                # ITL/TPOT readings collapse to 0 for chunks that
                # share a tick.
                prev = t_prev
                if t_first is None:
                    t_first = now
                elif prev is not None:
                    itl_sum += now - prev
                    itl_count += 1
                t_prev = now
                etype = _get_attr(event, "type")
                delta_text = None
                if etype == "content_block_delta":
                    delta = _get_attr(event, "delta") or {}
                    delta_text = _get_attr(delta, "text")
                    if isinstance(delta_text, str) and delta_text:
                        output_tokens += max(1, len(delta_text) // 4)
                elif etype == "message_delta":
                    delta = _get_attr(event, "delta") or {}
                    fr = _get_attr(delta, "stop_reason")
                    if fr:
                        finish_reason = fr
                    usage = _get_attr(event, "usage")
                    if usage is not None:
                        u = extract_usage(usage)
                        if u["output_tokens"] is not None and u["output_tokens"] > 0:
                            usage_output_tokens = u["output_tokens"]
                        if u["cache_read_tokens"] is not None:
                            usage_cache_read = u["cache_read_tokens"]
                elif etype == "message_start":
                    # Anthropic SDKs return ``message`` as a
                    # Pydantic model in modern versions (1.x) and
                    # as a plain dict in older versions and
                    # anthropic-compatible gateways. The previous
                    # implementation only handled the dict shape
                    # (``isinstance(msg, dict)``), so on the
                    # modern SDK the model name + input token
                    # count were silently dropped on every
                    # Anthropic stream. Use :func:`_get_attr`,
                    # which dispatches on the actual shape.
                    msg = _get_attr(event, "message")
                    if msg is not None:
                        m = _get_attr(msg, "model")
                        if isinstance(m, str):
                            model = m
                        usage = _get_attr(msg, "usage")
                        if usage is not None:
                            u = extract_usage(usage)
                            if u["input_tokens"] is not None:
                                usage_input_tokens = u["input_tokens"]
                            if u["cache_read_tokens"] is not None:
                                usage_cache_read = u["cache_read_tokens"]
                            if u["cache_creation_tokens"] is not None:
                                usage_cache_write = u["cache_creation_tokens"]
                if buffer is not None:
                    # Per-chunk TPOT (time per output token) is the
                    # time spent generating THIS chunk's tokens
                    # divided by the token count for this chunk
                    # (approximated as ``ceil(len/4)`` to match the
                    # aggregate ``output_tokens`` heuristic). Chunks
                    # with no text (finish_reason / usage chunks)
                    # emit ``None`` rather than a misleading zero.
                    #
                    # The previous implementation set ``tpot_ms =
                    # (now - start) / chunk_count`` which is the
                    # *average inter-chunk arrival time*, NOT time
                    # per token — that mislabel propagated into the
                    # server's ``tpot_ms_p50`` / ``tpot_ms_p95``
                    # percentile dashboards.
                    tpot_ms = None
                    if (
                        prev is not None
                        and isinstance(delta_text, str)
                        and delta_text
                    ):
                        tpot_ms = ((now - prev) * 1000.0) / max(
                            1, (len(delta_text) + 3) // 4
                        )
                    buffer.append({
                        "event_id": stream_event_id,
                        "trace_id": trace_id,
                        "chunk_index": chunk_count - 1,
                        "delta_text": (delta_text if isinstance(delta_text, str) else None) if _cap_text else None,
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
            ttft_ms = (t_first - start) * 1000.0 if t_first is not None else 0.0
            completion_ms = (t_last - start) * 1000.0
            itl_avg = (itl_sum / itl_count * 1000.0) if itl_count > 0 else 0.0
            tpot = ((completion_ms - ttft_ms) / (output_tokens - 1)) if output_tokens > 1 else 0.0
            payload = {
                "event_id": stream_event_id,
                "trace_id": trace_id,
                "duration_ms": completion_ms,
                "request_payload": _build_request_payload(kwargs),
                "stream": True,
                "chunk_count": chunk_count,
                "ttft_ms": ttft_ms,
                "itl_ms_avg": itl_avg,
                "tpot_ms": tpot,
                "completion_duration_ms": completion_ms,
                "output_tokens": output_tokens,
                "input_tokens": usage_input_tokens,
                "cache_read_input_tokens": usage_cache_read,
                "cache_creation_input_tokens": usage_cache_write,
                "finish_reason": finish_reason,
                "model": model,
                "model_normalized": normalize_model_name(model),
                "outcome": status,
                "error_type": error_type,
            }
            cfg = get_config()
            if cfg.enabled:
                get_default_client().enqueue(
                    TraceEvent(
                        payload=payload,
                        source_format="anthropic",
                    )
                )

    return _gen()


def _wrap_async_stream(original, self, args, kwargs):
    """Async-streaming variant for the Anthropic messages.create."""
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_anthropic_{_uuid.uuid4().hex[:16]}"
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
        usage_cache_write = None
        finish_reason = None
        status = "success"
        error_type = None
        try:
            upstream = await original(self, *args, **kwargs)
            async for event in upstream:
                chunk_count += 1
                now = time.perf_counter()
                t_last = now
                # Capture the interval to the previous chunk BEFORE
                # updating ``t_prev`` — otherwise the per-chunk
                # ITL/TPOT readings collapse to 0 for chunks that
                # share a tick.
                prev = t_prev
                if t_first is None:
                    t_first = now
                elif prev is not None:
                    itl_sum += now - prev
                    itl_count += 1
                t_prev = now
                etype = _get_attr(event, "type")
                delta_text = None
                if etype == "content_block_delta":
                    delta = _get_attr(event, "delta") or {}
                    delta_text = _get_attr(delta, "text")
                    if isinstance(delta_text, str) and delta_text:
                        output_tokens += max(1, len(delta_text) // 4)
                elif etype == "message_delta":
                    delta = _get_attr(event, "delta") or {}
                    fr = _get_attr(delta, "stop_reason")
                    if fr:
                        finish_reason = fr
                    usage = _get_attr(event, "usage")
                    if usage is not None:
                        u = extract_usage(usage)
                        if u["output_tokens"] is not None and u["output_tokens"] > 0:
                            usage_output_tokens = u["output_tokens"]
                        if u["cache_read_tokens"] is not None:
                            usage_cache_read = u["cache_read_tokens"]
                elif etype == "message_start":
                    # Anthropic SDKs return ``message`` as a
                    # Pydantic model in modern versions (1.x) and
                    # as a plain dict in older versions and
                    # anthropic-compatible gateways. The previous
                    # implementation only handled the dict shape
                    # (``isinstance(msg, dict)``), so on the
                    # modern SDK the model name + input token
                    # count were silently dropped on every
                    # Anthropic stream. Use :func:`_get_attr`,
                    # which dispatches on the actual shape.
                    msg = _get_attr(event, "message")
                    if msg is not None:
                        m = _get_attr(msg, "model")
                        if isinstance(m, str):
                            model = m
                        usage = _get_attr(msg, "usage")
                        if usage is not None:
                            u = extract_usage(usage)
                            if u["input_tokens"] is not None:
                                usage_input_tokens = u["input_tokens"]
                            if u["cache_read_tokens"] is not None:
                                usage_cache_read = u["cache_read_tokens"]
                            if u["cache_creation_tokens"] is not None:
                                usage_cache_write = u["cache_creation_tokens"]
                if buffer is not None:
                    # Per-chunk TPOT (time per output token) is the
                    # time spent generating THIS chunk's tokens
                    # divided by the token count for this chunk
                    # (approximated as ``ceil(len/4)`` to match the
                    # aggregate ``output_tokens`` heuristic). Chunks
                    # with no text (finish_reason / usage chunks)
                    # emit ``None`` rather than a misleading zero.
                    #
                    # The previous implementation set ``tpot_ms =
                    # (now - start) / chunk_count`` which is the
                    # *average inter-chunk arrival time*, NOT time
                    # per token — that mislabel propagated into the
                    # server's ``tpot_ms_p50`` / ``tpot_ms_p95``
                    # percentile dashboards.
                    tpot_ms = None
                    if (
                        prev is not None
                        and isinstance(delta_text, str)
                        and delta_text
                    ):
                        tpot_ms = ((now - prev) * 1000.0) / max(
                            1, (len(delta_text) + 3) // 4
                        )
                    buffer.append({
                        "event_id": stream_event_id,
                        "trace_id": trace_id,
                        "chunk_index": chunk_count - 1,
                        "delta_text": (delta_text if isinstance(delta_text, str) else None) if _cap_text else None,
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
            ttft_ms = (t_first - start) * 1000.0 if t_first is not None else 0.0
            completion_ms = (t_last - start) * 1000.0
            itl_avg = (itl_sum / itl_count * 1000.0) if itl_count > 0 else 0.0
            tpot = ((completion_ms - ttft_ms) / (output_tokens - 1)) if output_tokens > 1 else 0.0
            payload = {
                "event_id": stream_event_id,
                "trace_id": trace_id,
                "duration_ms": completion_ms,
                "request_payload": _build_request_payload(kwargs),
                "stream": True,
                "chunk_count": chunk_count,
                "ttft_ms": ttft_ms,
                "itl_ms_avg": itl_avg,
                "tpot_ms": tpot,
                "completion_duration_ms": completion_ms,
                "output_tokens": output_tokens,
                "input_tokens": usage_input_tokens,
                "cache_read_input_tokens": usage_cache_read,
                "cache_creation_input_tokens": usage_cache_write,
                "finish_reason": finish_reason,
                "model": model,
                "model_normalized": normalize_model_name(model),
                "outcome": status,
                "error_type": error_type,
            }
            cfg = get_config()
            if cfg.enabled:
                get_default_client().enqueue(
                    TraceEvent(
                        payload=payload,
                        source_format="anthropic",
                    )
                )

    return _agen()


def _extract_model(kwargs: dict) -> str | None:
    m = kwargs.get("model")
    return m if isinstance(m, str) else None


