"""FEAT-23: operation_name derivation + agent-linkage field pull-through
at the ingestion route.

Covers:
* Shared ``_OPERATION_NAME_MAP`` / ``derive_operation_name`` in
  ``eden.observability.operation_names`` (also imported by
  ``otel_exporter.py``).
* The extended mapping: ``"tool.call"`` -> ``"execute_tool"`` and any
  event carrying a ``parent_agent_span_id`` / ``a2a`` attribute ->
  ``"invoke_agent"``.
* The ingestion route (``POST /orgs/{org_id}/ingest/webhook``) sets
  ``TelemetryEvent.operation_name`` and pulls
  ``parent_agent_span_id`` / ``child_agent_trace_id`` out of the
  attributes JSONB blob into the real dataclass fields before handing
  events to the collector.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from eden.observability.operation_names import _OPERATION_NAME_MAP, derive_operation_name

# ── shared-module unit tests ────────────────────────────────────────


class _FakeEvent:
    def __init__(self, event_type, attributes=None):
        self.event_type = event_type
        self.attributes = attributes or {}


class TestDeriveOperationName:
    def test_tool_call_maps_to_execute_tool(self) -> None:
        assert derive_operation_name(_FakeEvent("tool.call")) == "execute_tool"

    def test_llm_call_event_types_unchanged(self) -> None:
        assert derive_operation_name(_FakeEvent("anthropic.message")) == "chat"
        assert derive_operation_name(_FakeEvent("bedrock.invoke_model")) == "invoke_model"

    def test_parent_agent_span_id_attribute_forces_invoke_agent(self) -> None:
        event = _FakeEvent("span.start", {"parent_agent_span_id": "span-1"})
        assert derive_operation_name(event) == "invoke_agent"

    def test_a2a_attribute_forces_invoke_agent_even_without_parent_span(self) -> None:
        event = _FakeEvent("span.start", {"a2a": {"invocation_type": "a2a.send_message"}})
        assert derive_operation_name(event) == "invoke_agent"

    def test_invoke_agent_wins_over_event_type_mapping(self) -> None:
        # A tool.call that is ALSO an agent-to-agent hop must be
        # invoke_agent, not execute_tool.
        event = _FakeEvent("tool.call", {"parent_agent_span_id": "span-1"})
        assert derive_operation_name(event) == "invoke_agent"

    def test_unknown_event_type_falls_back_to_chat(self) -> None:
        assert derive_operation_name(_FakeEvent("span.start")) == "chat"
        assert derive_operation_name(_FakeEvent("env.step")) == "chat"

    def test_map_has_no_blanket_chat_only_entries_for_eden_native_types(self) -> None:
        assert _OPERATION_NAME_MAP.get("tool.call") == "execute_tool"
        # span.start / env.step deliberately absent — routed through the
        # attribute-based invoke_agent rule or the "chat" fallback, not
        # a hardcoded map entry.
        assert "span.start" not in _OPERATION_NAME_MAP
        assert "env.step" not in _OPERATION_NAME_MAP


# ── ingestion-route integration tests ───────────────────────────────


@pytest.fixture
def mock_collector() -> AsyncMock:
    collector = AsyncMock()
    collector.ingest_batch = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "total": 1}
    )
    return collector


@pytest.fixture
def ingest_client(api_client: TestClient, mock_collector, monkeypatch):
    from eden.api.app import app
    from eden.api.deps import get_ingest_auth
    from eden.api.routes import ingestion as ingestion_module
    from eden.observability import telemetry_collector as tc_module

    fake_auth = {
        "org_id": "org-123",
        "user_id": None,
        "api_key_id": "key-abc",
        "auth_method": "api_key",
        "scopes": ["ingest:write"],
    }
    app.dependency_overrides[get_ingest_auth] = lambda: fake_auth

    async def _get():
        return mock_collector

    monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(ingestion_module, "get_telemetry_collector", _get)

    api_client.cookies.clear()
    try:
        yield api_client, fake_auth, mock_collector
    finally:
        app.dependency_overrides.pop(get_ingest_auth, None)


class TestIngestionRouteDerivesOperationName:
    def test_tool_call_event_gets_execute_tool_operation_name(
        self, ingest_client
    ) -> None:
        client, _auth, mock_collector = ingest_client
        body = json.dumps(
            {
                "event_type": "tool.call",
                "trace_id": "trace-tool-1",
                "name": "search_web",
            }
        ).encode()
        response = client.post(
            "/orgs/org-123/ingest/webhook",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Org-Api-Key": "irrelevant-because-of-override",
                "X-Eden-Agent-Id": "agent-1",
            },
        )
        assert response.status_code == 200, response.text
        [event] = mock_collector.ingest_batch.await_args.args[0]
        assert event.operation_name == "execute_tool"

    def test_a2a_agent_linkage_pulled_out_of_attributes_blob(
        self, ingest_client
    ) -> None:
        client, _auth, mock_collector = ingest_client
        body = json.dumps(
            {
                "event_type": "span.start",
                "trace_id": "trace-a2a-1",
                "name": "delegate_to_subagent",
                "attributes": {
                    "parent_agent_span_id": "span-parent-99",
                    "child_agent_trace_id": "trace-child-99",
                    "a2a": {"invocation_type": "a2a.send_message"},
                },
            }
        ).encode()
        response = client.post(
            "/orgs/org-123/ingest/webhook",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Org-Api-Key": "irrelevant-because-of-override",
                "X-Eden-Agent-Id": "agent-1",
            },
        )
        assert response.status_code == 200, response.text
        [event] = mock_collector.ingest_batch.await_args.args[0]
        # Pulled out of the JSONB attributes blob into real columns.
        assert event.parent_agent_span_id == "span-parent-99"
        assert event.child_agent_trace_id == "trace-child-99"
        # Any A2A-linked event is an agent invocation, not a chat call.
        assert event.operation_name == "invoke_agent"
        # Still present in the attributes blob too (non-destructive pull).
        assert event.attributes.get("parent_agent_span_id") == "span-parent-99"

    def test_plain_chat_event_still_defaults_to_chat(self, ingest_client) -> None:
        client, _auth, mock_collector = ingest_client
        body = json.dumps(
            {
                "event_type": "llm.completion",
                "trace_id": "trace-chat-1",
                "name": "gpt-4o",
            }
        ).encode()
        response = client.post(
            "/orgs/org-123/ingest/webhook",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Org-Api-Key": "irrelevant-because-of-override",
                "X-Eden-Agent-Id": "agent-1",
            },
        )
        assert response.status_code == 200, response.text
        [event] = mock_collector.ingest_batch.await_args.args[0]
        assert event.operation_name == "chat"
