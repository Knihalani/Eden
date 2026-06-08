"""Tests for the OTel OTLP/HTTP-JSON decoder."""

import json

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import SchemaInvalidError
from eden.observability.ingestion.otel import OtelDecoder, _decode_any_value


def _otlp_span(**overrides) -> dict:
    """Build a minimal valid OTLP span with sensible defaults."""
    span = {
        "traceId": "0af7651916cd43dd8448eb211c80319c",
        "spanId": "b7ad6b7169203331",
        "name": "chat gpt-4o",
        "kind": "SPAN_KIND_CLIENT",
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": [
            {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
            {"key": "gen_ai.request.model", "value": {"stringValue": "gpt-4o"}},
            {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "100"}},
            {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "50"}},
        ],
        "status": {"code": "STATUS_CODE_OK"},
    }
    span.update(overrides)
    return span


def _otlp_body(spans=None, snake=False) -> bytes:
    if spans is None:
        spans = [_otlp_span()]
    rs = {
        "resource": {
            "attributes": [
                {"key": "service.name", "value": {"stringValue": "svc-1"}}
            ]
        },
        "scopeSpans": [
            {"scope": {"name": "openai", "version": "1.0"}, "spans": spans}
        ],
    }
    body: dict = {"resourceSpans": [rs]}
    if snake:
        body = {
            "resource_spans": [{
                "resource": rs["resource"],
                "scope_spans": [{
                    "scope": rs["scopeSpans"][0]["scope"],
                    "spans": rs["scopeSpans"][0]["spans"],
                }],
            }]
        }
    return json.dumps(body).encode()


# ── _decode_any_value (low-level) ───────────────────────────────────


def test_decode_string_value():
    assert _decode_any_value({"stringValue": "hi"}) == "hi"


def test_decode_int_value():
    assert _decode_any_value({"intValue": "42"}) == 42


def test_decode_double_value():
    assert _decode_any_value({"doubleValue": 3.14}) == 3.14


def test_decode_bool_value():
    assert _decode_any_value({"boolValue": True}) is True


def test_decode_array_value():
    assert _decode_any_value(
        {"arrayValue": {"values": [
            {"stringValue": "a"},
            {"intValue": "1"},
        ]}}
    ) == ["a", 1]


def test_decode_kvlist_value():
    out = _decode_any_value({
        "kvlistValue": {"values": [
            {"key": "x", "value": {"stringValue": "y"}}
        ]}
    })
    assert out == {"x": "y"}


def test_decode_unknown_returns_as_is():
    assert _decode_any_value("already-decoded") == "already-decoded"
    assert _decode_any_value(None) is None


# ── OtelDecoder.detect ─────────────────────────────────────────────


def test_otel_detect_camel_case():
    assert OtelDecoder().detect(_otlp_body(), "application/json") is True


def test_otel_detect_snake_case():
    assert OtelDecoder().detect(_otlp_body(snake=True), None) is True


def test_otel_detect_content_type():
    assert OtelDecoder().detect(b"{}", "application/x-otel-protobuf") is True


def test_otel_detect_negative():
    assert OtelDecoder().detect(b'{"foo": "bar"}', None) is False
    assert OtelDecoder().detect(b"not json", None) is False


# ── OtelDecoder.decode (full) ──────────────────────────────────────


@pytest.mark.asyncio
async def test_otel_decode_single_span_minimum():
    events = await OtelDecoder().decode(
        _otlp_body(),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "otel.chat"
    assert e.name == "gpt-4o"
    assert e.tenant_id == "org_abc"
    assert e.source_format == "otel"
    assert e.realm == "production"
    assert e.duration_ms == 1000.0
    assert e.metrics["input_tokens"] == 100.0
    assert e.metrics["output_tokens"] == 50.0
    assert e.outcome == "success"
    assert "service.name" in e.attributes


@pytest.mark.asyncio
async def test_otel_decode_error_status_becomes_failure():
    span = _otlp_span(status={"code": "STATUS_CODE_ERROR"})
    events = await OtelDecoder().decode(
        _otlp_body(spans=[span]),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].outcome == "failure"


@pytest.mark.asyncio
async def test_otel_decode_error_type_attr_becomes_failure():
    span = _otlp_span(attributes=[
        {"key": "error.type", "value": {"stringValue": "rate_limit"}}
    ])
    events = await OtelDecoder().decode(
        _otlp_body(spans=[span]),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].outcome == "failure"


@pytest.mark.asyncio
async def test_otel_decode_realm_environment_from_deployment_env():
    span = _otlp_span(attributes=[
        {"key": "deployment.environment.name",
         "value": {"stringValue": "sandbox"}}
    ])
    events = await OtelDecoder().decode(
        _otlp_body(spans=[span]),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].realm == "environment"


@pytest.mark.asyncio
async def test_otel_decode_span_events_go_to_payload():
    span = _otlp_span(events=[
        {
            "timeUnixNano": "1700000000000000000",
            "name": "gen_ai.user.message",
            "attributes": [
                {"key": "gen_ai.prompt.content",
                 "value": {"stringValue": "Hello"}}
            ],
        }
    ])
    events = await OtelDecoder().decode(
        _otlp_body(spans=[span]),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert "events" in events[0].payload
    assert events[0].payload["events"][0]["name"] == "gen_ai.user.message"


@pytest.mark.asyncio
async def test_otel_decode_multiple_spans_in_one_scope():
    events = await OtelDecoder().decode(
        _otlp_body(spans=[_otlp_span(), _otlp_span()]),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert len(events) == 2


@pytest.mark.asyncio
async def test_otel_decode_parent_span_id_extracted():
    span = _otlp_span(parentSpanId="b7ad6b7169203331")
    events = await OtelDecoder().decode(
        _otlp_body(spans=[span]),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].parent_span_id == "b7ad6b7169203331"


@pytest.mark.asyncio
async def test_otel_decode_invalid_json_raises_schema_invalid():
    with pytest.raises(SchemaInvalidError, match="not valid JSON"):
        await OtelDecoder().decode(
            b"not json",
            Attribution(tenant_id="org_abc", source_format="otel"),
        )


@pytest.mark.asyncio
async def test_otel_decode_no_resource_spans_raises():
    with pytest.raises(SchemaInvalidError, match="resourceSpans"):
        await OtelDecoder().decode(
            json.dumps({"foo": "bar"}).encode(),
            Attribution(tenant_id="org_abc", source_format="otel"),
        )


@pytest.mark.asyncio
async def test_otel_decode_no_spans_raises():
    body = json.dumps({
        "resourceSpans": [{
            "resource": {"attributes": []},
            "scopeSpans": [{"scope": {"name": "x"}, "spans": []}]
        }]
    }).encode()
    with pytest.raises(SchemaInvalidError, match="no spans"):
        await OtelDecoder().decode(
            body, Attribution(tenant_id="org_abc", source_format="otel")
        )


@pytest.mark.asyncio
async def test_otel_decode_snake_case_top_level():
    """Accept snake_case ``resource_spans`` / ``scope_spans`` too."""
    span = _otlp_span()
    rs = {
        "resource": {"attributes": []},
        "scope_spans": [{"scope": {"name": "x"}, "spans": [span]}],
    }
    body = json.dumps({"resource_spans": [rs]}).encode()
    events = await OtelDecoder().decode(
        body, Attribution(tenant_id="org_abc", source_format="otel")
    )
    assert len(events) == 1
    assert events[0].name == "gpt-4o"


@pytest.mark.asyncio
async def test_otel_decode_provider_name_in_payload():
    span = _otlp_span(attributes=[
        {"key": "gen_ai.provider.name", "value": {"stringValue": "openai"}}
    ])
    events = await OtelDecoder().decode(
        _otlp_body(spans=[span]),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].payload["otel"]["provider"] == "openai"


# ── OTel client / server attribute mappings (Phase 7.1a.3) ─────────


def _otlp_span_with(**attrs_value_pairs) -> bytes:
    """Build a body with one span whose attributes are the given key/value pairs."""
    attrs = [
        {"key": k, "value": {"stringValue" if isinstance(v, str) else "doubleValue": v}}
        for k, v in attrs_value_pairs.items()
    ]
    return _otlp_body(spans=[_otlp_span(attributes=attrs)])


@pytest.mark.asyncio
async def test_otel_decode_maps_client_operation_duration():
    """``gen_ai.client.operation.duration`` (seconds) → ``duration_ms_otel``."""
    events = await OtelDecoder().decode(
        _otlp_span_with(**{"gen_ai.client.operation.duration": "0.750"}),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].metrics["duration_ms_otel"] == pytest.approx(750.0)


@pytest.mark.asyncio
async def test_otel_decode_maps_server_request_duration():
    events = await OtelDecoder().decode(
        _otlp_span_with(**{"gen_ai.server.request.duration": "0.250"}),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].metrics["server_request_duration_ms"] == pytest.approx(250.0)


@pytest.mark.asyncio
async def test_otel_decode_maps_ttft_seconds():
    """``gen_ai.server.time_to_first_token`` (seconds) → ``ttft_ms``."""
    events = await OtelDecoder().decode(
        _otlp_span_with(**{"gen_ai.server.time_to_first_token": "0.150"}),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].metrics["ttft_ms"] == pytest.approx(150.0)


@pytest.mark.asyncio
async def test_otel_decode_maps_ttft_ms_direct():
    """Some SDKs emit ``ttft_ms`` directly; we still surface it."""
    events = await OtelDecoder().decode(
        _otlp_span_with(**{"ttft_ms": "120"}),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].metrics["ttft_ms"] == 120.0


@pytest.mark.asyncio
async def test_otel_decode_maps_cache_tokens():
    """Anthropic-style cache read/creation tokens land in metrics."""
    events = await OtelDecoder().decode(
        _otlp_span_with(**{
            "gen_ai.usage.cache_read.input_tokens": "500",
            "gen_ai.usage.cache_creation.input_tokens": "100",
        }),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert events[0].metrics["cache_read_tokens"] == 500.0
    assert events[0].metrics["cache_creation_tokens"] == 100.0


@pytest.mark.asyncio
async def test_otel_decode_missing_otlp_attrs_no_crash():
    """When none of the new attrs are present, the metrics dict
    doesn't gain empty/None values."""
    events = await OtelDecoder().decode(
        _otlp_body(),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    # Only the original two keys should be set.
    assert "duration_ms_otel" not in events[0].metrics
    assert "ttft_ms" not in events[0].metrics
    assert "cache_read_tokens" not in events[0].metrics
    assert events[0].metrics["input_tokens"] == 100.0
    assert events[0].metrics["output_tokens"] == 50.0


@pytest.mark.asyncio
async def test_otel_decode_malformed_duration_skipped():
    """Non-numeric durations are silently dropped, not coerced to 0."""
    events = await OtelDecoder().decode(
        _otlp_span_with(**{"gen_ai.client.operation.duration": "not-a-number"}),
        Attribution(tenant_id="org_abc", source_format="otel"),
    )
    assert "duration_ms_otel" not in events[0].metrics
