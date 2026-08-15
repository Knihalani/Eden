"""Provider-routing ingestion decoders — FEAT-138.

Pure parsers that map common external router trace formats
(LiteLLM callbacks, Portkey ``x-portkey-*`` headers / span
attributes, OpenRouter per-response ``provider`` / ``model``
fields) into the canonical ``record_attempt`` field set.

Observe-not-replace: these decoders never choose routing —
they only translate what the customer's middleware already
decided.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from eden.services.observability.provider_routing import DECISIONS

RouterName = Literal["litellm", "portkey", "openrouter"]
ROUTERS: tuple[RouterName, ...] = ("litellm", "portkey", "openrouter")


class DecodedProviderRoutingAttempt(TypedDict):
    trace_id: str
    span_id: str
    attempted_provider: str
    attempted_model: str
    sequence_index: int
    decision: str
    failure_reason: str | None
    latency_ms: int | None
    ignored: bool
    router: RouterName | None


def _empty_decoded(*, ignored: bool = True, router: RouterName | None = None) -> DecodedProviderRoutingAttempt:
    return {
        "trace_id": "",
        "span_id": "",
        "attempted_provider": "",
        "attempted_model": "",
        "sequence_index": 0,
        "decision": "success",
        "failure_reason": None,
        "latency_ms": None,
        "ignored": ignored,
        "router": router,
    }


def _coerce_headers(headers: dict[str, Any] | None) -> dict[str, str]:
    if not headers:
        return {}
    return {str(k).lower(): str(v) for k, v in headers.items()}


def _first_str(*values: Any) -> str | None:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def _first_int(*values: Any, default: int = 0) -> int:
    for value in values:
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return default


def _latency_ms_from_seconds(seconds: Any) -> int | None:
    if seconds is None:
        return None
    try:
        return max(0, int(float(seconds) * 1000))
    except (TypeError, ValueError):
        return None


def _normalize_decision(raw: str | None, *, default: str = "success") -> str:
    if not raw:
        return default
    lowered = raw.strip().lower()
    aliases = {
        "ok": "success",
        "succeeded": "success",
        "complete": "success",
        "completed": "success",
        "fail": "abort",
        "failed": "abort",
        "error": "abort",
        "errored": "abort",
        "fallback_used": "fallback",
        "failover": "fallback",
        "retried": "retry",
    }
    decision = aliases.get(lowered, lowered)
    return decision if decision in DECISIONS else default


def _decision_from_status(
    *,
    status: str | None,
    error: Any = None,
    fallback_used: bool = False,
    retry_count: int = 0,
    is_final_failure: bool = False,
) -> str:
    if status:
        normalized = _normalize_decision(status, default="")
        if normalized:
            return normalized
    if error and fallback_used:
        return "fallback"
    if error and is_final_failure:
        return "abort"
    if error and retry_count > 0:
        return "retry"
    if error:
        return "abort"
    if fallback_used:
        return "fallback"
    if retry_count > 0:
        return "retry"
    return "success"


def _failure_reason(error: Any) -> str | None:
    if error is None:
        return None
    if isinstance(error, dict):
        message = _first_str(error.get("message"), error.get("error"), error.get("detail"))
        if message:
            return message[:1024]
    text = str(error).strip()
    return text[:1024] if text else None


def _metadata_dict(payload: dict[str, Any]) -> dict[str, Any]:
    direct = payload.get("metadata")
    if isinstance(direct, dict):
        return direct
    kwargs = payload.get("kwargs")
    if isinstance(kwargs, dict):
        litellm_params = kwargs.get("litellm_params")
        if isinstance(litellm_params, dict):
            nested = litellm_params.get("metadata")
            if isinstance(nested, dict):
                return nested
    standard = payload.get("standard_logging_object")
    if isinstance(standard, dict):
        nested = standard.get("metadata")
        if isinstance(nested, dict):
            return nested
    return {}


def _attributes_dict(attributes: dict[str, Any] | None) -> dict[str, Any]:
    if not attributes:
        return {}
    flat: dict[str, Any] = {}
    for key, value in attributes.items():
        flat[str(key)] = value
    nested = attributes.get("provider_routing")
    if isinstance(nested, dict):
        for key, value in nested.items():
            flat[f"provider_routing.{key}"] = value
    portkey = attributes.get("portkey")
    if isinstance(portkey, dict):
        for key, value in portkey.items():
            flat[f"portkey.{key}"] = value
    return flat


def decode_litellm_payload(
    payload: dict[str, Any],
    *,
    headers: dict[str, Any] | None = None,
    attributes: dict[str, Any] | None = None,
    trace_id: str | None = None,
    span_id: str | None = None,
) -> DecodedProviderRoutingAttempt:
    """Decode a LiteLLM callback / standard-logging payload."""
    _ = _coerce_headers(headers)
    attrs = _attributes_dict(attributes)
    metadata = _metadata_dict(payload or {})
    router_meta = metadata.get("litellm_router")
    if not isinstance(router_meta, dict):
        router_meta = {}

    standard = payload.get("standard_logging_object")
    if not isinstance(standard, dict):
        standard = {}

    attempted_provider = _first_str(
        payload.get("custom_llm_provider"),
        standard.get("custom_llm_provider"),
        metadata.get("custom_llm_provider"),
        attrs.get("litellm.custom_llm_provider"),
        attrs.get("provider_routing.attempted_provider"),
    )
    attempted_model = _first_str(
        payload.get("model"),
        standard.get("model"),
        metadata.get("model"),
        attrs.get("litellm.model"),
        attrs.get("provider_routing.attempted_model"),
    )
    resolved_trace_id = _first_str(
        trace_id,
        metadata.get("trace_id"),
        metadata.get("litellm_trace_id"),
        payload.get("litellm_trace_id"),
        attrs.get("provider_routing.trace_id"),
    )
    resolved_span_id = _first_str(
        span_id,
        metadata.get("span_id"),
        metadata.get("parent_otel_span"),
        attrs.get("provider_routing.span_id"),
    )

    if not all([attempted_provider, attempted_model, resolved_trace_id, resolved_span_id]):
        return _empty_decoded(router="litellm")

    retry_count = _first_int(
        payload.get("num_retries"),
        standard.get("num_retries"),
        router_meta.get("retry_count"),
        metadata.get("retry_count"),
        default=0,
    )
    fallback_used = bool(
        payload.get("fallback_key")
        or standard.get("fallback_key")
        or router_meta.get("fallback_used")
        or metadata.get("fallback_used")
    )
    status = _first_str(payload.get("status"), standard.get("status"))
    error = payload.get("exception") or payload.get("error_str") or standard.get("error_str")

    decision = _decision_from_status(
        status=status,
        error=error,
        fallback_used=fallback_used,
        retry_count=retry_count,
        is_final_failure=bool(error) and not fallback_used and retry_count == 0,
    )
    if _first_str(metadata.get("decision"), attrs.get("provider_routing.decision")):
        decision = _normalize_decision(
            _first_str(metadata.get("decision"), attrs.get("provider_routing.decision")),
            default=decision,
        )

    latency_ms = _first_int(
        payload.get("latency_ms"),
        metadata.get("latency_ms"),
        attrs.get("provider_routing.latency_ms"),
        default=-1,
    )
    if latency_ms < 0:
        latency_ms = _latency_ms_from_seconds(
            payload.get("response_time") or standard.get("response_time"),
        ) or 0

    return {
        "trace_id": resolved_trace_id or "",
        "span_id": resolved_span_id or "",
        "attempted_provider": attempted_provider or "",
        "attempted_model": attempted_model or "",
        "sequence_index": _first_int(
            metadata.get("sequence_index"),
            router_meta.get("sequence_index"),
            attrs.get("provider_routing.sequence_index"),
            retry_count,
            default=0,
        ),
        "decision": decision,
        "failure_reason": _failure_reason(error),
        "latency_ms": latency_ms,
        "ignored": False,
        "router": "litellm",
    }


def decode_portkey_payload(
    payload: dict[str, Any],
    *,
    headers: dict[str, Any] | None = None,
    attributes: dict[str, Any] | None = None,
    trace_id: str | None = None,
    span_id: str | None = None,
) -> DecodedProviderRoutingAttempt:
    """Decode Portkey response headers / span attributes."""
    hdrs = _coerce_headers(headers)
    attrs = _attributes_dict(attributes)
    body = payload or {}
    portkey_meta = body.get("_portkey_metadata")
    if not isinstance(portkey_meta, dict):
        portkey_meta = body.get("portkey_metadata")
    if not isinstance(portkey_meta, dict):
        portkey_meta = {}

    attempted_provider = _first_str(
        hdrs.get("x-portkey-provider"),
        portkey_meta.get("provider"),
        body.get("provider"),
        attrs.get("portkey.provider"),
        attrs.get("provider_routing.attempted_provider"),
    )
    attempted_model = _first_str(
        hdrs.get("x-portkey-model"),
        portkey_meta.get("model"),
        body.get("model"),
        attrs.get("portkey.model"),
        attrs.get("provider_routing.attempted_model"),
    )
    resolved_trace_id = _first_str(
        trace_id,
        hdrs.get("x-portkey-trace-id"),
        portkey_meta.get("trace_id"),
        body.get("trace_id"),
        attrs.get("portkey.trace_id"),
        attrs.get("provider_routing.trace_id"),
    )
    resolved_span_id = _first_str(
        span_id,
        hdrs.get("x-portkey-span-id"),
        portkey_meta.get("span_id"),
        body.get("span_id"),
        attrs.get("portkey.span_id"),
        attrs.get("provider_routing.span_id"),
    )

    if not all([attempted_provider, attempted_model, resolved_trace_id, resolved_span_id]):
        return _empty_decoded(router="portkey")

    retry_count = _first_int(
        hdrs.get("x-portkey-retry-attempt-count"),
        hdrs.get("x-portkey-retry-count"),
        portkey_meta.get("retry_count"),
        body.get("retry_count"),
        default=0,
    )
    fallback_used = (
        hdrs.get("x-portkey-last-used-option-index") not in (None, "", "0")
        or bool(portkey_meta.get("fallback_used") or body.get("fallback_used"))
    )
    status = _first_str(
        hdrs.get("x-portkey-response-status"),
        portkey_meta.get("status"),
        body.get("status"),
    )
    error = body.get("error") or portkey_meta.get("error")

    decision = _decision_from_status(
        status=status,
        error=error,
        fallback_used=fallback_used,
        retry_count=retry_count,
        is_final_failure=bool(error) and not fallback_used,
    )
    if _first_str(attrs.get("provider_routing.decision"), body.get("decision")):
        decision = _normalize_decision(
            _first_str(attrs.get("provider_routing.decision"), body.get("decision")),
            default=decision,
        )

    latency_ms = _first_int(
        body.get("latency_ms"),
        portkey_meta.get("latency_ms"),
        attrs.get("portkey.latency_ms"),
        attrs.get("provider_routing.latency_ms"),
        default=-1,
    )
    if latency_ms < 0:
        latency_ms = _latency_ms_from_seconds(
            portkey_meta.get("latency") or body.get("latency"),
        ) or 0

    return {
        "trace_id": resolved_trace_id or "",
        "span_id": resolved_span_id or "",
        "attempted_provider": attempted_provider or "",
        "attempted_model": attempted_model or "",
        "sequence_index": _first_int(
            hdrs.get("x-portkey-last-used-option-index"),
            portkey_meta.get("sequence_index"),
            body.get("sequence_index"),
            attrs.get("provider_routing.sequence_index"),
            retry_count,
            default=0,
        ),
        "decision": decision,
        "failure_reason": _failure_reason(error),
        "latency_ms": latency_ms,
        "ignored": False,
        "router": "portkey",
    }


def decode_openrouter_payload(
    payload: dict[str, Any],
    *,
    headers: dict[str, Any] | None = None,
    attributes: dict[str, Any] | None = None,
    trace_id: str | None = None,
    span_id: str | None = None,
) -> DecodedProviderRoutingAttempt:
    """Decode OpenRouter per-response provider/model metadata."""
    hdrs = _coerce_headers(headers)
    attrs = _attributes_dict(attributes)
    body = payload or {}
    route_meta = body.get("route")
    if not isinstance(route_meta, dict):
        route_meta = body.get("routing")
    if not isinstance(route_meta, dict):
        route_meta = {}

    attempted_provider = _first_str(
        body.get("provider"),
        route_meta.get("provider"),
        hdrs.get("x-openrouter-provider"),
        attrs.get("openrouter.provider"),
        attrs.get("provider_routing.attempted_provider"),
    )
    attempted_model = _first_str(
        body.get("model"),
        route_meta.get("model"),
        attrs.get("openrouter.model"),
        attrs.get("provider_routing.attempted_model"),
    )
    resolved_trace_id = _first_str(
        trace_id,
        body.get("trace_id"),
        route_meta.get("trace_id"),
        hdrs.get("x-openrouter-trace-id"),
        attrs.get("provider_routing.trace_id"),
    )
    resolved_span_id = _first_str(
        span_id,
        body.get("span_id"),
        route_meta.get("span_id"),
        hdrs.get("x-openrouter-span-id"),
        attrs.get("provider_routing.span_id"),
    )

    if not all([attempted_provider, attempted_model, resolved_trace_id, resolved_span_id]):
        return _empty_decoded(router="openrouter")

    error = body.get("error")
    route_type = _first_str(
        route_meta.get("type"),
        route_meta.get("route_type"),
        body.get("route_type"),
    )
    retry_count = _first_int(
        route_meta.get("retry_count"),
        body.get("retry_count"),
        default=0,
    )
    fallback_used = route_type in {"fallback", "failover"} or bool(
        route_meta.get("fallback_used") or body.get("fallback_used"),
    )

    decision = _decision_from_status(
        status=route_type,
        error=error,
        fallback_used=fallback_used,
        retry_count=retry_count,
        is_final_failure=bool(error),
    )
    if _first_str(attrs.get("provider_routing.decision"), body.get("decision")):
        decision = _normalize_decision(
            _first_str(attrs.get("provider_routing.decision"), body.get("decision")),
            default=decision,
        )

    latency_ms = _first_int(
        body.get("latency_ms"),
        route_meta.get("latency_ms"),
        attrs.get("provider_routing.latency_ms"),
        default=-1,
    )
    if latency_ms < 0:
        latency_ms = _latency_ms_from_seconds(body.get("latency")) or 0

    return {
        "trace_id": resolved_trace_id or "",
        "span_id": resolved_span_id or "",
        "attempted_provider": attempted_provider or "",
        "attempted_model": attempted_model or "",
        "sequence_index": _first_int(
            route_meta.get("sequence_index"),
            body.get("sequence_index"),
            attrs.get("provider_routing.sequence_index"),
            retry_count,
            default=0,
        ),
        "decision": decision,
        "failure_reason": _failure_reason(error),
        "latency_ms": latency_ms,
        "ignored": False,
        "router": "openrouter",
    }


def detect_router(
    payload: dict[str, Any],
    *,
    headers: dict[str, Any] | None = None,
    attributes: dict[str, Any] | None = None,
) -> RouterName | None:
    """Best-effort router detection for auto-ingest."""
    hdrs = _coerce_headers(headers)
    body = payload or {}
    attrs = _attributes_dict(attributes)

    if any(key.startswith("x-portkey-") for key in hdrs):
        return "portkey"
    if body.get("_portkey_metadata") or body.get("portkey_metadata"):
        return "portkey"
    if any(key.startswith("portkey.") for key in attrs):
        return "portkey"

    if body.get("provider") and (
        body.get("route") is not None
        or body.get("routing") is not None
        or hdrs.get("x-openrouter-provider")
    ):
        return "openrouter"
    if any(key.startswith("openrouter.") for key in attrs):
        return "openrouter"

    if (
        body.get("custom_llm_provider")
        or body.get("standard_logging_object")
        or body.get("litellm_trace_id")
        or any(key.startswith("litellm.") for key in attrs)
    ):
        return "litellm"
    metadata = _metadata_dict(body)
    if metadata.get("litellm_trace_id") or metadata.get("litellm_router"):
        return "litellm"

    return None


def decode_provider_routing_payload(
    router: RouterName | Literal["auto"],
    payload: dict[str, Any],
    *,
    headers: dict[str, Any] | None = None,
    attributes: dict[str, Any] | None = None,
    trace_id: str | None = None,
    span_id: str | None = None,
) -> DecodedProviderRoutingAttempt:
    """Dispatch to the router-specific decoder."""
    resolved_router = router
    if router == "auto":
        detected = detect_router(payload, headers=headers, attributes=attributes)
        if detected is None:
            return _empty_decoded(router=None)
        resolved_router = detected

    decoders = {
        "litellm": decode_litellm_payload,
        "portkey": decode_portkey_payload,
        "openrouter": decode_openrouter_payload,
    }
    decoder = decoders[resolved_router]
    decoded = decoder(
        payload,
        headers=headers,
        attributes=attributes,
        trace_id=trace_id,
        span_id=span_id,
    )
    decoded["router"] = None if resolved_router == "auto" else resolved_router
    return decoded


__all__ = [
    "ROUTERS",
    "DecodedProviderRoutingAttempt",
    "RouterName",
    "decode_litellm_payload",
    "decode_openrouter_payload",
    "decode_portkey_payload",
    "decode_provider_routing_payload",
    "detect_router",
]
