"""Tests for the Helicone decoder."""

import json

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import SchemaInvalidError
from eden.observability.ingestion.helicone import (
    HeliconeDecoder,
    _split_node_id,
)


def _helicone_log(**overrides) -> dict:
    log = {
        "request_id": "req_abc123",
        "node_id": "root:child_a:grandchild",
        "model": "gpt-4o",
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
        },
        "request": {"messages": [{"role": "user", "content": "Hi"}]},
        "response": {"choices": [{"message": {"content": "Hello"}}]},
        "response_status": 200,
        "start_time": "2024-01-01T00:00:00Z",
        "end_time": "2024-01-01T00:00:01Z",
        "latency_ms": 1000,
        "cost": 0.003,
        "properties": {"feature": "chat"},
        "user_id": "user_42",
    }
    log.update(overrides)
    return log


# ── _split_node_id (low-level) ─────────────────────────────────────


def test_split_node_id_single_segment():
    assert _split_node_id("abc") == (None, "abc")


def test_split_node_id_parent_child():
    assert _split_node_id("root:child") == ("root", "child")


def test_split_node_id_three_segments():
    parent, span = _split_node_id("a:b:c")
    assert parent == "a:b"
    assert span == "c"


def test_split_node_id_empty():
    assert _split_node_id("") == (None, "")


# ── HeliconeDecoder.detect ─────────────────────────────────────────


def test_helicone_detect_positive():
    body = json.dumps({"request_id": "r1", "model": "gpt-4o"}).encode()
    assert HeliconeDecoder().detect(body, None) is True


def test_helicone_detect_negative():
    body = json.dumps({"unrelated": "object"}).encode()
    assert HeliconeDecoder().detect(body, None) is False


def test_helicone_detect_non_json():
    assert HeliconeDecoder().detect(b"not json", None) is False


# ── HeliconeDecoder.decode (full) ─────────────────────────────────


@pytest.mark.asyncio
async def test_helicone_decode_minimum_log():
    events = await HeliconeDecoder().decode(
        json.dumps(_helicone_log()).encode(),
        Attribution(tenant_id="org_abc", source_format="helicone"),
    )
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "helicone.llm_call"
    assert e.source_format == "helicone"
    assert e.name == "gpt-4o"
    assert e.span_id == "grandchild"
    assert e.parent_span_id == "root:child_a"
    assert e.metrics["input_tokens"] == 100.0
    assert e.metrics["output_tokens"] == 50.0
    assert e.metrics["total_tokens"] == 150.0
    assert e.metrics["cost_usd"] == 0.003
    assert e.outcome == "success"
    assert e.duration_ms == 1000
    assert "prop.feature=chat" in e.tags


@pytest.mark.asyncio
async def test_helicone_decode_error_response_is_failure():
    log = _helicone_log(status="error", response_status=500)
    events = await HeliconeDecoder().decode(
        json.dumps(log).encode(),
        Attribution(tenant_id="org_abc", source_format="helicone"),
    )
    assert events[0].outcome == "failure"


@pytest.mark.asyncio
async def test_helicone_decode_timeout():
    log = _helicone_log(status="timeout")
    events = await HeliconeDecoder().decode(
        json.dumps(log).encode(),
        Attribution(tenant_id="org_abc", source_format="helicone"),
    )
    assert events[0].outcome == "timeout"


@pytest.mark.asyncio
async def test_helicone_decode_session_groups_into_trace():
    log = _helicone_log(properties={"session_id": "sess-xyz"})
    events = await HeliconeDecoder().decode(
        json.dumps(log).encode(),
        Attribution(tenant_id="org_abc", source_format="helicone"),
    )
    assert events[0].trace_id == "sess-xyz"


@pytest.mark.asyncio
async def test_helicone_decode_list_input():
    body = json.dumps([_helicone_log(), _helicone_log(request_id="req_2")]).encode()
    events = await HeliconeDecoder().decode(
        body, Attribution(tenant_id="org_abc", source_format="helicone")
    )
    assert len(events) == 2


@pytest.mark.asyncio
async def test_helicone_decode_invalid_json_raises():
    with pytest.raises(SchemaInvalidError):
        await HeliconeDecoder().decode(
            b"not json",
            Attribution(tenant_id="org_abc", source_format="helicone"),
        )


@pytest.mark.asyncio
async def test_helicone_decode_request_payload_in_payload():
    log = _helicone_log()
    events = await HeliconeDecoder().decode(
        json.dumps(log).encode(),
        Attribution(tenant_id="org_abc", source_format="helicone"),
    )
    assert "helicone" in events[0].payload
    assert events[0].payload["helicone"]["request"] == log["request"]
    assert events[0].payload["helicone"]["response"] == log["response"]
