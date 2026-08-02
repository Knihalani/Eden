"""Shared final step: source-specific dict → ``TelemetryEvent``.

Every decoder produces a list of ``NormalizedEvent`` dicts. The
``normalize_to_telemetry_event`` function is the single place that
turns those into the internal ``TelemetryEvent`` dataclass, stamps
``source_format`` + ``tenant_id`` + ``project_id`` from the request
attribution, and runs PII pre-masking on the payload.

Keeping this step shared (rather than duplicated in each decoder)
means the wire contract is enforced exactly once, and the PII hook
is impossible to forget for a new format.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.config import get_settings
from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.pii import mask_attributes, mask_payload
from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


# ISO 8601 timestamps that come in as epoch ms or s — heuristic: 13-digit
# numbers are ms (covers 2001-2286), 10-digit are s (covers 1973-2286).
def _normalize_timestamp(value: Any) -> str:
    """Coerce an incoming timestamp into an ISO 8601 UTC string.

    Accepts: ISO 8601 string (returned unchanged or with ``Z`` swapped
    to ``+00:00``), epoch int/float (ms or s), or a ``datetime``.
    """
    if value is None:
        return datetime.now(UTC).isoformat()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.isoformat()
    if isinstance(value, (int, float)):
        # Heuristic: > 10^12 → milliseconds, else seconds.
        ts = value / 1000.0 if value > 1e12 else float(value)
        return datetime.fromtimestamp(ts, tz=UTC).isoformat()
    if isinstance(value, str):
        s = value.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        # Validate by round-trip.
        try:
            datetime.fromisoformat(s)
            return s
        except ValueError:
            logger.debug(f"timestamp not ISO 8601, using now(): {value!r}")
            return datetime.now(UTC).isoformat()
    return datetime.now(UTC).isoformat()


def _ensure_event_id(value: str | None) -> str:
    """Generate a stable event_id when the source didn't provide one.
    Uses uuid4 — the collector dedupes on event_id so collisions are
    safe but should be rare."""
    if value:
        return str(value)
    return f"ing_{uuid.uuid4().hex}"


def _ensure_trace_id(value: str | None) -> str:
    """A trace_id is required. If the source has no concept of a trace,
    we synthesize one from the event_id (so the row is its own
    one-event trace). The portal's trace tree will show a single-node
    trace in that case."""
    if value:
        return str(value)
    return f"trace_{uuid.uuid4().hex}"


def _coerce_outcome(value: str | None) -> str | None:
    """Map free-form status / outcome strings to the canonical set the
    collector accepts. Unknown values pass through (the collector
    accepts any string and the UI renders the literal)."""
    if value is None:
        return None
    s = str(value).strip().lower()
    mapping = {
        "ok": "success",
        "succeeded": "success",
        "completed": "success",
        "success": "success",
        "fail": "failure",
        "failed": "failure",
        "error": "failure",
        "errored": "failure",
        "failure": "failure",
        "partial": "partial",
        "timeout": "timeout",
        "timed_out": "timeout",
        "crash": "crash",
        "crashed": "crash",
        "cancelled": "failure",
        "canceled": "failure",
    }
    return mapping.get(s, s)


async def normalize_to_telemetry_event(
    raw: dict[str, Any],
    attribution: Attribution,
) -> TelemetryEvent:
    """Convert one source-specific dict into a ``TelemetryEvent``.

    Performs the steps every format needs:
      1. Generate fallback event_id / trace_id if missing.
      2. Normalize timestamp to ISO 8601.
      3. Coerce outcome to the canonical enum-ish string.
      4. Stamp tenant_id, project_id, source_format from attribution.
      5. PII pre-mask the payload (configurable; respects
         ``settings.ingestion_pii_pre_mask``).
      6. PII pre-mask attribute values.

    Decoders should pre-shape ``raw`` so this function only needs to
    enforce the contract. The TelemetryEvent dataclass is constructed
    here; decoders never touch it directly.
    """
    settings = get_settings()

    event_id = _ensure_event_id(raw.get("event_id"))
    trace_id = _ensure_trace_id(raw.get("trace_id"))
    timestamp = _normalize_timestamp(raw.get("timestamp"))

    # Realm: accept both lowercase ("environment"/"production") and the
    # case-insensitive variants. The collector accepts any string but
    # the existing Pydantic model for the legacy route is strict. We
    # don't go through that Pydantic model in the new endpoints so
    # we're liberal here.
    realm = str(raw.get("realm", "production")).strip().lower()
    if realm not in ("environment", "production"):
        realm = "production"

    payload = dict(raw.get("payload") or {})
    metrics = dict(raw.get("metrics") or {})
    attributes = dict(raw.get("attributes") or {})
    tags = list(raw.get("tags") or [])

    # SDK / framework emitters may stamp top-level error fields that are
    # not mirrored into attributes yet — fold them in so portal SQL and
    # transcript extractors always see a message on failure outcomes.
    top_err = raw.get("error_message") or raw.get("error")
    if isinstance(top_err, dict):
        top_err = top_err.get("message") or top_err.get("msg")
    if top_err is None:
        nested_err = payload.get("error_message") or payload.get("error")
        if isinstance(nested_err, dict):
            top_err = nested_err.get("message") or nested_err.get("msg")
        else:
            top_err = nested_err
    top_err_type = raw.get("error_type") or payload.get("error_type")
    if top_err and not attributes.get("eden.error") and not attributes.get("error"):
        attributes["error"] = str(top_err)
        attributes["eden.error"] = str(top_err)
    if top_err_type and not attributes.get("error_type") and not attributes.get("error.type"):
        attributes["error_type"] = str(top_err_type)
        attributes["error.type"] = str(top_err_type)

    outcome = _coerce_outcome(
        raw.get("outcome")
        or payload.get("outcome")
        or payload.get("status")
    )

    # The Python SDK's framework emitter hoists ``set_input`` /
    # ``set_output`` to top-level ``input`` / ``output`` fields (see
    # ``eden_sdk.trace._emit_trace_event``). Without this fallback those
    # payloads were silently dropped — spans landed with empty
    # request_body / response_body and the transcript view had nothing
    # to render. Non-dict values (``set_output("text")``) are wrapped so
    # downstream message-hash extraction always sees a mapping.
    request_body = raw.get("request_body")
    if request_body is None:
        # TS SDK nests them inside ``payload`` instead (eventToWire).
        _in = raw.get("input") if raw.get("input") is not None else payload.get("input")
        if _in is not None:
            request_body = _in if isinstance(_in, dict) else {"content": _in}
    response_body = raw.get("response_body")
    if response_body is None:
        _out = raw.get("output") if raw.get("output") is not None else payload.get("output")
        if _out is not None:
            response_body = _out if isinstance(_out, dict) else {"content": _out}
    reasoning = raw.get("reasoning")
    logprobs = raw.get("logprobs")

    if settings.ingestion_pii_pre_mask:
        # Mask payload + attributes concurrently (policy resolve is cached).
        payload, attributes = await asyncio.gather(
            mask_payload(payload, tenant_id=attribution.tenant_id),
            mask_attributes(attributes, tenant_id=attribution.tenant_id),
        )
        # PII mask the new capture fields too (reasoning, request_body,
        # response_body) — these can leak credentials via example
        # tool-call arguments or seeded user data.
        capture_fields = {
            "request_body": request_body,
            "response_body": response_body,
            "reasoning": reasoning,
            "logprobs": logprobs,
        }
        to_mask = [v for v in capture_fields.values() if isinstance(v, dict)]
        if to_mask:
            masked_vals = await asyncio.gather(
                *(mask_payload(v, tenant_id=attribution.tenant_id) for v in to_mask)
            )
            masked_iter = iter(masked_vals)
            for field, value in capture_fields.items():
                if isinstance(value, dict):
                    capture_fields[field] = next(masked_iter)
            request_body = capture_fields["request_body"]
            response_body = capture_fields["response_body"]
            reasoning = capture_fields["reasoning"]
            logprobs = capture_fields["logprobs"]

    return TelemetryEvent(
        event_id=event_id,
        tenant_id=attribution.tenant_id,
        project_id=attribution.project_id,
        trace_id=trace_id,
        realm=realm,
        event_type=str(raw.get("event_type") or "ingest.event"),
        timestamp=timestamp,
        agent_id=(
            raw.get("agent_id")
            or (attributes.get("agent_id") if isinstance(attributes, dict) else None)
            or (attributes.get("eden.agent_id") if isinstance(attributes, dict) else None)
            or (
                attribution.project_id
                if attribution.project_id and attribution.project_id != "default"
                else None
            )
        ),
        agent_version=raw.get("agent_version"),
        environment_id=raw.get("environment_id"),
        parent_span_id=raw.get("parent_span_id"),
        span_id=raw.get("span_id"),
        name=raw.get("name"),
        duration_ms=raw.get("duration_ms"),
        payload=payload,
        metrics=metrics,
        attributes=attributes,
        tags=tags,
        outcome=outcome,
        source_format=attribution.source_format,
        request_body=request_body,
        response_body=response_body,
        reasoning=reasoning,
        tool_calls_full=raw.get("tool_calls_full") or [],
        tool_results=raw.get("tool_results") or [],
        images=raw.get("images") or [],
        audio=raw.get("audio") or [],
        logprobs=logprobs,
        citations=raw.get("citations") or [],
        finish_reason=raw.get("finish_reason"),
        stop_sequence=raw.get("stop_sequence"),
        system_fingerprint=raw.get("system_fingerprint"),
        cache_hit=bool(raw.get("cache_hit", False)),
        prompt_cache_savings_usd=raw.get("prompt_cache_savings_usd"),
        model_version=raw.get("model_version"),
        service_tier=raw.get("service_tier"),
        model=(
            raw.get("model")
            or raw.get("model_name")
            or (attributes.get("model") if isinstance(attributes, dict) else None)
            or (attributes.get("openai.model") if isinstance(attributes, dict) else None)
            or (attributes.get("anthropic.model") if isinstance(attributes, dict) else None)
        ),
        model_name=raw.get("model_name") or raw.get("model"),
    )
