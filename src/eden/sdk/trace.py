from __future__ import annotations

import time
import functools
import inspect
import logging
from typing import Any, AsyncIterator, Callable, Optional, TypeVar

logger = logging.getLogger("eden.sdk.trace")

F = TypeVar("F", bound=Callable[..., Any])


def trace_agent(
    *,
    environment_id: Optional[str] = None,
    tags: Optional[list[str]] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> Callable[[F], F]:
    """Decorator that auto-traces agent function execution.

    Captures function name, arguments (sanitised), return value,
    exceptions, and timing. Sends to Eden's observability platform
    when a client is available.

    Usage:
        @trace_agent(environment_id="env_abc123", tags=["production"])
        async def my_agent(user_query: str) -> str:
            return await llm.chat.completions.create(...)
    """
    def decorator(func: F) -> F:
        is_async = inspect.iscoroutinefunction(func)

        @functools.wraps(func)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            trace_data = _build_trace_data(func, environment_id, tags, metadata, args, kwargs)
            start = time.time()

            try:
                result = await func(*args, **kwargs)
                trace_data["status"] = "success"
                trace_data["result_type"] = type(result).__name__
                return result
            except Exception as e:
                trace_data["status"] = "error"
                trace_data["error_type"] = type(e).__name__
                trace_data["error_message"] = str(e)
                raise
            finally:
                trace_data["duration_ms"] = round((time.time() - start) * 1000, 2)
                _emit_trace(trace_data)

        @functools.wraps(func)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            trace_data = _build_trace_data(func, environment_id, tags, metadata, args, kwargs)
            start = time.time()

            try:
                result = func(*args, **kwargs)
                trace_data["status"] = "success"
                trace_data["result_type"] = type(result).__name__
                return result
            except Exception as e:
                trace_data["status"] = "error"
                trace_data["error_type"] = type(e).__name__
                trace_data["error_message"] = str(e)
                raise
            finally:
                trace_data["duration_ms"] = round((time.time() - start) * 1000, 2)
                _emit_trace(trace_data)

        return async_wrapper if is_async else sync_wrapper  # type: ignore[return-value]

    return decorator


def _build_trace_data(
    func: Callable[..., Any],
    environment_id: Optional[str],
    tags: Optional[list[str]],
    metadata: Optional[dict[str, Any]],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> dict[str, Any]:
    """Build the trace payload."""
    import uuid
    from datetime import datetime, timezone

    # Sanitise arguments — never log sensitive values
    safe_args = [f"<{type(a).__name__}>" for a in args]
    safe_kwargs = {k: f"<{type(v).__name__}>" for k, v in kwargs.items()}

    return {
        "trace_id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "function": func.__qualname__,
        "module": func.__module__,
        "environment_id": environment_id,
        "tags": tags or [],
        "args": safe_args,
        "kwargs": safe_kwargs,
        "metadata": metadata or {},
    }


def _emit_trace(trace_data: dict[str, Any]) -> None:
    """Emit a trace to the Eden Telemetry Collector and log locally."""
    import uuid
    from datetime import datetime, timezone

    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(f"[trace] {trace_data['trace_id']} {trace_data['function']} — {trace_data.get('status')} in {trace_data.get('duration_ms')}ms")

    # Phase 6.5: Send to Eden Telemetry Collector
    try:
        import asyncio
        from eden.observability.telemetry_collector import TelemetryEvent, get_telemetry_collector

        event = TelemetryEvent(
            event_id=trace_data.get("trace_id", str(uuid.uuid4())),
            tenant_id=trace_data.get("metadata", {}).get("tenant_id", "default"),
            project_id=trace_data.get("metadata", {}).get("project_id", "default"),
            trace_id=trace_data.get("trace_id", str(uuid.uuid4())),
            realm="production",
            event_type="agent.run",
            timestamp=trace_data.get("timestamp", datetime.now(timezone.utc).isoformat()),
            agent_id=trace_data.get("environment_id"),
            name=trace_data.get("function"),
            duration_ms=trace_data.get("duration_ms"),
            payload={
                "function": trace_data.get("function"),
                "module": trace_data.get("module"),
                "args": trace_data.get("args"),
                "kwargs": trace_data.get("kwargs"),
                "result_type": trace_data.get("result_type"),
                "error_type": trace_data.get("error_type"),
                "error_message": trace_data.get("error_message"),
            },
            metrics={"duration_ms": trace_data.get("duration_ms", 0) or 0},
            attributes={"content_hash": trace_data.get("metadata", {}).get("_content_hash", "")},
            tags=trace_data.get("tags", []),
            outcome="success" if trace_data.get("status") == "success" else "failure" if trace_data.get("status") == "error" else "partial",
        )

        collector = get_telemetry_collector()
        try:
            loop = asyncio.get_running_loop()
            if loop.is_running():
                asyncio.create_task(collector.ingest(event))
        except RuntimeError:
            # No event loop — synchronous context; can't await
            pass
    except Exception as exc:
        # Telemetry emission should never break the traced function
        logger.debug(f"Failed to emit trace to telemetry collector: {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# Phase 5.3.5: auto-instrumentation
# ─────────────────────────────────────────────────────────────────────────────
# Patches common LLM SDKs at runtime so every chat completion / embedding
# call is automatically captured by the trace pipeline — no per-call
# decorators required. Idempotent: calling twice is a no-op.

_instrumented: set[str] = set()


def auto_instrument(
    *,
    targets: Optional[list[str]] = None,
    environment_id: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> dict[str, bool]:
    """Auto-patch installed LLM SDKs to emit trace events.

    Supported targets:
        - ``"openai"`` — patches ``openai.resources.chat.Completions.create``
        - ``"anthropic"`` — patches ``anthropic.resources.messages.Messages.create``
        - ``"langchain"`` — patches ``langchain.chat_models.base.ChatModel``

    Streaming (``stream=True``) is supported on openai and anthropic.
    The wrapper records time-to-first-token (TTFT), inter-token
    latency (ITL avg), time-per-output-token (TPOT), and completion
    duration, then emits a single ``llm_completion_stream`` event
    after the iterator is exhausted.

    By default all available targets are instrumented. Returns a dict
    of ``{target: instrumented}`` so callers can see what was patched.

    Example::

        from eden.sdk.trace import auto_instrument
        auto_instrument(tags=["production"])

        # Now every OpenAI / Anthropic / LangChain call emits a trace
        import openai
        client = openai.OpenAI()
        client.chat.completions.create(...)  # auto-traced
    """
    if targets is None:
        targets = ["openai", "anthropic", "langchain"]

    results: dict[str, bool] = {}

    for target in targets:
        if target in _instrumented:
            results[target] = True
            continue

        if target == "openai":
            results[target] = _instrument_openai(
                environment_id=environment_id, tags=tags
            )
        elif target == "anthropic":
            results[target] = _instrument_anthropic(
                environment_id=environment_id, tags=tags
            )
        elif target == "langchain":
            results[target] = _instrument_langchain(
                environment_id=environment_id, tags=tags
            )
        else:
            results[target] = False
            logger.warning(f"Unknown auto_instrument target: {target!r}")

        if results[target]:
            _instrumented.add(target)

    return results


# ── Streaming helpers (Phase 7.1a.1) ─────────────────────────────────────────

def _extract_text_from_openai_chunk(chunk: Any) -> tuple[Optional[str], Optional[str]]:
    """Return ``(text_delta, finish_reason)`` for an OpenAI ``ChatCompletionChunk``."""
    text: Optional[str] = None
    finish_reason: Optional[str] = None
    try:
        if chunk.choices:
            first = chunk.choices[0]
            if getattr(first, "delta", None):
                content = first.delta.content
                if content:
                    text = content
            finish_reason = getattr(first, "finish_reason", None)
    except (AttributeError, IndexError):
        pass
    return text, finish_reason


def _extract_text_from_anthropic_event(event: Any) -> tuple[Optional[str], Optional[str]]:
    """Return ``(text_delta, finish_reason)`` for an Anthropic streaming event.

    Anthropic emits ``MessageStartEvent`` / ``ContentBlockStartEvent`` /
    ``ContentBlockDeltaEvent`` / ``ContentBlockStopEvent`` /
    ``MessageDeltaEvent`` / ``MessageStopEvent``. Only the delta
    events carry text.
    """
    text: Optional[str] = None
    finish_reason: Optional[str] = None
    try:
        etype = getattr(event, "type", None)
        if etype == "content_block_delta":
            delta = getattr(event, "delta", None)
            if delta is not None and getattr(delta, "type", None) == "text_delta":
                text = getattr(delta, "text", None)
        elif etype == "message_delta":
            delta = getattr(event, "delta", None)
            if delta is not None:
                finish_reason = getattr(delta, "stop_reason", None)
    except AttributeError:
        pass
    return text, finish_reason


def _tpot_ms(
    completion_duration_ms: float,
    ttft_ms: float,
    output_tokens: int,
) -> float:
    """Time per output token — only meaningful when we have >= 1 token.

    TPOT = (total time − TTFT) / max(0, output_tokens − 1). The −1
    accounts for the fact that the first token's "time" is the TTFT
    itself; we measure the average cost of every subsequent token.
    """
    if output_tokens <= 1:
        return 0.0
    return (completion_duration_ms - ttft_ms) / (output_tokens - 1)


def _itl_avg_ms(itl_sum_ms: float, itl_count: int) -> float:
    """Inter-token latency average over a window of chunks."""
    if itl_count <= 0:
        return 0.0
    return itl_sum_ms / itl_count


def _streaming_summary(
    t0: float,
    t_first: Optional[float],
    t_last: float,
    itl_sum_ms: float,
    itl_count: int,
    output_tokens: int,
) -> dict[str, float]:
    """Compute the streaming-metric summary from raw timing samples."""
    if t_first is None:
        # No chunks received — degenerate case.
        return {
            "ttft_ms": 0.0,
            "itl_ms_avg": 0.0,
            "tpot_ms": 0.0,
            "completion_duration_ms": (t_last - t0) * 1000.0,
            "output_tokens": float(output_tokens),
        }
    ttft_ms = (t_first - t0) * 1000.0
    completion_duration_ms = (t_last - t0) * 1000.0
    return {
        "ttft_ms": ttft_ms,
        "itl_ms_avg": _itl_avg_ms(itl_sum_ms, itl_count),
        "tpot_ms": _tpot_ms(completion_duration_ms, ttft_ms, output_tokens),
        "completion_duration_ms": completion_duration_ms,
        "output_tokens": float(output_tokens),
    }


async def _wrap_openai_stream(
    upstream: AsyncIterator[Any],
    *,
    model: str,
    environment_id: Optional[str],
    tags: Optional[list[str]],
    provider: str,
) -> AsyncIterator[Any]:
    """Wrap an OpenAI ``stream=True`` response iterator.

    Yields chunks unchanged so the caller's iteration is unaffected.
    After the iterator exhausts (or raises), records the streaming
    metrics and emits a single ``llm_completion_stream`` event.

    Output tokens are estimated by summing non-empty ``delta.content``
    chunks (rough count of token-sized text increments). The OpenAI
    SDK sometimes provides a final ``chunk.usage`` with the precise
    count — that wins if present.

    Phase 7.2a: also buffers each chunk and POSTs to
    ``/orgs/{org_id}/ingest/chunks`` on exhaustion. The collector
    writes them to ``telemetry_stream_chunks`` for the per-token
    replay and Datadog-style latency analytics.
    """
    t0 = time.monotonic()
    t_first: Optional[float] = None
    t_prev: Optional[float] = None
    t_last: float = t0
    itl_sum_ms = 0.0
    itl_count = 0
    output_tokens = 0
    usage_output_tokens: Optional[int] = None
    finish_reason: Optional[str] = None
    chunk_count = 0
    error_type: Optional[str] = None
    status = "success"
    buffered_chunks: list[dict[str, Any]] = []
    event_id = f"stream_{provider}_{int(time.time() * 1_000_000)}_{id(upstream)}"

    try:
        async for chunk in upstream:
            chunk_count += 1
            now = time.monotonic()
            t_last = now
            if t_first is None:
                t_first = now
            elif t_prev is not None:
                itl_sum_ms += (now - t_prev) * 1000.0
                itl_count += 1
            t_prev = now

            text_delta, chunk_finish = _extract_text_from_openai_chunk(chunk)
            if chunk_finish:
                finish_reason = chunk_finish
            if text_delta:
                # Rough token estimate: one chunk ≈ one token.
                output_tokens += max(1, len(text_delta) // 4)
            # Prefer the SDK's reported count if it surfaces in usage.
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                ct = getattr(usage, "completion_tokens", None)
                if isinstance(ct, int) and ct > 0:
                    usage_output_tokens = ct
            # Phase 7.2a — buffer this chunk for per-token capture
            buffered_chunks.append({
                "event_id": event_id,
                "trace_id": event_id,  # SDK uses event_id as trace_id when no session
                "chunk_index": chunk_count - 1,
                "delta_text": text_delta or None,
                "ttft_ms": (t_first - t0) * 1000.0 if t_first is not None else None,
                "itl_ms": (now - t_prev) * 1000.0 if t_prev is not None and chunk_count > 1 else None,
                "tpot_ms": (now - t0) * 1000.0 / chunk_count if chunk_count > 0 else None,
                "received_at_client_ms": int(time.time() * 1000),
            })
            yield chunk
    except Exception as exc:
        status = "error"
        error_type = type(exc).__name__
        raise
    finally:
        if usage_output_tokens is not None:
            output_tokens = usage_output_tokens
        summary = _streaming_summary(
            t0=t0, t_first=t_first, t_last=t_last,
            itl_sum_ms=itl_sum_ms, itl_count=itl_count,
            output_tokens=output_tokens,
        )
        await _emit_provider_streaming_trace(
            provider=provider,
            model=model,
            environment_id=environment_id,
            tags=tags,
            metrics=summary,
            chunk_count=chunk_count,
            finish_reason=finish_reason,
            status=status,
            error_type=error_type,
        )
        # Phase 7.2a — flush buffered chunks via POST /ingest/chunks
        if buffered_chunks:
            try:
                await _flush_stream_chunks(
                    environment_id=environment_id, chunks=buffered_chunks
                )
            except Exception as exc:
                logger.debug(f"stream chunk flush failed: {exc}")


async def _flush_stream_chunks(
    environment_id: Optional[str],
    chunks: list[dict[str, Any]],
) -> None:
    """POST buffered streaming chunks to /orgs/{org_id}/ingest/chunks.

    Fire-and-forget; failures are logged at debug level and dropped
    so the user's call is never blocked by telemetry I/O.
    """
    try:
        # Use a shared httpx client (initialized lazily).
        client = await _get_sdk_http_client()
        # Read the configured endpoint from settings.
        from eden.config import get_settings
        settings = get_settings()
        api_url = getattr(settings, "api_url", "http://localhost:8000")
        org_id = environment_id or "default"
        url = f"{api_url.rstrip('/')}/orgs/{org_id}/ingest/chunks"
        # The chunks endpoint accepts X-Org-Api-Key auth. The SDK
        # doesn't store API keys (that's a customer integration choice);
        # we ship unauthenticated for now and rely on the cookie from
        # the customer. Production SDKs would inject their key here.
        resp = await client.post(
            url,
            json={"chunks": chunks},
            headers={"Content-Type": "application/json"},
            timeout=5.0,
        )
        if resp.status_code >= 300:
            logger.debug(f"chunk ingest returned {resp.status_code}")
    except Exception as exc:
        logger.debug(f"chunk flush HTTP call failed: {exc}")


_sdk_http_client: Optional[Any] = None


async def _get_sdk_http_client() -> Any:
    """Lazy-init a shared httpx.AsyncClient for SDK→backend calls."""
    global _sdk_http_client
    if _sdk_http_client is None:
        try:
            import httpx
            _sdk_http_client = httpx.AsyncClient(timeout=5.0)
        except ImportError:
            raise RuntimeError("httpx not installed; install eden[client] to use SDK")
    return _sdk_http_client


async def _wrap_anthropic_stream(
    upstream: AsyncIterator[Any],
    *,
    model: str,
    environment_id: Optional[str],
    tags: Optional[list[str]],
    provider: str,
) -> AsyncIterator[Any]:
    """Wrap an Anthropic ``messages.stream=True`` response iterator.

    Mirrors the OpenAI wrapper but uses the Anthropic event types.
    """
    t0 = time.monotonic()
    t_first: Optional[float] = None
    t_prev: Optional[float] = None
    t_last: float = t0
    itl_sum_ms = 0.0
    itl_count = 0
    output_tokens = 0
    usage_output_tokens: Optional[int] = None
    usage_input_tokens: Optional[int] = None
    finish_reason: Optional[str] = None
    chunk_count = 0
    error_type: Optional[str] = None
    status = "success"

    try:
        async for event in upstream:
            chunk_count += 1
            now = time.monotonic()
            t_last = now
            if t_first is None:
                t_first = now
            elif t_prev is not None:
                itl_sum_ms += (now - t_prev) * 1000.0
                itl_count += 1
            t_prev = now

            text_delta, chunk_finish = _extract_text_from_anthropic_event(event)
            if chunk_finish:
                finish_reason = chunk_finish
            if text_delta:
                output_tokens += max(1, len(text_delta) // 4)

            etype = getattr(event, "type", None)
            if etype == "message_start":
                msg = getattr(event, "message", None)
                if msg is not None:
                    usage = getattr(msg, "usage", None)
                    if usage is not None:
                        inp = getattr(usage, "input_tokens", None)
                        if isinstance(inp, int):
                            usage_input_tokens = inp
            elif etype == "message_delta":
                usage = getattr(event, "usage", None)
                if usage is not None:
                    out = getattr(usage, "output_tokens", None)
                    if isinstance(out, int) and out > 0:
                        usage_output_tokens = out

            yield event
    except Exception as exc:
        status = "error"
        error_type = type(exc).__name__
        raise
    finally:
        if usage_output_tokens is not None:
            output_tokens = usage_output_tokens
        summary = _streaming_summary(
            t0=t0, t_first=t_first, t_last=t_last,
            itl_sum_ms=itl_sum_ms, itl_count=itl_count,
            output_tokens=output_tokens,
        )
        if usage_input_tokens is not None:
            summary["input_tokens"] = float(usage_input_tokens)
        await _emit_provider_streaming_trace(
            provider=provider,
            model=model,
            environment_id=environment_id,
            tags=tags,
            metrics=summary,
            chunk_count=chunk_count,
            finish_reason=finish_reason,
            status=status,
            error_type=error_type,
        )


async def _emit_provider_streaming_trace(
    *,
    provider: str,
    model: str,
    environment_id: Optional[str],
    tags: Optional[list[str]],
    metrics: dict[str, float],
    chunk_count: int,
    finish_reason: Optional[str],
    status: str,
    error_type: Optional[str],
) -> None:
    """Emit a single ``llm_completion_stream`` event after a streaming
    response is exhausted. Mirrors the contract of
    ``_emit_provider_trace`` for non-streaming calls but uses
    streaming-specific event type and metrics. Telemetry errors are
    swallowed — instrumentation must never break the user's call.
    """
    try:
        from eden.observability.telemetry_collector import (
            get_telemetry_collector,
            TelemetryEvent,
        )
        event = TelemetryEvent(
            event_id=f"auto_stream_{provider}_{int(time.time() * 1_000_000)}",
            tenant_id="default",
            project_id="default",
            trace_id=f"auto_stream_{provider}_{int(time.time() * 1_000_000)}",
            realm="production",
            event_type="llm_completion_stream",
            timestamp=None,  # collector fills
            source_format="eden-auto-instrument",
            payload={
                "provider": provider,
                "model": model,
                "environment_id": environment_id,
                "status": status,
                "error_type": error_type,
                "chunk_count": chunk_count,
                "finish_reason": finish_reason,
            },
            metrics=metrics,
            tags=list(tags or []) + ["auto_instrument", "streaming"],
        )
        collector = await get_telemetry_collector()
        import asyncio
        try:
            loop = asyncio.get_running_loop()
            if loop.is_running():
                asyncio.create_task(collector.ingest(event))
        except RuntimeError:
            pass
    except Exception as exc:
        logger.debug(f"auto_instrument streaming telemetry emit failed: {exc}")


def _is_streaming_call(kwargs: dict[str, Any]) -> bool:
    """Return True if the call was made with ``stream=True``."""
    return bool(kwargs.get("stream"))


def _instrument_openai(
    *,
    environment_id: Optional[str],
    tags: Optional[list[str]],
) -> bool:
    """Monkey-patch ``openai.resources.chat.Completions.create``."""
    try:
        from openai.resources.chat import Completions
    except ImportError:
        logger.debug("openai not installed; skipping")
        return False

    if getattr(Completions.create, "_eden_instrumented", False):
        return True

    original_create = Completions.create

    @functools.wraps(original_create)
    async def traced_create(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        start = time.time()
        status = "success"
        error_type = None
        response = None
        try:
            if _is_streaming_call(kwargs):
                # OpenAI streaming: get the async iterator then wrap.
                response = await original_create(self, *args, **kwargs)
                return _wrap_openai_stream(
                    response,
                    model=str(kwargs.get("model", "?")),
                    environment_id=environment_id,
                    tags=tags,
                    provider="openai",
                )
            response = await original_create(self, *args, **kwargs)
            return response
        except Exception as exc:
            status = "error"
            error_type = type(exc).__name__
            raise
        finally:
            # Only emit the non-streaming summary event when the call
            # wasn't a stream — the streaming wrapper emits its own
            # ``llm_completion_stream`` event on iterator exhaustion.
            if not _is_streaming_call(kwargs):
                duration_ms = int((time.time() - start) * 1000)
                _emit_provider_trace(
                    provider="openai",
                    model=kwargs.get("model", "?"),
                    environment_id=environment_id,
                    tags=tags,
                    duration_ms=duration_ms,
                    status=status,
                    error_type=error_type,
                )

    # Preserve sync call path too
    @functools.wraps(original_create)
    def traced_create_sync(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        start = time.time()
        status = "success"
        error_type = None
        try:
            return original_create(self, *args, **kwargs)
        except Exception as exc:
            status = "error"
            error_type = type(exc).__name__
            raise
        finally:
            duration_ms = int((time.time() - start) * 1000)
            _emit_provider_trace(
                provider="openai",
                model=kwargs.get("model", "?"),
                environment_id=environment_id,
                tags=tags,
                duration_ms=duration_ms,
                status=status,
                error_type=error_type,
            )

    # The openai SDK exposes a single ``create`` method that handles both
    # sync and async depending on the client; binding the async wrapper is
    # sufficient because the SDK dispatches internally.
    Completions.create = traced_create  # type: ignore[method-assign]
    Completions.create._eden_instrumented = True  # type: ignore[attr-defined]
    logger.info("Auto-instrumented openai.resources.chat.Completions.create (with streaming)")
    return True


def _instrument_anthropic(
    *,
    environment_id: Optional[str],
    tags: Optional[list[str]],
) -> bool:
    """Monkey-patch ``anthropic.resources.messages.Messages.create``."""
    try:
        from anthropic.resources.messages import Messages
    except ImportError:
        logger.debug("anthropic not installed; skipping")
        return False

    if getattr(Messages.create, "_eden_instrumented", False):
        return True

    original_create = Messages.create

    @functools.wraps(original_create)
    async def traced_create(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        start = time.time()
        status = "success"
        error_type = None
        try:
            if _is_streaming_call(kwargs):
                response = await original_create(self, *args, **kwargs)
                return _wrap_anthropic_stream(
                    response,
                    model=str(kwargs.get("model", "?")),
                    environment_id=environment_id,
                    tags=tags,
                    provider="anthropic",
                )
            return await original_create(self, *args, **kwargs)
        except Exception as exc:
            status = "error"
            error_type = type(exc).__name__
            raise
        finally:
            if not _is_streaming_call(kwargs):
                duration_ms = int((time.time() - start) * 1000)
                _emit_provider_trace(
                    provider="anthropic",
                    model=kwargs.get("model", "?"),
                    environment_id=environment_id,
                    tags=tags,
                    duration_ms=duration_ms,
                    status=status,
                    error_type=error_type,
                )

    Messages.create = traced_create  # type: ignore[method-assign]
    Messages.create._eden_instrumented = True  # type: ignore[attr-defined]
    logger.info("Auto-instrumented anthropic.resources.messages.Messages.create (with streaming)")
    return True


def _instrument_langchain(
    *,
    environment_id: Optional[str],
    tags: Optional[list[str]],
) -> bool:
    """Monkey-patch ``langchain.chat_models.base.ChatModel._call`` /
    ``_agenerate`` to emit traces per chat call."""
    try:
        from langchain.chat_models.base import BaseChatModel
    except ImportError:
        logger.debug("langchain not installed; skipping")
        return False

    if getattr(BaseChatModel, "_eden_instrumented", False):
        return True

    original_agenerate = BaseChatModel._agenerate

    @functools.wraps(original_agenerate)
    async def traced_agenerate(self, messages, *args, **kwargs):  # type: ignore[no-untyped-def]
        start = time.time()
        status = "success"
        error_type = None
        try:
            return await original_agenerate(self, messages, *args, **kwargs)
        except Exception as exc:
            status = "error"
            error_type = type(exc).__name__
            raise
        finally:
            duration_ms = int((time.time() - start) * 1000)
            _emit_provider_trace(
                provider="langchain",
                model=getattr(self, "model_name", "?"),
                environment_id=environment_id,
                tags=tags,
                duration_ms=duration_ms,
                status=status,
                error_type=error_type,
            )

    BaseChatModel._agenerate = traced_agenerate
    BaseChatModel._eden_instrumented = True
    logger.info("Auto-instrumented langchain.chat_models.base.BaseChatModel")
    return True


def _emit_provider_trace(
    *,
    provider: str,
    model: str,
    environment_id: Optional[str],
    tags: Optional[list[str]],
    duration_ms: int,
    status: str,
    error_type: Optional[str],
) -> None:
    """Emit a trace event for a provider call. Mirrors the contract of
    ``_emit_trace`` for ``@trace_agent`` but uses provider-specific
    naming and tags. Telemetry errors are swallowed — instrumentation
    must never break the user's call."""
    try:
        from eden.observability.telemetry_collector import (
            get_telemetry_collector,
            TelemetryEvent,
            Realm,
        )
        event = TelemetryEvent(
            event_id=f"auto_{provider}_{int(time.time() * 1_000_000)}",
            event_type="llm_completion",
            realm=Realm.PRODUCTION,
            source_format="eden-auto-instrument",
            timestamp=None,  # collector fills
            payload={
                "provider": provider,
                "model": model,
                "environment_id": environment_id,
                "duration_ms": duration_ms,
                "status": status,
                "error_type": error_type,
            },
            tags=tags or ["auto_instrument"],
        )
        collector = get_telemetry_collector()
        try:
            loop = asyncio.get_running_loop()
            if loop.is_running():
                asyncio.create_task(collector.ingest(event))
        except RuntimeError:
            pass
    except Exception as exc:
        logger.debug(f"auto_instrument telemetry emit failed: {exc}")
