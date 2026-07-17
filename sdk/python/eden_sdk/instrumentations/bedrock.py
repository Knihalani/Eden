"""Auto-instrumentation for Amazon Bedrock (boto3 bedrock-runtime).

Patches ``invoke_model`` and ``converse`` when ``boto3`` is installed.
Best-effort: missing boto3 → install() raises; failures inside
instrumentation never propagate into user code.
"""

from __future__ import annotations

import functools
import json
import logging
import time
import uuid
from typing import Any

from eden_sdk._instrumentation_ids import _trace_id_or_random
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config

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


def _enqueue(
    *,
    operation: str,
    model: str | None,
    request: dict[str, Any],
    response: dict[str, Any] | None,
    duration_ms: float,
    error: str | None,
) -> None:
    payload: dict[str, Any] = {
        "event_id": f"eden_bedrock_{uuid.uuid4().hex[:16]}",
        "trace_id": _trace_id_or_random(),
        "event_type": "llm_completion",
        "name": f"bedrock.{operation}",
        "model": model,
        "duration_ms": duration_ms,
        "request_payload": {"operation": operation, **{k: request.get(k) for k in ("modelId", "messages") if k in request}},
        "response_payload": response,
        "source_format": "bedrock",
        "attributes": {"provider": "bedrock", "operation": operation},
    }
    if error:
        payload["error"] = error
        payload["outcome"] = "error"
    else:
        payload["outcome"] = "success"
    get_default_client().enqueue(TraceEvent(payload=payload, source_format="bedrock"))
