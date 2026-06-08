"""Tests for the format detector."""

import json

from eden.observability.ingestion.detector import (
    detect_format,
    detect_from_body,
    detect_from_content_type,
    detect_from_x_source_format,
)


def test_content_type_otel_protobuf():
    assert detect_from_content_type("application/x-otel-protobuf") == "otel"


def test_content_type_otel_x_protobuf():
    assert detect_from_content_type("application/x-protobuf") == "otel"


def test_content_type_otel_with_charset():
    assert (
        detect_from_content_type("application/x-otel-protobuf; charset=utf-8")
        == "otel"
    )


def test_content_type_plain_json_returns_none():
    # Plain JSON is intentionally NOT in the map — too many formats use it.
    assert detect_from_content_type("application/json") is None


def test_content_type_none_returns_none():
    assert detect_from_content_type(None) is None


def test_x_source_format_header_lowercase():
    assert detect_from_x_source_format({"x-source-format": "Helicone"}) == "helicone"


def test_x_source_format_header_uppercase():
    assert detect_from_x_source_format({"X-Source-Format": "OTEL"}) == "otel"


def test_x_source_format_header_absent():
    assert detect_from_x_source_format({}) is None
    assert detect_from_x_source_format({"content-type": "json"}) is None


def test_body_detect_otel():
    body = json.dumps({
        "resourceSpans": [{
            "resource": {"attributes": []},
            "scopeSpans": [{"spans": []}]
        }]
    }).encode()
    assert detect_from_body(body) == "otel"


def test_body_detect_otel_snake_case():
    body = json.dumps({"resource_spans": []}).encode()
    assert detect_from_body(body) == "otel"


def test_body_detect_helicone():
    body = json.dumps({
        "request_id": "req_abc",
        "model": "gpt-4o",
        "usage": {"prompt_tokens": 100}
    }).encode()
    assert detect_from_body(body) == "helicone"


def test_body_detect_langfuse_list():
    body = json.dumps([{
        "id": "trace_1",
        "observations": [{"id": "obs_1"}],
        "scores": []
    }]).encode()
    assert detect_from_body(body) == "langfuse"


def test_body_detect_langfuse_dict():
    body = json.dumps({
        "batch": [{"id": "trace_1", "observations": []}]
    }).encode()
    assert detect_from_body(body) == "langfuse"


def test_body_detect_unknown_falls_back_to_webhook():
    body = json.dumps({"random": "object"}).encode()
    assert detect_from_body(body) == "webhook"


def test_body_detect_invalid_json():
    assert detect_from_body(b"not json") == "webhook"


# ── detect_format (full precedence) ────────────────────────────────


def test_detect_format_path_wins():
    body = b'{"resourceSpans": []}'
    assert (
        detect_format(
            path_format="helicone",
            content_type="application/json",
            body=body,
        )
        == "helicone"
    )


def test_detect_format_x_source_format_wins():
    body = b'{"resourceSpans": []}'
    headers = {"x-source-format": "langfuse"}
    assert (
        detect_format(
            path_format=None,
            content_type="application/x-otel-protobuf",
            body=body,
            headers=headers,
        )
        == "langfuse"
    )


def test_detect_format_content_type_wins_over_body():
    body = b'{"request_id": "r1"}'  # would body-detect as helicone
    assert (
        detect_format(
            path_format=None,
            content_type="application/x-otel-protobuf",
            body=body,
        )
        == "otel"
    )


def test_detect_format_body_sniff_fallback():
    body = b'{"resourceSpans": []}'
    assert (
        detect_format(
            path_format=None,
            content_type=None,
            body=body,
        )
        == "otel"
    )


def test_detect_format_webhook_fallback():
    body = b'{"anything": "else"}'
    assert (
        detect_format(
            path_format=None,
            content_type=None,
            body=body,
        )
        == "webhook"
    )
