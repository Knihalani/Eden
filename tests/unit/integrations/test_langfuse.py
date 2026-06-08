"""Unit tests for the Langfuse integration."""
from __future__ import annotations

from eden.integrations import INTEGRATION_API_VERSION
from eden.integrations.langfuse import (
    LangfuseClient,
    eden_env_to_langfuse_dataset,
    trace_to_langfuse_event,
)


def test_eden_env_to_langfuse_dataset_maps_core_fields():
    env = {
        "id": "env_1",
        "description": "Multi-agent negotiation with limited trust",
        "tags": ["multi_agent", "negotiation"],
        "spec": {"version": 1, "stages": ["plan", "execute"]},
        "outcome_tier": "high",
        "category": "multi-agent",
        "quality_score": 0.91,
    }
    item = eden_env_to_langfuse_dataset(env)
    wire = item.to_langfuse()
    assert wire["input"]["description"] == "Multi-agent negotiation with limited trust"
    assert wire["input"]["tags"] == ["multi_agent", "negotiation"]
    assert wire["expected_output"]["spec"]["stages"] == ["plan", "execute"]
    assert wire["expected_output"]["outcome_tier"] == "high"
    assert wire["metadata"]["eden_env_id"] == "env_1"
    assert wire["metadata"]["eden_integration_version"] == INTEGRATION_API_VERSION


def test_trace_to_langfuse_event_handles_minimal_input():
    trace = {"id": "t_1", "name": "agent.run"}
    event = trace_to_langfuse_event(trace)
    wire = event.to_langfuse()
    assert wire["id"] == "t_1"
    assert wire["name"] == "agent.run"
    assert wire["input"] == {}
    assert wire["output"] == {}
    assert wire["metadata"]["eden_integration_version"] == INTEGRATION_API_VERSION


def test_trace_to_langfuse_event_generates_id_when_missing():
    trace = {"name": "agent.run", "input": {"x": 1}, "output": {"y": 2}}
    event = trace_to_langfuse_event(trace)
    assert event.trace_id  # generated, non-empty
    assert len(event.trace_id) == 32  # sha256 prefix


def test_langfuse_client_export_dataset_returns_summary_and_items():
    client = LangfuseClient(enabled=True)
    envs = [
        {"id": "env_1", "description": "d1", "spec": {}, "outcome_tier": "high"},
        {"id": "env_2", "description": "d2", "spec": {}, "outcome_tier": "medium"},
    ]
    out = client.export_dataset(envs, dataset_name="production-2026-06")
    assert isinstance(out, list)
    assert out[0]["_dataset_name"] == "production-2026-06"
    assert out[0]["count"] == 2
    assert len(out[0]["_items"]) == 2
    assert out[0]["_items"][0]["metadata"]["eden_env_id"] == "env_1"


def test_langfuse_client_disabled_still_returns_payloads():
    """Disabled means 'no SDK calls' — payload construction is still testable."""
    client = LangfuseClient(enabled=False)
    payload = client.push_trace({"id": "t", "name": "n"})
    assert payload["id"] == "t"
