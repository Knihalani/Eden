"""OTel OTLP/HTTP-JSON trace decoder.

Maps OpenTelemetry Protocol trace exports to ``TelemetryEvent`` using
the OTel GenAI semantic conventions
(``https://opentelemetry.io/docs/specs/semconv/gen-ai/``).

Two on-the-wire shapes are accepted:

1. **OTLP/HTTP JSON** (the standard HTTP/JSON encoding of OTLP)::

       {
         "resourceSpans": [{
           "resource": {"attributes": [{"key": ..., "value": {"stringValue": ...}}]},
           "scopeSpans": [{
             "scope": {"name": ..., "version": ...},
             "spans": [/* OTLP Span */]
           }]
         }]
       }

2. **OTLP/HTTP protobuf** (``Content-Type: application/x-protobuf``).
   The route layer does not decode protobuf directly — the request body
   for protobuf submissions is rejected with 415 and a pointer to use
   the JSON encoding or the gRPC receiver. The gRPC receiver lives
   outside the FastAPI process (see ``otel_grpc.py``, separate work).

Span fields consumed:
  - ``traceId`` / ``spanId`` / ``parentSpanId``
  - ``name`` / ``kind`` / ``startTimeUnixNano`` / ``endTimeUnixNano``
  - ``attributes`` (any of: ``gen_ai.*``, ``acme.eden.*``, deployment
    hints, service hints, error.type)
  - ``events`` (gen_ai.user.message / gen_ai.assistant.message are
    stored in ``payload["events"]`` per the OTel guidance to keep
    content out of attributes)
  - ``status.code`` → outcome
"""

from __future__ import annotations

import contextlib
import json
import logging
from datetime import UTC
from typing import Any

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import SchemaInvalidError
from eden.observability.ingestion.normalizer import normalize_to_telemetry_event
from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


# ── OTLP AnyValue decoder ────────────────────────────────────────────
# OTLP wraps every attribute value in a single ``AnyValue`` with one of
# ``stringValue`` / ``boolValue`` / ``intValue`` / ``doubleValue`` /
# ``arrayValue`` / ``kvlistValue`` / ``bytesValue``. Decode to native
# Python so downstream code can compare / display them.


def _decode_any_value(any_val: Any) -> Any:
    """Decode an OTLP AnyValue into a native Python value.

    Accepts both the wrapped form (``{"stringValue": "x"}``) and the
    already-decoded form (just ``"x"``), for resilience.
    """
    if any_val is None:
        return None
    if not isinstance(any_val, dict):
        return any_val

    if "stringValue" in any_val:
        return str(any_val["stringValue"])
    if "boolValue" in any_val:
        return bool(any_val["boolValue"])
    if "intValue" in any_val:
        v = any_val["intValue"]
        try:
            return int(v)
        except (TypeError, ValueError):
            return v
    if "doubleValue" in any_val:
        v = any_val["doubleValue"]
        try:
            return float(v)
        except (TypeError, ValueError):
            return v
    if "arrayValue" in any_val:
        arr = any_val["arrayValue"].get("values", []) if isinstance(
            any_val["arrayValue"], dict
        ) else []
        return [_decode_any_value(v) for v in arr]
    if "kvlistValue" in any_val:
        kvs = any_val["kvlistValue"].get("values", []) if isinstance(
            any_val["kvlistValue"], dict
        ) else []
        return {
            str(kv.get("key", "")): _decode_any_value(kv.get("value"))
            for kv in kvs
        }
    if "bytesValue" in any_val:
        return any_val["bytesValue"]
    # Unknown shape — return as-is.
    return any_val


def _decode_attributes(attrs: list[dict[str, Any]] | dict[str, Any]) -> dict[str, Any]:
    """Decode an OTLP ``Span.attributes`` list to ``{key: native}``.

    Accepts both the wire form (list of ``{"key", "value"}``) and a
    pre-decoded dict (for tests / callers that already converted).
    """
    if isinstance(attrs, dict):
        return dict(attrs)
    out: dict[str, Any] = {}
    for kv in attrs or []:
        if not isinstance(kv, dict):
            continue
        key = str(kv.get("key", ""))
        if not key:
            continue
        out[key] = _decode_any_value(kv.get("value"))
    return out


# ── Time helpers ─────────────────────────────────────────────────────

_NS_PER_MS = 1_000_000


def _ns_to_iso(ns: int | str) -> str:
    """OTLP times are in nanoseconds since epoch. Convert to ISO 8601."""
    try:
        ns_int = int(ns)
    except (TypeError, ValueError):
        return _now_iso()
    if ns_int <= 0:
        return _now_iso()
    seconds = ns_int / 1e9
    return _iso_from_seconds(seconds)


def _seconds_to_ms(value: Any) -> float | None:
    """Convert a seconds-valued OTel attribute to milliseconds.

    OTel standard ``gen_ai.*.duration`` and ``time_to_first_token``
    attributes are in seconds. Returns ``None`` if the value is not
    a number so the caller can skip it cleanly.
    """
    if value is None:
        return None
    try:
        return float(value) * 1000.0
    except (TypeError, ValueError):
        return None


def _iso_from_seconds(seconds: float) -> str:
    from datetime import datetime
    return datetime.fromtimestamp(seconds, tz=UTC).isoformat()


def _now_iso() -> str:
    from datetime import datetime
    return datetime.now(UTC).isoformat()


def _ns_diff_ms(start_ns: int | str, end_ns: int | str) -> float | None:
    try:
        s = int(start_ns)
        e = int(end_ns)
    except (TypeError, ValueError):
        return None
    if s <= 0 or e <= 0 or e < s:
        return None
    return (e - s) / _NS_PER_MS


# ── Span → TelemetryEvent shape mapper ───────────────────────────────

_GEN_AI_EVENT_NAMES = frozenset({
    "gen_ai.system.message",
    "gen_ai.user.message",
    "gen_ai.assistant.message",
    "gen_ai.tool.message",
})


def _span_to_raw_dict(
    span: dict[str, Any],
    resource_attrs: dict[str, Any],
    scope: dict[str, Any],
) -> dict[str, Any]:
    """Map an OTLP Span + its resource/scope context to the intermediate
    dict that ``normalize_to_telemetry_event`` consumes.

    The mapping follows the OTel GenAI semantic conventions:
      - ``gen_ai.operation.name`` → event_type
      - ``gen_ai.request.model`` / ``gen_ai.response.model`` → name + payload
      - ``gen_ai.usage.input_tokens`` / ``output_tokens`` → metrics
      - ``gen_ai.response.finish_reasons`` → payload
      - ``gen_ai.conversation.id`` → attributes
      - ``error.type`` → outcome = failure
      - ``status.code`` STATUS_CODE_ERROR → outcome = failure
      - ``deployment.environment.name`` → realm (env vs production)
      - ``service.name`` → attributes
    """
    attrs = _decode_attributes(span.get("attributes", []))

    # ── event_type from operation ────────────────────────────────────
    operation = attrs.get("gen_ai.operation.name") or "span"
    event_type = f"otel.{operation}"

    # ── name: prefer gen_ai.request.model, fall back to span name ───
    model = (
        attrs.get("gen_ai.response.model")
        or attrs.get("gen_ai.request.model")
        or span.get("name", "")
    )

    # ── realm: deployment.environment.name → environment if set ────
    realm = "production"
    env_name = str(
        attrs.get("deployment.environment.name")
        or resource_attrs.get("deployment.environment.name")
        or ""
    ).lower()
    if env_name in ("dev", "staging", "test", "env", "environment", "sandbox"):
        realm = "environment"

    # ── metrics: token usage, duration, streaming ──────────────────
    # Maps the standard OpenTelemetry GenAI client-side attributes
    # into the ``metrics`` JSONB so they show up in heatmaps, timelines,
    # and per-trace breakdowns without per-source plumbing.
    metrics: dict[str, float] = {}

    def _add_metric(key: str, value: Any) -> None:
        """Add a float to ``metrics`` if the value coerces; silently
        drop anything that isn't a number."""
        if value is None:
            return
        with contextlib.suppress(TypeError, ValueError):
            metrics[key] = float(value)

    # Token usage (canonical)
    _add_metric("input_tokens", attrs.get("gen_ai.usage.input_tokens"))
    _add_metric("output_tokens", attrs.get("gen_ai.usage.output_tokens"))

    # Caching — Anthropic / OpenAI / OpenRouter all report cache reads
    # in the same `gen_ai.usage.cache_read.*` namespace; map them so
    # the portal can break cache-hit savings out of the cost story.
    _add_metric("cache_read_tokens",
                attrs.get("gen_ai.usage.cache_read.input_tokens"))
    _add_metric("cache_creation_tokens",
                attrs.get("gen_ai.usage.cache_creation.input_tokens"))

    # Client- and server-side duration / TTFT (OpenTelemetry standard).
    # ``gen_ai.client.operation.duration`` is in seconds, the canonical
    # OTel unit for this histogram — convert to ms for consistency
    # with the rest of the metrics surface.
    _add_metric("duration_ms_otel",
                _seconds_to_ms(attrs.get("gen_ai.client.operation.duration")))
    _add_metric("server_request_duration_ms",
                _seconds_to_ms(attrs.get("gen_ai.server.request.duration")))
    _add_metric("ttft_ms",
                _seconds_to_ms(attrs.get("gen_ai.server.time_to_first_token")))
    # Some SDKs emit ttft directly in ms under a non-standard key.
    _add_metric("ttft_ms", attrs.get("time_to_first_token"))
    _add_metric("ttft_ms", attrs.get("ttft_ms"))

    # ── duration_ms ─────────────────────────────────────────────────
    duration_ms = _ns_diff_ms(
        span.get("startTimeUnixNano", 0),
        span.get("endTimeUnixNano", 0),
    )

    # ── outcome from status.code + error.type ──────────────────────
    status = span.get("status") or {}
    status_code = str(status.get("code", "")).upper()
    error_type = attrs.get("error.type")
    if status_code == "STATUS_CODE_ERROR" or error_type:
        outcome = "failure"
    elif status_code == "STATUS_CODE_OK":
        outcome = "success"
    else:
        outcome = None

    # ── payload: model, finish reasons, response.id, full attrs ────
    payload: dict[str, Any] = {
        "otel": {
            "span_kind": span.get("kind"),
            "operation": operation,
            "request_model": attrs.get("gen_ai.request.model"),
            "response_model": attrs.get("gen_ai.response.model"),
            "provider": attrs.get("gen_ai.provider.name"),
            "response_id": attrs.get("gen_ai.response.id"),
            "finish_reasons": attrs.get("gen_ai.response.finish_reasons"),
            "request_temperature": attrs.get("gen_ai.request.temperature"),
            "request_max_tokens": attrs.get("gen_ai.request.max_tokens"),
            "request_top_p": attrs.get("gen_ai.request.top_p"),
            "request_stream": attrs.get("gen_ai.request.stream"),
            "tool_definitions": attrs.get("gen_ai.tool.definitions"),
        },
        "resource": dict(resource_attrs),
    }
    # Strip None values for a cleaner payload.
    payload["otel"] = {k: v for k, v in payload["otel"].items() if v is not None}

    # ── span events → payload["events"] + Phase 7.2 capture fields ──
    events: list[dict[str, Any]] = []
    request_messages: list[dict[str, Any]] = []
    response_choices: list[dict[str, Any]] = []
    system_blocks: list[dict[str, Any]] = []
    tool_calls_full: list[dict[str, Any]] = []
    tool_results: list[dict[str, Any]] = []
    image_blocks: list[dict[str, Any]] = []
    for ev in span.get("events") or []:
        ev_attrs = _decode_attributes(ev.get("attributes", []))
        events.append({
            "name": ev.get("name", ""),
            "time_ns": ev.get("timeUnixNano"),
            "attributes": ev_attrs,
        })
        # OTel GenAI convention: content lives on span events, not on
        # attributes. Map the canonical event names to the new capture
        # fields so the transcript view can render them.
        ev_name = ev.get("name", "")
        if ev_name == "gen_ai.user.message":
            request_messages.append({
                "role": "user",
                "content": ev_attrs.get("content"),
            })
            for img in (ev_attrs.get("images") or []):
                if isinstance(img, dict):
                    image_blocks.append(img)
        elif ev_name == "gen_ai.system.message":
            system_blocks.append({
                "role": "system",
                "content": ev_attrs.get("content"),
            })
        elif ev_name == "gen_ai.assistant.message":
            response_choices.append({
                "message": {
                    "role": "assistant",
                    "content": ev_attrs.get("content"),
                    "tool_calls": ev_attrs.get("tool_calls"),
                },
                "finish_reason": ev_attrs.get("finish_reason"),
            })
        elif ev_name == "gen_ai.choice":
            response_choices.append({
                "index": ev_attrs.get("index"),
                "message": ev_attrs.get("message"),
                "finish_reason": ev_attrs.get("finish_reason"),
            })
        elif ev_name == "gen_ai.tool.message":
            if ev_attrs.get("role") == "tool" or ev_attrs.get("id"):
                # Tool result (the SDK emits these as the response side
                # of a tool call).
                tool_results.append({
                    "tool_call_id": ev_attrs.get("id"),
                    "content": ev_attrs.get("content"),
                })
            else:
                # Tool definition (assistant's tool_use block).
                tool_calls_full.append({
                    "id": ev_attrs.get("id"),
                    "name": ev_attrs.get("name"),
                    "arguments": ev_attrs.get("arguments") or ev_attrs.get("input"),
                })
        elif ev_name == "gen_ai.content":
            content_type = ev_attrs.get("type", "")
            if content_type == "image" or "image" in str(content_type).lower():
                image_blocks.append({
                    "role": ev_attrs.get("role"),
                    "content_type": ev_attrs.get("mime_type") or ev_attrs.get("media_type"),
                    "data_b64": ev_attrs.get("data"),
                    "url": ev_attrs.get("url"),
                })
    if events:
        payload["events"] = events

    # ── Build request_body / response_body from span events ─────────
    request_body: dict[str, Any] | None = None
    if request_messages or system_blocks:
        request_body = {
            "messages": request_messages,
            "system": system_blocks[0]["content"] if system_blocks else None,
            "model": attrs.get("gen_ai.request.model"),
            "temperature": attrs.get("gen_ai.request.temperature"),
            "max_tokens": attrs.get("gen_ai.request.max_tokens"),
            "top_p": attrs.get("gen_ai.request.top_p"),
            "stream": attrs.get("gen_ai.request.stream"),
            "tools": attrs.get("gen_ai.tool.definitions"),
        }
        request_body = {k: v for k, v in request_body.items() if v is not None}

    response_body: dict[str, Any] | None = None
    if response_choices:
        response_body = {
            "id": attrs.get("gen_ai.response.id"),
            "model": attrs.get("gen_ai.response.model"),
            "choices": response_choices,
            "finish_reasons": attrs.get("gen_ai.response.finish_reasons"),
            "usage": {
                "input_tokens": attrs.get("gen_ai.usage.input_tokens"),
                "output_tokens": attrs.get("gen_ai.usage.output_tokens"),
                "cache_read_input_tokens": attrs.get("gen_ai.usage.cache_read.input_tokens"),
                "cache_creation_input_tokens": attrs.get("gen_ai.usage.cache_creation.input_tokens"),
            },
        }
        response_body = {k: v for k, v in response_body.items() if v is not None}

    # ── attributes: name, scope, gen_ai.conversation.id, service ──
    attributes: dict[str, str] = {
        "otel.span.kind": str(span.get("kind", "")),
        "otel.scope.name": str(scope.get("name", "")),
        "otel.scope.version": str(scope.get("version", "")),
        "otel.status.code": status_code,
    }
    if service_name := resource_attrs.get("service.name"):
        attributes["service.name"] = str(service_name)
    if conv_id := attrs.get("gen_ai.conversation.id"):
        attributes["gen_ai.conversation.id"] = str(conv_id)
    if provider := attrs.get("gen_ai.provider.name"):
        attributes["gen_ai.provider.name"] = str(provider)

    # ── tags: deployment / environment hints, error.type ──────────
    tags: list[str] = ["otel"]
    if service_name := resource_attrs.get("service.name"):
        tags.append(f"service:{service_name}")
    if env_name:
        tags.append(f"env:{env_name}")
    if error_type:
        tags.append(f"error:{error_type}")

    # ── timestamp from startTimeUnixNano ───────────────────────────
    timestamp = _ns_to_iso(span.get("startTimeUnixNano", 0))

    # ── event_id from spanId (stable, unique) ──────────────────────
    event_id = str(span.get("spanId", ""))

    return {
        "event_id": event_id,
        "trace_id": str(span.get("traceId", "")),
        "span_id": str(span.get("spanId", "")),
        "parent_span_id": (
            str(span.get("parentSpanId"))
            if span.get("parentSpanId") else None
        ),
        "name": str(model) if model else None,
        "event_type": event_type,
        "timestamp": timestamp,
        "realm": realm,
        "duration_ms": duration_ms,
        "payload": payload,
        "metrics": metrics,
        "attributes": attributes,
        "tags": tags,
        "outcome": outcome,
        # Phase 7.2 — full capture fields.
        "request_body": request_body,
        "response_body": response_body,
        "reasoning": _extract_otel_reasoning(attrs),
        "tool_calls_full": tool_calls_full,
        "tool_results": tool_results,
        "images": image_blocks,
        "audio": [],
        "logprobs": _extract_otel_logprobs(attrs),
        "citations": _extract_otel_citations(attrs),
        "finish_reason": _first_finish_reason(attrs.get("gen_ai.response.finish_reasons")),
        "stop_sequence": None,
        "system_fingerprint": attrs.get("gen_ai.response.model"),
        "cache_hit": bool(attrs.get("gen_ai.usage.cache_read.input_tokens")),
        "prompt_cache_savings_usd": None,
        "model_version": attrs.get("gen_ai.response.model"),
        "service_tier": None,
    }


def _extract_otel_reasoning(attrs: dict[str, Any]) -> dict[str, Any] | None:
    """OTel GenAI surfaces reasoning via gen_ai.usage.reasoning_tokens or
    via separate gen_ai.usage.* attributes depending on the SDK."""
    out: dict[str, Any] = {}
    if attrs.get("gen_ai.usage.reasoning_tokens") is not None:
        out["o1_tokens"] = attrs["gen_ai.usage.reasoning_tokens"]
    if attrs.get("gen_ai.output.type") == "reasoning":
        out["type"] = "reasoning"
    return out or None


def _extract_otel_logprobs(attrs: dict[str, Any]) -> dict[str, Any] | None:
    """OTel's `gen_ai.choice.logprobs` attribute, if the SDK set it."""
    lp = attrs.get("gen_ai.choice.logprobs")
    return lp if isinstance(lp, dict) else None


def _extract_otel_citations(attrs: dict[str, Any]) -> list[dict[str, Any]]:
    """OTel `gen_ai.citation` attributes if the SDK surfaces search
    citations (e.g. o3 search-preview)."""
    citations = attrs.get("gen_ai.citations") or attrs.get("gen_ai.citation")
    if isinstance(citations, list):
        return [c for c in citations if isinstance(c, dict)]
    if isinstance(citations, dict):
        return [citations]
    return []


def _first_finish_reason(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        return str(value[0]) if value else None
    return str(value)


# ── Decoder ──────────────────────────────────────────────────────────


class OtelDecoder:
    """OTel OTLP/HTTP-JSON trace decoder."""

    source_format = "otel"

    def detect(self, body: bytes, content_type: str | None) -> bool:
        if content_type and "otel" in content_type.lower():
            return True
        try:
            parsed = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(parsed, dict):
            return False
        return "resourceSpans" in parsed or "resource_spans" in parsed

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SchemaInvalidError(
                f"OTel body is not valid JSON: {exc}",
                problems=[f"json_decode_error: {exc}"],
            ) from exc

        if not isinstance(payload, dict):
            raise SchemaInvalidError(
                "OTel body must be a JSON object",
                problems=["body_not_object"],
            )

        resource_spans = (
            payload.get("resourceSpans")
            or payload.get("resource_spans")
            or []
        )
        if not isinstance(resource_spans, list):
            raise SchemaInvalidError(
                "OTel body must contain resourceSpans[]",
                problems=["missing_resource_spans"],
            )
        if "resourceSpans" not in payload and "resource_spans" not in payload:
            raise SchemaInvalidError(
                "OTel body must contain a resourceSpans or resource_spans key",
                problems=["missing_resource_spans"],
            )

        events: list[TelemetryEvent] = []
        for rs in resource_spans:
            if not isinstance(rs, dict):
                continue
            resource = rs.get("resource") or {}
            resource_attrs = _decode_attributes(resource.get("attributes", []))
            for ss in rs.get("scopeSpans") or rs.get("scope_spans") or []:
                if not isinstance(ss, dict):
                    continue
                scope = ss.get("scope") or {}
                for span in ss.get("spans") or []:
                    if not isinstance(span, dict):
                        continue
                    raw = _span_to_raw_dict(span, resource_attrs, scope)
                    event = await normalize_to_telemetry_event(
                        raw, attribution.with_source_format(self.source_format)
                    )
                    events.append(event)

        if not events:
            raise SchemaInvalidError(
                "OTel body parsed but contained no spans",
                problems=["no_spans"],
            )
        return events
