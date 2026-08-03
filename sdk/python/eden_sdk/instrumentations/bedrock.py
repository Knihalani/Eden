"""Auto-instrumentation for Amazon Bedrock (boto3 bedrock-runtime).

Patches ``invoke_model`` and ``converse`` when ``boto3`` is installed.
Best-effort: missing boto3 → install() raises; failures inside
instrumentation never propagate into user code.
"""

from __future__ import annotations

import functools
import json
import logging
import secrets
import time
import uuid
from typing import Any

from eden_sdk._instrumentation_ids import _trace_id_or_random
from eden_sdk._tokens import extract_usage, normalize_model_name
from eden_sdk.capture import capture_request_response, limits_from_config
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import current_span

logger = logging.getLogger("eden_sdk.instrumentation.bedrock")

_installed = False
_originals: dict[str, Any] = {}


def install() -> None:
    global _installed
    if _installed:
        return
    try:
        import boto3  # noqa: F401
        from botocore.client import BaseClient
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"boto3/botocore not importable: {exc}") from exc

    # Patch BaseClient._make_api_call for bedrock-runtime operations.
    if "make_api_call" not in _originals:
        _originals["make_api_call"] = BaseClient._make_api_call
        BaseClient._make_api_call = _wrap_make_api_call(_originals["make_api_call"])
    _installed = True
    logger.debug("eden: bedrock boto3 client patched")


def uninstall() -> None:
    global _installed
    if not _installed:
        return
    try:
        from botocore.client import BaseClient

        if "make_api_call" in _originals:
            BaseClient._make_api_call = _originals["make_api_call"]
    except Exception:  # noqa: BLE001
        pass
    _originals.clear()
    _installed = False


_BEDROCK_OPS = frozenset(
    {
        "InvokeModel",
        "InvokeModelWithResponseStream",
        "Converse",
        "ConverseStream",
    }
)


def _wrap_make_api_call(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, operation_name, kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        service = getattr(getattr(self, "meta", None), "service_model", None)
        service_name = getattr(service, "service_name", "") if service else ""
        if (
            not cfg.enabled
            or service_name not in {"bedrock-runtime", "bedrock"}
            or operation_name not in _BEDROCK_OPS
        ):
            return original(self, operation_name, kwargs)
        t0 = time.perf_counter()
        model_id = None
        if isinstance(kwargs, dict):
            model_id = kwargs.get("modelId") or kwargs.get("model_id")
        try:
            resp = original(self, operation_name, kwargs)
            _enqueue(
                operation=operation_name,
                model=model_id,
                request=kwargs if isinstance(kwargs, dict) else {},
                response=_safe_dict(resp),
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
            )
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue(
                operation=operation_name,
                model=model_id,
                request=kwargs if isinstance(kwargs, dict) else {},
                response=None,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=repr(exc),
            )
            raise

    return wrapper


def _safe_dict(obj: Any) -> dict[str, Any] | None:
    if obj is None:
        return None
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if k == "body" and hasattr(v, "read"):
                try:
                    raw = v.read()
                    if hasattr(v, "seek"):
                        v.seek(0)
                    out[k] = json.loads(raw) if isinstance(raw, (bytes, bytearray, str)) else raw
                except Exception:  # noqa: BLE001
                    out[k] = "<unreadable>"
            else:
                out[k] = v
        return out
    return {"raw": str(obj)[:500]}


def _extract_bedrock_usage(response: dict[str, Any] | None) -> dict[str, int | None]:
    """Normalize token usage out of a Bedrock response.

    Covers two shapes:
      - Converse / ConverseStream: ``{"usage": {"inputTokens": ..., ...}}``
        directly on the response.
      - InvokeModel: usage lives inside the JSON-decoded ``body``
        (already decoded by :func:`_safe_dict`), and its field names
        vary per model family — Anthropic-on-Bedrock mirrors the
        native Anthropic ``usage`` shape; Titan and Llama use their
        own bespoke top-level fields.
    """
    empty: dict[str, int | None] = {
        "input_tokens": None,
        "output_tokens": None,
        "cache_read_tokens": None,
        "cache_creation_tokens": None,
    }
    if not isinstance(response, dict):
        return empty

    usage = response.get("usage")
    if isinstance(usage, dict):
        u = extract_usage(usage)
        if u["input_tokens"] is not None or u["output_tokens"] is not None:
            return u

    body = response.get("body")
    if isinstance(body, dict):
        inner_usage = body.get("usage")
        if isinstance(inner_usage, dict):
            u = extract_usage(inner_usage)
            if u["input_tokens"] is not None or u["output_tokens"] is not None:
                return u
        # Titan / Llama expose token counts as bespoke top-level
        # fields rather than a nested ``usage`` object — fold them
        # into the shared ``extract_usage``-compatible key names.
        synthetic: dict[str, Any] = {}
        if isinstance(body.get("inputTextTokenCount"), (int, float)):
            synthetic["input_tokens"] = body["inputTextTokenCount"]
        if isinstance(body.get("prompt_token_count"), (int, float)):
            synthetic["input_tokens"] = body["prompt_token_count"]
        if isinstance(body.get("generation_token_count"), (int, float)):
            synthetic["output_tokens"] = body["generation_token_count"]
        results = body.get("results")
        if isinstance(results, list) and results and isinstance(results[0], dict):
            tc = results[0].get("tokenCount")
            if isinstance(tc, (int, float)):
                synthetic["output_tokens"] = tc
        if synthetic:
            return extract_usage(synthetic)

    return empty


def _extract_bedrock_total_tokens(response: dict[str, Any] | None) -> int | None:
    """Bedrock's Converse API also reports a provider-computed ``totalTokens``."""
    if not isinstance(response, dict):
        return None
    usage = response.get("usage")
    if isinstance(usage, dict):
        t = usage.get("totalTokens")
        if isinstance(t, (int, float)):
            return int(t)
    return None


def _enqueue(
    *,
    operation: str,
    model: str | None,
    request: dict[str, Any],
    response: dict[str, Any] | None,
    duration_ms: float,
    error: str | None,
) -> None:
    usage = _extract_bedrock_usage(response)
    total_tokens = _extract_bedrock_total_tokens(response)
    raw_request_payload = {
        "operation": operation,
        **{k: request.get(k) for k in ("modelId", "messages") if k in request},
    }
    request_payload, response_payload, capture_attrs = capture_request_response(
        raw_request_payload,
        response,
        error=error,
        duration_ms=duration_ms,
        limits=limits_from_config(get_config()),
    )
    payload: dict[str, Any] = {
        "event_id": f"eden_bedrock_{uuid.uuid4().hex[:16]}",
        "trace_id": _trace_id_or_random(),
        "span_id": secrets.token_hex(8),
        "event_type": "llm_completion",
        "name": f"bedrock.{operation}",
        "model": model,
        "model_normalized": normalize_model_name(model) if model else None,
        "duration_ms": duration_ms,
        "request_payload": request_payload,
        "response_payload": response_payload,
        "source_format": "bedrock",
        "attributes": {"provider": "bedrock", "operation": operation, **capture_attrs},
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "cache_read_input_tokens": usage["cache_read_tokens"],
        "cache_creation_input_tokens": usage["cache_creation_tokens"],
    }
    _cur = current_span()
    if _cur is not None:
        payload["parent_span_id"] = _cur.span_id
    if total_tokens is not None:
        payload["total_tokens"] = total_tokens
    if error:
        payload["error"] = error
        payload["outcome"] = "error"
        attrs = payload["attributes"]
        attrs.setdefault("error", error)
        attrs.setdefault("eden.error", error)
    else:
        payload["outcome"] = "success"
    get_default_client().enqueue(TraceEvent(payload=payload, source_format="bedrock"))
