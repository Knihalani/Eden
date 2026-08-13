"""Runtime verification for the OTLP zero-SDK ingest endpoint.

POST /orgs/{org_id}/ingest/otel — plan 9.6a / OOM-IMPROVEMENT-PLAN-2026-08-12

Three test classes address the three verification goals:

  (a) TestOtelJsonIngest   — JSON OTLP payload → expect 2xx and events stored
  (b) TestOtelProtobufIngest — binary protobuf payloads → 2xx and events stored
      (plan 9.6b fix: OtelDecoder.decode() now branches on content-type and
      parses ExportTraceServiceRequest via opentelemetry-proto / MessageToDict)
  (c) TestOtelTenantResolution — verify path/auth org matching and that a
      missing or mismatched tenant is firmly rejected.

Auth pattern mirrors test_ingestion.py: FastAPI dependency_overrides for
get_ingest_auth + monkeypatch on the collector singleton in both the
canonical module and the route's local binding.

Runtime findings (as of 2026-08-12, post-9.6b fix)
-----------------------------------------------------
* JSON OTLP (application/json)           → 200  [WORKING]
* Protobuf (application/x-protobuf)      → 200  [FIXED by 9.6b]
* Protobuf (application/x-otel-protobuf) → 200  [FIXED by 9.6b]
* Wrong org in path vs auth              → 403  [_assert_ingest_org enforces]
* No auth headers / no cookie            → 401
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

# ── Shared fixtures ──────────────────────────────────────────────────────────


@pytest.fixture()
def mock_collector() -> AsyncMock:
    """Fake TelemetryCollector that records every batch it receives."""
    collector = AsyncMock()
    collector.ingest_batch = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "total": 1}
    )
    collector.ingest = AsyncMock(return_value=True)
    return collector


@pytest.fixture()
def mock_auth(api_client: TestClient, mock_collector, monkeypatch):
    """Override ingest auth and collector for a single test.

    Mirrors the identical fixture in test_ingestion.py: dependency_overrides
    for get_ingest_auth plus monkeypatch on get_telemetry_collector in both
    the canonical module and the route module's local binding.
    """
    from eden.api.app import app
    from eden.api.deps import get_ingest_auth
    from eden.api.routes import ingestion as ingestion_module
    from eden.observability import telemetry_collector as tc_module

    fake_auth = {
        "org_id": "org-test-otlp",
        "user_id": None,
        "api_key_id": "key-otlp-test",
        "auth_method": "api_key",
    }
    app.dependency_overrides[get_ingest_auth] = lambda: fake_auth

    async def _get():
        return mock_collector

    monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(ingestion_module, "get_telemetry_collector", _get)

    try:
        yield fake_auth
    finally:
        app.dependency_overrides.pop(get_ingest_auth, None)


# ── (a) JSON OTLP ────────────────────────────────────────────────────────────


def _minimal_json_otlp_body(
    *,
    trace_id: str = "00112233445566778899aabbccddeeff",
    span_id: str = "0011223344556677",
    name: str = "gpt-4o chat",
    model: str = "gpt-4o",
    input_tokens: int = 15,
    output_tokens: int = 8,
) -> bytes:
    """Well-formed OTLP/HTTP JSON ExportTraceServiceRequest."""
    payload: dict[str, Any] = {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {
                            "key": "service.name",
                            "value": {"stringValue": "test-agent"},
                        },
                        {
                            "key": "deployment.environment.name",
                            "value": {"stringValue": "test"},
                        },
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "opentelemetry-python", "version": "1.25.0"},
                        "spans": [
                            {
                                "traceId": trace_id,
                                "spanId": span_id,
                                "name": name,
                                "kind": 3,
                                "startTimeUnixNano": "1700000000000000000",
                                "endTimeUnixNano": "1700000001500000000",
                                "attributes": [
                                    {
                                        "key": "gen_ai.operation.name",
                                        "value": {"stringValue": "chat"},
                                    },
                                    {
                                        "key": "gen_ai.request.model",
                                        "value": {"stringValue": model},
                                    },
                                    {
                                        "key": "gen_ai.usage.input_tokens",
                                        "value": {"intValue": str(input_tokens)},
                                    },
                                    {
                                        "key": "gen_ai.usage.output_tokens",
                                        "value": {"intValue": str(output_tokens)},
                                    },
                                ],
                                "status": {"code": "STATUS_CODE_OK"},
                            }
                        ],
                    }
                ],
            }
        ]
    }
    return json.dumps(payload).encode()


class TestOtelJsonIngest:
    """(a) JSON OTLP payloads must return 2xx and produce ingested events."""

    def test_single_span_returns_200(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """Basic single-span happy path."""
        body = _minimal_json_otlp_body()
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200, (
            f"JSON OTLP returned {response.status_code}: {response.text}"
        )
        data = response.json()
        assert data["source_format"] == "otel"
        assert data["total"] >= 1
        assert mock_collector.ingest_batch.await_count == 1

    def test_events_have_correct_tenant_and_format(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """Events passed to the collector carry the right tenant and source."""
        body = _minimal_json_otlp_body(model="gpt-4o-mini", input_tokens=5)
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert len(events_arg) >= 1
        ev = events_arg[0]
        assert ev.source_format == "otel"
        assert ev.tenant_id == "org-test-otlp"

    def test_genai_metrics_extracted(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """Token-count attributes surface in the event metrics dict."""
        body = _minimal_json_otlp_body(input_tokens=20, output_tokens=10)
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        ev = events_arg[0]
        assert ev.metrics.get("input_tokens") == 20.0
        assert ev.metrics.get("output_tokens") == 10.0

    def test_missing_resource_spans_returns_422(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """A JSON object without resourceSpans must be rejected with 422."""
        body = json.dumps({"traceId": "abc"}).encode()
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422

    def test_empty_spans_list_returns_422(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """resourceSpans present but containing no spans → 422."""
        body = json.dumps({
            "resourceSpans": [
                {
                    "resource": {"attributes": []},
                    "scopeSpans": [{"scope": {}, "spans": []}],
                }
            ]
        }).encode()
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422


# ── (b) Protobuf OTLP ────────────────────────────────────────────────────────

# Use opentelemetry-proto (now a declared [project.dependencies] entry added by
# plan 9.6b) to construct proper ExportTraceServiceRequest payloads.  This
# replaces the hand-rolled bytes that were used while the package was absent.


def _minimal_proto_otlp_body(
    *,
    trace_id: bytes = bytes.fromhex("00112233445566778899aabbccddeeff"),
    span_id: bytes = bytes.fromhex("0011223344556677"),
    name: str = "gpt-4o chat",
    model: str = "gpt-4o",
    input_tokens: int = 15,
    output_tokens: int = 8,
) -> bytes:
    """Build a well-formed OTLP/HTTP protobuf ExportTraceServiceRequest.

    Returns the serialised bytes ready to POST with
    ``Content-Type: application/x-protobuf``.
    """
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
        ExportTraceServiceRequest,
    )
    from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
    from opentelemetry.proto.resource.v1.resource_pb2 import Resource
    from opentelemetry.proto.trace.v1.trace_pb2 import ResourceSpans, ScopeSpans, Span, Status

    span = Span(
        trace_id=trace_id,
        span_id=span_id,
        name=name,
        kind=Span.SpanKind.Value("SPAN_KIND_CLIENT"),
        start_time_unix_nano=1_700_000_000_000_000_000,
        end_time_unix_nano=1_700_000_001_500_000_000,
        attributes=[
            KeyValue(key="gen_ai.operation.name", value=AnyValue(string_value="chat")),
            KeyValue(key="gen_ai.request.model", value=AnyValue(string_value=model)),
            KeyValue(
                key="gen_ai.usage.input_tokens",
                value=AnyValue(int_value=input_tokens),
            ),
            KeyValue(
                key="gen_ai.usage.output_tokens",
                value=AnyValue(int_value=output_tokens),
            ),
        ],
        status=Status(code=Status.StatusCode.Value("STATUS_CODE_OK")),
    )

    resource = Resource(
        attributes=[
            KeyValue(
                key="service.name",
                value=AnyValue(string_value="test-agent"),
            ),
            KeyValue(
                key="deployment.environment.name",
                value=AnyValue(string_value="test"),
            ),
        ]
    )

    req = ExportTraceServiceRequest(
        resource_spans=[
            ResourceSpans(
                resource=resource,
                scope_spans=[ScopeSpans(spans=[span])],
            )
        ]
    )
    return req.SerializeToString()


class TestOtelProtobufIngest:
    """(b) Binary protobuf payloads decoded by OtelDecoder (plan 9.6b fix).

    OtelDecoder.decode() now branches on Content-Type: when the header is
    application/x-protobuf or application/x-otel-protobuf the body is
    parsed as ExportTraceServiceRequest via the opentelemetry-proto package
    and then processed through the same mapping pipeline as JSON.
    """

    def test_application_x_protobuf(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """``application/x-protobuf`` — standard OTLP binary content type
        must return 200 and ingest the span.
        """
        body = _minimal_proto_otlp_body()
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=body,
            headers={"Content-Type": "application/x-protobuf"},
        )
        assert response.status_code == 200, (
            f"application/x-protobuf returned {response.status_code}: {response.text}"
        )
        data = response.json()
        assert data["source_format"] == "otel"
        assert data["total"] >= 1
        assert mock_collector.ingest_batch.await_count == 1

    def test_application_x_otel_protobuf(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """``application/x-otel-protobuf`` — vendor content-type also accepted."""
        body = _minimal_proto_otlp_body(model="gpt-4o-mini", input_tokens=5)
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=body,
            headers={"Content-Type": "application/x-otel-protobuf"},
        )
        assert response.status_code == 200, (
            f"application/x-otel-protobuf returned {response.status_code}: "
            f"{response.text}"
        )
        assert mock_collector.ingest_batch.await_count == 1
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert len(events_arg) >= 1
        ev = events_arg[0]
        assert ev.source_format == "otel"
        assert ev.tenant_id == "org-test-otlp"

    def test_framed_protobuf(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """Some OTel exporters send a 5-byte compression-frame header before
        the protobuf body (1-byte compression flag + 4-byte big-endian length).

        These are sent by gRPC-HTTP/1 tunnels and some HTTP/2 framing
        implementations.  The server receives the whole body verbatim (no
        gRPC framing stripping happens at the HTTP layer for OTLP/HTTP), so
        the protobuf parser will fail to decode the frame prefix as valid
        proto3 and the server must return a clear 422.

        This test documents the expected *correct* behaviour: 422 with a
        helpful error message.  Unframed binary (``test_application_x_protobuf``)
        is the supported path.
        """
        import struct

        raw = _minimal_proto_otlp_body()
        framed = struct.pack(">BI", 0, len(raw)) + raw
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=framed,
            headers={"Content-Type": "application/x-protobuf"},
        )
        # Framed bodies have a 5-byte prefix that is not valid proto3 for
        # ExportTraceServiceRequest field 1.  protobuf will raise DecodeError
        # → SchemaInvalidError → 422 with a clear message naming expected types.
        assert response.status_code == 422, (
            f"Expected 422 for framed protobuf, got {response.status_code}: "
            f"{response.text}"
        )


# ── (c) Tenant resolution ─────────────────────────────────────────────────────


class TestOtelTenantResolution:
    """(c) The org in the URL path is the authoritative tenant signal.

    Auth mechanism: X-Org-Api-Key + X-Org-Id headers (both required for
    API-key auth; see get_ingest_auth / _ingestion_auth_impl in deps.py).
    _assert_ingest_org checks path org_id == auth_ctx["org_id"] → 403 on
    mismatch.  Missing auth entirely → 401 from _ingestion_auth_impl.
    """

    def test_path_org_mismatch_returns_403(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """When the URL org_id differs from the authenticated org_id the
        route must return 403.

        mock_auth injects org_id="org-test-otlp"; we send the request to
        /orgs/org-WRONG/ingest/otel to trigger _assert_ingest_org's guard.
        """
        body = _minimal_json_otlp_body()
        response = api_client.post(
            "/orgs/org-WRONG/ingest/otel",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 403, (
            f"Expected 403 for org mismatch, got {response.status_code}"
        )
        assert "match" in response.json().get("detail", "").lower() or \
               "org" in response.json().get("detail", "").lower()

    def test_no_auth_returns_401(self, api_client: TestClient):
        """No X-Org-Api-Key, no Bearer, no session cookie → 401.

        This fixture intentionally omits mock_auth so get_ingest_auth runs
        normally.  With no credentials _ingestion_auth_impl raises 401
        immediately (before any DB call).
        """
        body = _minimal_json_otlp_body()
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 401, (
            f"Expected 401 for missing auth, got {response.status_code}"
        )

    def test_correct_org_in_path_is_accepted(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        """Sanity-check: the authenticated org matches the path org → 200."""
        body = _minimal_json_otlp_body()
        # mock_auth provides org_id="org-test-otlp"; path matches.
        response = api_client.post(
            "/orgs/org-test-otlp/ingest/otel",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
