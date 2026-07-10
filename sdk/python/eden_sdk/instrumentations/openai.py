"""Auto-instrumentation for the ``openai`` Python SDK.

Patches both the sync and async ``chat.completions.create`` methods.
For every call we build a payload shaped like the OpenAI ChatCompletion
response (plus the original request via ``request_payload``) and
enqueue it for the ``openai`` ingestion endpoint.

Streaming calls (``stream=True``) are wrapped so each chunk is
buffered to ``/ingest/chunks`` (TTFT, ITL, TPOT, output-token
estimates) and a single ``llm_completion_stream`` event lands at the
``openai`` endpoint when the iterator exhausts — matching the
TypeScript SDK's behaviour. The patch is best-effort: failures inside
the instrumentation never propagate into user code.
"""

from __future__ import annotations

import functools
import logging
import time
from typing import Any

from eden_sdk._instrumentation_ids import _get_attr, _trace_id_or_random
from eden_sdk._tokens import extract_usage, normalize_model_name
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import TraceContext, current_trace

logger = logging.getLogger("eden_sdk.instrumentation.openai")

_installed = False
_original_sync_create: Any | None = None
_original_async_create: Any | None = None


def install() -> None:
    """Patch the OpenAI sync/async ChatCompletion creators in place."""
    global _installed, _original_sync_create, _original_async_create
    if _installed:
        return
    try:
        from openai.resources.chat import completions as chat_completions
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"openai not importable: {exc}") from exc

    if _original_sync_create is None:
        _original_sync_create = chat_completions.Completions.create
        chat_completions.Completions.create = _wrap_sync(_original_sync_create)
    if _original_async_create is None:
        _original_async_create = chat_completions.AsyncCompletions.create
        chat_completions.AsyncCompletions.create = _wrap_async(_original_async_create)
    _installed = True
    logger.debug("eden: openai chat.completions.create patched")


def uninstall() -> None:
    """Reverse the patches (used by tests and ``eden.uninstrument()``)."""
    global _installed, _original_sync_create, _original_async_create
    if not _installed:
        return
    try:
        from openai.resources.chat import completions as chat_completions
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
    # Drop the captured originals so a subsequent install() re-captures
    # from the (possibly re-imported) target module — important for
    # tests that swap the module out between cases.
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
            # Some SDK paths return BaseModel; convert to dict.
            resp_dict = _to_dict(resp)
            _enqueue_openai_event(
                request_payload=request_payload,
                response_payload=resp_dict,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
            )
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_openai_event(
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
            _enqueue_openai_event(
                request_payload=request_payload,
                response_payload=resp_dict,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
            )
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue_openai_event(
                request_payload=request_payload,
                response_payload=None,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=repr(exc),
            )
            raise

    return wrapper


# ── Helpers ───────────────────────────────────────────────────────────


def _build_request_payload(args: tuple, kwargs: dict) -> dict[str, Any]:
    """Extract a serializable dict of the original request."""
    out: dict[str, Any] = {}
    if args:
        out["messages"] = _to_dict(args[0]) if len(args) == 1 else _to_dict(args)
    for k in ("model", "temperature", "top_p", "max_tokens", "tools",
              "tool_choice", "stream", "user", "response_format",
              "seed", "stop", "presence_penalty", "frequency_penalty",
              "logit_bias", "logprobs", "top_logprobs", "n",
              "service_tier", "parallel_tool_calls", "store",
              "metadata", "modalities", "audio", "prediction"):
        if k in kwargs:
            out[k] = _to_dict(kwargs[k])
    return out


def _to_dict(obj: Any) -> Any:
    """Best-effort conversion of pydantic / dataclass / dict to a dict.

    Recurses into nested values so a Pydantic model that contains
    other Pydantic models ends up as a flat ``dict`` of plain
    Python primitives. Without the recursion the
    ``json.dumps(..., default=str)`` fallback in ``_enqueue_chunk``
    kicks in for every nested model and the wire payload carries
    stringified ``repr()`` blobs like ``"FakeModel(foo='bar')"``
    instead of the underlying dict. The previous implementation
    called ``model_dump()`` / ``to_dict()`` but did not walk the
    result, so a single nested model was enough to corrupt the
    whole event payload.
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


def _enqueue_openai_event(
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
        # Attach request for the decoder.
        payload.setdefault("request_payload", request_payload)
        # Promote a normalized model name so pricing lookups hit a
        # single row regardless of the alias the caller used
        # ("gpt-4o-2024-08-06" vs "gpt-4o").
        m = payload.get("model")
        if isinstance(m, str):
            payload["model_normalized"] = normalize_model_name(m)

    trace_ctx: TraceContext | None = current_trace()
    if trace_ctx is not None:
        payload.setdefault("trace_id", trace_ctx.trace_id)

    get_default_client().enqueue(TraceEvent(payload=payload, source_format="openai"))


# ── Streaming ─────────────────────────────────────────────────────────


def _is_stream_request(args: tuple, kwargs: dict) -> bool:
    """Return True when the caller asked for a streaming response."""
    if kwargs.get("stream"):
        return True
    if args and isinstance(args[0], dict) and args[0].get("stream"):
        return True
    return False


def _wrap_sync_stream(original, self, args, kwargs):
    """Wrap a sync streaming ``create`` call.

    Returns a generator that yields upstream chunks while buffering
    per-chunk metrics into ``/ingest/chunks``. On iterator exhaustion
    one ``llm_completion_stream`` event is enqueued for the
    ``openai`` endpoint with TTFT/ITL/TPOT/output-token estimates.
    """
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_openai_{_uuid.uuid4().hex[:16]}"
    client = get_default_client()
    buffer = client._chunk_buffer if hasattr(client, "_chunk_buffer") else None

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
            for chunk in upstream:
                chunk_count += 1
                now = time.perf_counter()
                t_last = now
                # Capture the interval to the previous chunk BEFORE
                # updating ``t_prev`` — otherwise both the ITL
                # accumulator and the per-chunk ITL/TPOT readings
                # collapse to 0 for chunks that share a tick.
                prev = t_prev
                if t_first is None:
                    t_first = now
                elif prev is not None:
                    itl_sum += now - prev
                    itl_count += 1
                t_prev = now
                # OpenAI ChatCompletionChunk shape: {choices: [{delta: {content: ...}, finish_reason: ...}], model, usage}
                choices = _get_attr(chunk, "choices") or []
                if choices:
                    first = choices[0]
                    delta = _get_attr(first, "delta") or {}
                    text = _get_attr(delta, "content")
                    if isinstance(text, str) and text:
                        output_tokens += max(1, len(text) // 4)
                    fr = _get_attr(first, "finish_reason")
                    if fr:
                        finish_reason = fr
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
                    if u["cache_creation_tokens"] is not None:
                        usage_cache_write = u["cache_creation_tokens"]
                # Buffer chunk for /ingest/chunks if the client supports it.
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
                        and isinstance(text, str)
                        and text
                    ):
                        tpot_ms = ((now - prev) * 1000.0) / max(
                            1, (len(text) + 3) // 4
                        )
                    buffer.append({
                        "event_id": stream_event_id,
                        "trace_id": trace_id,
                        "chunk_index": chunk_count - 1,
                        "delta_text": text if isinstance(text, str) else None,
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
                        source_format="openai",
                    )
                )

    return _gen()


def _wrap_async_stream(original, self, args, kwargs):
    """Async-streaming variant of :func:`_wrap_sync_stream`.

    Returns the wrapped async generator directly — the caller
    awaits the OpenAI async ``create`` (which the wrapping layer
    also awaits) and then iterates the returned async generator.
    """
    import uuid as _uuid
    start = time.perf_counter()
    trace_id = _trace_id_or_random()
    stream_event_id = f"stream_openai_{_uuid.uuid4().hex[:16]}"
    client = get_default_client()
    buffer = client._chunk_buffer if hasattr(client, "_chunk_buffer") else None

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
            async for chunk in upstream:
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
                choices = _get_attr(chunk, "choices") or []
                if choices:
                    first = choices[0]
                    delta = _get_attr(first, "delta") or {}
                    text = _get_attr(delta, "content")
                    if isinstance(text, str) and text:
                        output_tokens += max(1, len(text) // 4)
                    fr = _get_attr(first, "finish_reason")
                    if fr:
                        finish_reason = fr
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
                        and isinstance(text, str)
                        and text
                    ):
                        tpot_ms = ((now - prev) * 1000.0) / max(
                            1, (len(text) + 3) // 4
                        )
                    buffer.append({
                        "event_id": stream_event_id,
                        "trace_id": trace_id,
                        "chunk_index": chunk_count - 1,
                        "delta_text": text if isinstance(text, str) else None,
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
                        source_format="openai",
                    )
                )

    return _agen()


def _extract_model(kwargs: dict) -> str | None:
    m = kwargs.get("model")
    return m if isinstance(m, str) else None


