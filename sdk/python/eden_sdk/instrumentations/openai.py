"""Auto-instrumentation for the ``openai`` Python SDK.

Patches both the sync and async ``chat.completions.create`` methods.
For every call we build a payload shaped like the OpenAI ChatCompletion
response (plus the original request via ``request_payload``) and
enqueue it for the ``openai`` ingestion endpoint.

We deliberately do NOT inspect streaming responses token-by-token —
that lives in the streaming chunks endpoint (``/ingest/chunks``) and
the user is expected to wire it up explicitly. The patch is best-effort:
failures inside the instrumentation never propagate into user code.
"""

from __future__ import annotations

import functools
import logging
import time
from typing import Any, Optional

from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import TraceContext, current_trace

logger = logging.getLogger("eden_sdk.instrumentation.openai")

_installed = False
_original_sync_create: Optional[Any] = None
_original_async_create: Optional[Any] = None


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
    """Best-effort conversion of pydantic / dataclass / dict to a dict."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_dict(v) for v in obj]
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump()
        except Exception:  # noqa: BLE001
            pass
    if hasattr(obj, "to_dict"):
        try:
            return obj.to_dict()
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
        # Attach request for the decoder.
        payload.setdefault("request_payload", request_payload)

    trace_ctx: Optional[TraceContext] = current_trace()
    if trace_ctx is not None:
        payload.setdefault("trace_id", trace_ctx.trace_id)

    get_default_client().enqueue(TraceEvent(payload=payload, source_format="openai"))
