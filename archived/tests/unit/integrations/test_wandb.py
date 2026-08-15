"""Unit tests for the W&B Weave integration.

Covers:
  - from_bronze_event() maps LLM call events to WeaveTracePayload.
  - from_bronze_event() ignores non-LLM events.
  - fan_out_bronze_event() is a no-op when disabled.
  - WeaveClient.log() returns the right wire payload.
  - The integration is versioned.
"""
from __future__ import annotations

from eden.integrations import INTEGRATION_API_VERSION
from eden.integrations.wandb import WeaveClient, fan_out_bronze_event, from_bronze_event

# ────────────────────────────────────────────────────────────────────────
# from_bronze_event
# ────────────────────────────────────────────────────────────────────────


def test_from_bronze_event_maps_llm_call_to_payload():
    event = {
        "event_type": "llm_call",
        "id": "evt_1",
        "agent": "code",
        "slot": "primary",
        "model": "anthropic/claude-sonnet-4.6",
        "prompt_tokens": 100,
        "completion_tokens": 200,
        "cost_usd": 0.012,
        "cache_reads": 1,
        "duration_ms": 850,
        "extra": {"purpose": "spec_interview"},
    }
    payload = from_bronze_event(event)
    assert payload is not None
    assert payload.trace_id == "evt_1"
    assert payload.agent == "code"
    assert payload.slot == "primary"
    assert payload.model == "anthropic/claude-sonnet-4.6"
    assert payload.prompt_tokens == 100
    assert payload.completion_tokens == 200
    assert payload.cost_usd == 0.012
    assert payload.cache_reads == 1
    assert payload.duration_ms == 850


def test_from_bronze_event_ignores_non_llm_events():
    event = {"event_type": "kb_retrieval", "id": "evt_2"}
    assert from_bronze_event(event) is None


def test_from_bronze_event_handles_missing_optional_fields():
    event = {"event_type": "llm_call", "id": "evt_3", "model": "m"}
    payload = from_bronze_event(event)
    assert payload is not None
    assert payload.agent == "unknown"
    assert payload.slot == "unknown"
    assert payload.prompt_tokens == 0
    assert payload.cost_usd == 0.0
    assert payload.duration_ms is None


# ────────────────────────────────────────────────────────────────────────
# fan_out_bronze_event
# ────────────────────────────────────────────────────────────────────────


def test_fan_out_returns_none_when_disabled():
    client = WeaveClient(enabled=False)
    assert fan_out_bronze_event({"event_type": "llm_call", "id": "x"}, client) is None


def test_fan_out_returns_none_when_client_is_none():
    assert fan_out_bronze_event({"event_type": "llm_call", "id": "x"}, None) is None


def test_fan_out_returns_payload_when_enabled_and_llm():
    client = WeaveClient(enabled=True, project="eden")
    event = {
        "event_type": "llm_call",
        "id": "evt_5",
        "model": "m",
        "agent": "a",
        "slot": "s",
    }
    out = fan_out_bronze_event(event, client)
    assert out is not None
    assert out["id"] == "evt_5"
    assert out["op"] == "llm_call"
    assert out["attributes"]["agent"] == "a"
    assert out["attributes"]["eden.integration_version"] == INTEGRATION_API_VERSION


# ────────────────────────────────────────────────────────────────────────
# WeaveClient.log
# ────────────────────────────────────────────────────────────────────────


def test_weave_client_log_returns_wire_payload():
    client = WeaveClient(enabled=True, project="eden")
    event = {
        "event_type": "llm_call",
        "id": "evt_6",
        "model": "m",
        "agent": "code",
        "slot": "primary",
        "cost_usd": 0.05,
    }
    payload = from_bronze_event(event)
    assert payload is not None
    wire = client.log(payload)
    assert wire["id"] == "evt_6"
    assert wire["inputs"]["agent"] == "code"
    assert wire["inputs"]["model"] == "m"
    assert wire["attributes"]["cost_usd"] == 0.05
    assert wire["attributes"]["slot"] == "primary"
    assert wire["attributes"]["eden.integration_version"] == INTEGRATION_API_VERSION
