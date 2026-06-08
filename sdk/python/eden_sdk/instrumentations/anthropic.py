"""Auto-instrumentation for the ``anthropic`` Python SDK.

Patches ``anthropic.resources.messages.Messages.create`` for both the
sync and async clients. Emits ``anthropic`` format events.
"""

from __future__ import annotations

import functools
import logging
import time
from typing import Any, Optional

from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import TraceContext, current_trace
from eden_sdk.instrumentations.openai import _to_dict

logger = logging.getLogger("eden_sdk.instrumentation.anthropic")

_installed = False
_original_sync_create: Optional[Any] = None
_original_async_create: Optional[Any] = None


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
    response_payload: Optional[dict[str, Any]],
    duration_ms: float,
    error: Optional[str],
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

    trace_ctx: Optional[TraceContext] = current_trace()
    if trace_ctx is not None:
        payload.setdefault("trace_id", trace_ctx.trace_id)

    get_default_client().enqueue(
        TraceEvent(payload=payload, source_format="anthropic")
    )
