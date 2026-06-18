"""OTel dual-emit — re-export every ingested TelemetryEvent as an OTel Span.

Phase 7.2c: when ``settings.otel_dual_emit_enabled = True``, the
TelemetryCollector also sends each event to a downstream OTLP/HTTP
endpoint (Honeycomb, Datadog, Grafana Tempo, etc.) as an OTel ``Span``
that follows the OTel GenAI semantic conventions.

This is a *one-way mirror* — the user's data lands in Eden's collector
first, then we forward a normalized version to their OTel backend. The
OTel backend can be used for cross-tooling (e.g. compare Eden's trace
to a service's APM trace in Honeycomb), but Eden remains the source of
truth for LLM-specific signals (judge scores, prompt evolver, etc.).

The exporter is fire-and-forget. Failures never block the ingest path
or surface as errors to the customer — they're logged at warning level
and dropped. This matches the collector's overall best-effort posture.
"""

from __future__ import annotations

import logging
from typing import Any

import aiohttp

from eden.config import get_settings
from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


# Map Eden's event_type onto OTel ``gen_ai.operation.name`` values
# (the OTel GenAI spec keeps a closed list of well-known operations).
_OPERATION_NAME_MAP: dict[str, str] = {
    "openai.chat_completion": "chat",
    "openai.responses": "responses",
    "anthropic.message": "chat",
    "anthropic.messages": "chat",
    "bedrock.invoke_model": "invoke_model",
    "gemini.generate_content": "generate_content",
    "helicone.llm_call": "chat",
    "langfuse.generation": "chat",
    "otel.chat": "chat",
    "otel.text_completion": "text_completion",
    "otel.embeddings": "embeddings",
    "otel.generate_content": "generate_content",
}


class OTelDualExporter:
    """Forwards TelemetryEvent rows to an OTLP/HTTP backend.

    Stateless — every event is sent immediately. There's no batching
    yet (the OTel SDK's BatchSpanProcessor would be the proper path for
    high-volume tenants; deferred until the gateway-proxy work lands
    and a real SDK auto-instrumentation path is needed).
    """

    def __init__(self) -> None:
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(
                total=get_settings().otel_exporter_otlp_timeout_seconds
            )
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def export_event(self, event: TelemetryEvent) -> bool:
        """Convert one TelemetryEvent to OTel JSON and POST it.

        Returns True on a 2xx, False on any failure. Never raises.
        """
        if not get_settings().otel_dual_emit_enabled:
            return False
        try:
            span = self._event_to_otlp_span(event)
            payload = {
                "resourceSpans": [{
                    "resource": {
                        "attributes": [
                            {"key": "service.name", "value": {"stringValue": "eden"}},
                            {"key": "eden.tenant_id",
                             "value": {"stringValue": event.tenant_id}},
                        ]
                    },
                    "scopeSpans": [{
                        "scope": {
                            "name": "eden.otel_dual_emit",
                            "version": "7.2.0",
                        },
                        "spans": [span],
                    }],
                }]
            }
            settings = get_settings()
            url = settings.otel_exporter_otlp_endpoint.rstrip("/") + "/v1/traces"
            session = await self._get_session()
            async with session.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
            ) as resp:
                if resp.status >= 300:
                    logger.debug(
                        f"OTel dual-emit non-2xx ({resp.status}) for "
                        f"event {event.event_id}"
                    )
                    return False
                return True
        except Exception as exc:
            logger.debug(f"OTel dual-emit failed for {event.event_id}: {exc}")
            return False

    def _event_to_otlp_span(self, event: TelemetryEvent) -> dict[str, Any]:
        """Convert a TelemetryEvent to an OTLP/HTTP JSON Span dict.

        Maps Eden's capture columns onto OTel GenAI semantic conventions:
        - ``gen_ai.operation.name`` from event_type
        - ``gen_ai.request.model`` from event name (or attributes)
        - ``gen_ai.usage.{input,output}_tokens`` from metrics
        - ``gen_ai.response.finish_reasons`` from finish_reason
        - ``gen_ai.response.model`` from model_version
        - ``gen_ai.conversation.id`` from trace_id
        - Any ``acme.eden.*`` namespaced attributes pass through verbatim
        """
        attributes: list[dict[str, Any]] = []

        def add(key: str, value: Any) -> None:
            """Append an OTLP AnyValue-wrapped attribute."""
            if value is None:
                return
            if isinstance(value, bool):
                attributes.append({"key": key, "value": {"boolValue": value}})
            elif isinstance(value, int):
                attributes.append({"key": key, "value": {"intValue": value}})
            elif isinstance(value, float):
                attributes.append({"key": key, "value": {"doubleValue": value}})
            elif isinstance(value, (list, tuple)):
                attributes.append({"key": key, "value": {
                    "arrayValue": {"values": [{"stringValue": str(v)} for v in value]}
                }})
            else:
                attributes.append({"key": key, "value": {"stringValue": str(value)}})

        # ── core GenAI attributes ──
        operation = _OPERATION_NAME_MAP.get(event.event_type, "chat")
        add("gen_ai.operation.name", operation)
        add("gen_ai.request.model", event.name or event.attributes.get("model"))
        add("gen_ai.response.model", event.model_version or event.name)
        if event.finish_reason:
            add("gen_ai.response.finish_reasons", [event.finish_reason])
        if event.system_fingerprint:
            add("gen_ai.response.system_fingerprint", event.system_fingerprint)
        if event.service_tier:
            add("gen_ai.openai.request.service_tier", event.service_tier)

        # ── token usage ──
        if "input_tokens" in event.metrics:
            add("gen_ai.usage.input_tokens", int(event.metrics["input_tokens"]))
        if "output_tokens" in event.metrics:
            add("gen_ai.usage.output_tokens", int(event.metrics["output_tokens"]))
        if "cache_read_tokens" in event.metrics:
            add("gen_ai.usage.cache_read.input_tokens",
                int(event.metrics["cache_read_tokens"]))
        if "cache_creation_tokens" in event.metrics:
            add("gen_ai.usage.cache_creation.input_tokens",
                int(event.metrics["cache_creation_tokens"]))
        if event.cache_hit:
            add("gen_ai.usage.cache_hit", True)

        # ── conversation / trace ──
        add("gen_ai.conversation.id", event.trace_id)

        # ── realm / source ──
        add("eden.realm", event.realm)
        add("eden.source_format", event.source_format or "eden_native")
        add("eden.outcome", event.outcome)

        # ── pass-through Eden custom attributes ──
        # Anything in event.attributes with the `acme.eden.*` namespace
        # flows through to the OTel backend unchanged. This lets users
        # add tenant_id, user_id, delegation_chain, etc. as OTel
        # attributes without Eden changing.
        for k, v in event.attributes.items():
            if k.startswith("acme.eden."):
                add(k, v)

        # ── span timing ──
        # Use timestamp + duration_ms; OTLP wants nanoseconds.
        start_ns = _iso_to_ns(event.timestamp)
        duration_ns = int((event.duration_ms or 0.0) * 1_000_000)
        end_ns = start_ns + duration_ns if start_ns else 0

        # ── span events for full content ──
        span_events: list[dict[str, Any]] = []
        if event.request_body:
            for msg in (event.request_body.get("messages") or []):
                if not isinstance(msg, dict):
                    continue
                ev_attrs: list[dict[str, Any]] = []
                if msg.get("role"):
                    ev_attrs.append({"key": "role",
                                     "value": {"stringValue": str(msg["role"])}})
                if msg.get("content"):
                    ev_attrs.append({"key": "content",
                                     "value": {"stringValue": str(msg["content"])}})
                role = str(msg.get("role", ""))
                if role == "system":
                    ev_name = "gen_ai.system.message"
                elif role == "assistant":
                    ev_name = "gen_ai.assistant.message"
                else:
                    ev_name = "gen_ai.user.message"
                span_events.append({
                    "timeUnixNano": str(start_ns),
                    "name": ev_name,
                    "attributes": ev_attrs,
                })
        for tc in event.tool_calls_full or []:
            if not isinstance(tc, dict):
                continue
            ev_attrs = []
            if tc.get("id"):
                ev_attrs.append({"key": "id",
                                 "value": {"stringValue": str(tc["id"])}})
            if tc.get("name") or (tc.get("function") or {}).get("name"):
                name = tc.get("name") or tc["function"]["name"]
                ev_attrs.append({"key": "name",
                                 "value": {"stringValue": str(name)}})
            if tc.get("function"):
                args = tc["function"].get("arguments")
                if args is not None:
                    ev_attrs.append({"key": "arguments",
                                     "value": {"stringValue": str(args)}})
            elif tc.get("arguments") is not None or tc.get("input") is not None:
                args = tc.get("arguments") or tc.get("input")
                ev_attrs.append({"key": "arguments",
                                 "value": {"stringValue": str(args)}})
            span_events.append({
                "timeUnixNano": str(end_ns),
                "name": "gen_ai.tool.message",
                "attributes": ev_attrs,
            })

        return {
            "traceId": _hex_trace_id(event.trace_id),
            "spanId": _hex_span_id(event.span_id or event.event_id),
            "parentSpanId": (
                _hex_span_id(event.parent_span_id)
                if event.parent_span_id else ""
            ),
            "name": event.name or event.event_type,
            "kind": 1,  # INTERNAL
            "startTimeUnixNano": str(start_ns),
            "endTimeUnixNano": str(end_ns),
            "attributes": attributes,
            "events": span_events,
            "status": (
                {"code": 2}  # ERROR
                if event.outcome == "failure"
                else {"code": 1}  # OK
            ),
        }


# ── helpers ──────────────────────────────────────────────────────────


def _iso_to_ns(iso: str | None) -> int:
    """Convert ISO 8601 timestamp to nanoseconds since epoch."""
    if not iso:
        return 0
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1_000_000_000)
    except (ValueError, TypeError):
        return 0


def _hex_trace_id(trace_id: str | None) -> str:
    """Format a trace_id as 32 hex chars (OTel spec)."""
    if not trace_id:
        return "0" * 32
    h = trace_id.encode("utf-8").hex()
    return h.ljust(32, "0")[:32]


def _hex_span_id(span_id: str | None) -> str:
    """Format a span_id as 16 hex chars (OTel spec)."""
    if not span_id:
        return "0" * 16
    h = span_id.encode("utf-8").hex()
    return h.ljust(16, "0")[:16]


# ── singleton ────────────────────────────────────────────────────────

_exporter: OTelDualExporter | None = None


def get_otel_dual_exporter() -> OTelDualExporter:
    global _exporter
    if _exporter is None:
        _exporter = OTelDualExporter()
    return _exporter


async def close_otel_dual_exporter() -> None:
    global _exporter
    if _exporter is not None:
        await _exporter.close()
        _exporter = None
