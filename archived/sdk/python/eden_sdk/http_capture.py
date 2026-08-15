"""Universal HTTP capture for OpenAI-compatible LLM API calls.

Patches ``httpx.Client`` and ``httpx.AsyncClient`` ``request`` so any
outbound call to a known LLM host is traced without framework-specific
instrumentation. This is Tier-2 fallback for custom agents and niche
frameworks.
"""

from __future__ import annotations

import functools
import json
import logging
import time
import uuid
from typing import Any
from urllib.parse import urlparse

from eden_sdk._instrumentation_ids import _trace_id_or_random
from eden_sdk.capture import capture_request_response, limits_from_config
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config

logger = logging.getLogger("eden_sdk.http_capture")

_installed = False
_original_sync_request: Any | None = None
_original_async_request: Any | None = None

_LLM_HOST_SUFFIXES = (
    "api.openai.com",
    "api.anthropic.com",
    "openrouter.ai",
    "api.groq.com",
    "generativelanguage.googleapis.com",
    "api.cohere.com",
    "api.mistral.ai",
    "api.together.xyz",
    "api.perplexity.ai",
    "api.x.ai",
    "bedrock-runtime.us-east-1.amazonaws.com",
    "bedrock-runtime.us-west-2.amazonaws.com",
    "bedrock-runtime.amazonaws.com",
    "aiplatform.googleapis.com",
    "us-central1-aiplatform.googleapis.com",
)

_LLM_PATH_FRAGMENTS = (
    "/v1/chat/completions",
    "/v1/messages",
    "/v1/completions",
    "/v1/embeddings",
)


def _detect_source_format(url: str) -> str | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    if any(host.endswith(suffix) or host == suffix for suffix in _LLM_HOST_SUFFIXES):
        if "anthropic" in host:
            return "anthropic"
        if "bedrock" in host:
            return "bedrock"
        if "googleapis" in host or "aiplatform" in host:
            return "gemini"
        return "openai"
    if any(fragment in path for fragment in _LLM_PATH_FRAGMENTS):
        return "openai"
    return None


def _parse_json_body(content: Any) -> dict[str, Any] | None:
    if content is None:
        return None
    if isinstance(content, dict):
        return content
    if isinstance(content, (bytes, bytearray)):
        try:
            return json.loads(content.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return None
    if isinstance(content, str):
        try:
            return json.loads(content)
        except Exception:  # noqa: BLE001
            return None
    return None


def _emit_http_event(
    *,
    source_format: str,
    url: str,
    method: str,
    request_body: dict[str, Any] | None,
    response_body: dict[str, Any] | None,
    status_code: int | None,
    duration_ms: float,
    error: str | None,
) -> None:
    cfg = get_config()
    if not cfg.enabled:
        return
    model = None
    if request_body:
        model = request_body.get("model")
    is_error = bool(error or (status_code and status_code >= 400))
    request_body, response_body, capture_attrs = capture_request_response(
        request_body,
        response_body,
        error=error or ("http_error" if is_error else None),
        duration_ms=duration_ms,
        limits=limits_from_config(cfg),
    )
    payload: dict[str, Any] = {
        "event_id": f"eden_http_{uuid.uuid4().hex[:16]}",
        "trace_id": _trace_id_or_random(),
        "event_type": "llm_completion",
        "name": f"http.{method.lower()}",
        "outcome": "error" if is_error else "success",
        "duration_ms": duration_ms,
        "model": model,
        "source_format": source_format,
        "attributes": {
            "http.url": url,
            "http.method": method,
            "http.status_code": status_code,
            "http.capture": True,
            **capture_attrs,
        },
        "request_payload": request_body,
        "response_payload": response_body,
        "tags": ["http-capture", source_format],
    }
    if error:
        payload["error"] = error
    get_default_client().enqueue(TraceEvent(payload=payload, source_format=source_format))


def _request_wants_stream(kwargs: dict[str, Any], req_body: dict[str, Any] | None) -> bool:
    """True when the caller asked for an SSE / streaming response body."""
    if req_body and req_body.get("stream") is True:
        return True
    headers = kwargs.get("headers") or {}
    if isinstance(headers, dict):
        accept = str(headers.get("Accept") or headers.get("accept") or "").lower()
        if "text/event-stream" in accept:
            return True
    return False


def _wrap_sync_request(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, method: str, url: str | Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        url_str = str(url)
        source_format = _detect_source_format(url_str)
        if source_format is None or not get_config().enabled:
            return original(self, method, url, **kwargs)
        req_body = _parse_json_body(kwargs.get("content") or kwargs.get("data") or kwargs.get("json"))
        streaming = _request_wants_stream(kwargs, req_body)
        t0 = time.perf_counter()
        try:
            response = original(self, method, url, **kwargs)
            resp_body = None
            if not streaming:
                try:
                    resp_body = _parse_json_body(response.content)
                except Exception:  # noqa: BLE001
                    pass
            _emit_http_event(
                source_format=source_format,
                url=url_str,
                method=str(method),
                request_body=req_body,
                response_body=resp_body,
                status_code=getattr(response, "status_code", None),
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
            )
            return response
        except Exception as exc:  # noqa: BLE001
            _emit_http_event(
                source_format=source_format,
                url=url_str,
                method=str(method),
                request_body=req_body,
                response_body=None,
                status_code=None,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=repr(exc),
            )
            raise

    return wrapper


def _wrap_async_request(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    async def wrapper(self, method: str, url: str | Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        url_str = str(url)
        source_format = _detect_source_format(url_str)
        if source_format is None or not get_config().enabled:
            return await original(self, method, url, **kwargs)
        req_body = _parse_json_body(kwargs.get("content") or kwargs.get("data") or kwargs.get("json"))
        streaming = _request_wants_stream(kwargs, req_body)
        t0 = time.perf_counter()
        try:
            response = await original(self, method, url, **kwargs)
            resp_body = None
            if not streaming:
                try:
                    resp_body = _parse_json_body(response.content)
                except Exception:  # noqa: BLE001
                    pass
            _emit_http_event(
                source_format=source_format,
                url=url_str,
                method=str(method),
                request_body=req_body,
                response_body=resp_body,
                status_code=getattr(response, "status_code", None),
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
            )
            return response
        except Exception as exc:  # noqa: BLE001
            _emit_http_event(
                source_format=source_format,
                url=url_str,
                method=str(method),
                request_body=req_body,
                response_body=None,
                status_code=None,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=repr(exc),
            )
            raise

    return wrapper


def install() -> None:
    """Patch httpx sync/async ``request`` for LLM URL capture."""
    global _installed, _original_sync_request, _original_async_request
    if _installed:
        return
    import httpx

    if _original_sync_request is None:
        _original_sync_request = httpx.Client.request
        httpx.Client.request = _wrap_sync_request(_original_sync_request)
    if _original_async_request is None:
        _original_async_request = httpx.AsyncClient.request
        httpx.AsyncClient.request = _wrap_async_request(_original_async_request)
    _installed = True
    logger.debug("eden: httpx request patched for HTTP capture")


def uninstall() -> None:
    """Reverse httpx patches."""
    global _installed, _original_sync_request, _original_async_request
    if not _installed:
        return
    import httpx

    if _original_sync_request is not None:
        httpx.Client.request = _original_sync_request
    if _original_async_request is not None:
        httpx.AsyncClient.request = _original_async_request
    _installed = False
    _original_sync_request = None
    _original_async_request = None
