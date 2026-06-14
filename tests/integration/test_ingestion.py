"""Integration tests for the Phase 7.0 multi-format telemetry ingestion
endpoints.

Tests POST /orgs/{org_id}/ingest/{format} for all 9 supported formats
(otel, helicone, langfuse, openai, anthropic, bedrock, gemini,
framework, webhook). The TelemetryCollector is mocked via a class-level
``monkeypatch`` so the integration test does not need real Postgres /
ClickHouse / Redis. The auth dependency is overridden via FastAPI's
``dependency_overrides`` so the test does not need an actual API key
in the DB.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

# ── Module-level fixtures ──────────────────────────────────────────


@pytest.fixture
def mock_collector() -> AsyncMock:
    """A fake ``TelemetryCollector`` that records every batch it sees."""
    collector = AsyncMock()
    collector.ingest_batch = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "total": 1}
    )
    collector.ingest = AsyncMock(return_value=True)
    return collector


@pytest.fixture
def mock_auth(api_client: TestClient, mock_collector, monkeypatch):
    """Override the auth dep and the collector singleton for one test.

    The auth override uses FastAPI's ``dependency_overrides`` (the
    supported way to swap a dep). The collector override patches
    ``get_telemetry_collector`` in BOTH the canonical module
    (``eden.observability.telemetry_collector``) AND the route module
    (``eden.api.routes.ingestion``), because the route uses
    ``from eden.observability.telemetry_collector import get_telemetry_collector``
    which captures a separate local reference at import time.
    """
    from eden.api.app import app
    from eden.api.deps import get_ingestion_auth
    from eden.api.routes import ingestion as ingestion_module
    from eden.observability import telemetry_collector as tc_module

    fake_auth = {
        "org_id": "org-123",
        "user_id": None,
        "api_key_id": "key-abc",
        "auth_method": "api_key",
    }
    app.dependency_overrides[get_ingestion_auth] = lambda: fake_auth

    async def _get():
        return mock_collector

    monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(ingestion_module, "get_telemetry_collector", _get)

    try:
        yield fake_auth
    finally:
        app.dependency_overrides.pop(get_ingestion_auth, None)


# ── Per-format happy path ──────────────────────────────────────────


class TestIngestOtel:
    def test_post_single_span(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        body = json.dumps({
            "resourceSpans": [{
                "resource": {"attributes": []},
                "scopeSpans": [{
                    "scope": {"name": "openai", "version": "1.0"},
                    "spans": [{
                        "traceId": "abc",
                        "spanId": "def",
                        "name": "chat gpt-4o",
                        "startTimeUnixNano": "1700000000000000000",
                        "endTimeUnixNano": "1700000001000000000",
                        "attributes": [
                            {"key": "gen_ai.request.model",
                             "value": {"stringValue": "gpt-4o"}}
                        ],
                        "status": {"code": "STATUS_CODE_OK"},
                    }],
                }],
            }]
        }).encode()
        response = api_client.post(
            "/orgs/org-123/ingest/otel",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["source_format"] == "otel"
        assert data["total"] == 1
        assert mock_collector.ingest_batch.await_count == 1
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert len(events_arg) == 1
        assert events_arg[0].source_format == "otel"
        assert events_arg[0].name == "gpt-4o"
        assert events_arg[0].tenant_id == "org-123"


class TestIngestHelicone:
    def test_post_log(self, api_client: TestClient, mock_collector, mock_auth):
        body = json.dumps({
            "request_id": "req_abc",
            "node_id": "root:child",
            "model": "gpt-4o",
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            "response_status": 200,
        }).encode()
        response = api_client.post(
            "/orgs/org-123/ingest/helicone",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        assert response.json()["source_format"] == "helicone"
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert events_arg[0].source_format == "helicone"
        assert events_arg[0].metrics["input_tokens"] == 10.0


class TestIngestLangfuse:
    def test_post_generation(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        body = json.dumps([{
            "id": "trace_1",
            "observations": [{
                "id": "obs_1",
                "traceId": "trace_1",
                "type": "GENERATION",
                "name": "openai-chat",
                "startTime": "2024-01-01T00:00:00Z",
                "endTime": "2024-01-01T00:00:01Z",
                "model": "gpt-4o",
                "usage": {"promptTokens": 10, "completionTokens": 5},
            }],
        }]).encode()
        response = api_client.post(
            "/orgs/org-123/ingest/langfuse",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        assert response.json()["source_format"] == "langfuse"
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert events_arg[0].source_format == "langfuse"
        assert events_arg[0].event_type == "langfuse.generation"


class TestIngestOpenAI:
    def test_post_response(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        body = json.dumps({
            "id": "chatcmpl-1",
            "model": "gpt-4o",
            "choices": [{"message": {"role": "assistant", "content": "Hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }).encode()
        response = api_client.post(
            "/orgs/org-123/ingest/openai",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert events_arg[0].source_format == "openai"


class TestIngestAnthropic:
    def test_post_message(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        body = json.dumps({
            "id": "msg_1",
            "type": "message",
            "model": "claude-3-5-sonnet-20241022",
            "content": [{"type": "text", "text": "Hello"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }).encode()
        response = api_client.post(
            "/orgs/org-123/ingest/anthropic",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert events_arg[0].source_format == "anthropic"


class TestIngestBedrock:
    def test_post_invoke_model(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        body = json.dumps({
            "modelId": "anthropic.claude-3-sonnet-20240229-v1:0",
            "requestId": "req_1",
            "usage": {"inputTokens": 10, "outputTokens": 5},
            "stopReason": "end_turn",
        }).encode()
        response = api_client.post(
            "/orgs/org-123/ingest/bedrock",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert events_arg[0].source_format == "bedrock"


class TestIngestGemini:
    def test_post_response(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        body = json.dumps({
            "modelVersion": "gemini-1.5-pro-002",
            "responseId": "resp_1",
            "candidates": [{
                "content": {"parts": [{"text": "Hi"}]},
                "finishReason": "STOP",
            }],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5},
        }).encode()
        response = api_client.post(
            "/orgs/org-123/ingest/gemini",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert events_arg[0].source_format == "gemini"


class TestIngestFramework:
    def test_post_otel_shape(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        body = json.dumps({
            "resourceSpans": [{
                "resource": {"attributes": []},
                "scopeSpans": [{
                    "scope": {"name": "openai"},
                    "spans": [{
                        "traceId": "abc",
                        "spanId": "def",
                        "name": "call",
                        "startTimeUnixNano": "1700000000000000000",
                        "endTimeUnixNano": "1700000001000000000",
                        "attributes": [
                            {"key": "langchain.chain.name",
                             "value": {"stringValue": "qa"}}
                        ],
                    }],
                }],
            }]
        }).encode()
        response = api_client.post(
            "/orgs/org-123/ingest/framework",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert events_arg[0].source_format == "framework"
        assert "framework:langchain" in events_arg[0].tags


class TestIngestWebhook:
    def test_post_minimum(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        body = json.dumps({
            "event_id": "whk_1",
            "trace_id": "trace_1",
            "event_type": "custom.event",
            "timestamp": "2024-01-01T00:00:00Z",
        }).encode()
        response = api_client.post(
            "/orgs/org-123/ingest/webhook",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
        events_arg = mock_collector.ingest_batch.await_args[0][0]
        assert events_arg[0].source_format == "webhook"


# ── Error paths ───────────────────────────────────────────────────


class TestIngestErrors:
    def test_unknown_format_returns_415(
        self, api_client: TestClient, mock_collector, mock_auth, monkeypatch
    ):
        from eden.config import get_settings

        # Restrict the allow-list to exclude "openai".
        settings = get_settings()
        monkeypatch.setattr(
            settings, "ingestion_allowed_formats", ["otel"]
        )
        response = api_client.post(
            "/orgs/org-123/ingest/openai",
            content=b'{"model": "gpt-4o", "usage": {}}',
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 415
        assert "openai" in response.json()["detail"]

    def test_invalid_json_returns_422(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        response = api_client.post(
            "/orgs/org-123/ingest/webhook",
            content=b"not json",
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422

    def test_webhook_missing_event_type_returns_422(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        response = api_client.post(
            "/orgs/org-123/ingest/webhook",
            content=b'{"event_id": "x", "trace_id": "y"}',
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422
        body = response.json()
        assert "problems" in body["detail"]
        assert any("event_type" in p for p in body["detail"]["problems"])

    def test_otel_no_resource_spans_returns_422(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        response = api_client.post(
            "/orgs/org-123/ingest/otel",
            content=b'{"foo": "bar"}',
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422

    def test_body_too_large_returns_413(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        # Build a body over the 1 MiB cap.
        huge = b'{"event_type": "x", "payload": {"a": "' + b"x" * 1_100_000 + b'"}}'
        response = api_client.post(
            "/orgs/org-123/ingest/webhook",
            content=huge,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 413
