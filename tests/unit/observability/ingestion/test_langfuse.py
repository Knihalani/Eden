"""Tests for the Langfuse decoder."""

import json

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import SchemaInvalidError
from eden.observability.ingestion.langfuse import LangfuseDecoder


def _generation_observation(**overrides) -> dict:
    obs = {
        "id": "obs_1",
        "traceId": "trace_1",
        "type": "GENERATION",
        "name": "openai-chat",
        "startTime": "2024-01-01T00:00:00.000Z",
        "endTime": "2024-01-01T00:00:01.000Z",
        "model": "gpt-4o",
        "modelParameters": {"temperature": 0.7},
        "input": "Hello",
        "output": "Hi",
        "usage": {"promptTokens": 10, "completionTokens": 20, "totalTokens": 30},
        "level": "DEFAULT",
        "metadata": {"foo": "bar"},
    }
    obs.update(overrides)
    return obs


def _trace(observations=None, scores=None, **trace_overrides) -> dict:
    if observations is None:
        observations = [_generation_observation()]
    t = {
        "id": "trace_1",
        "name": "my-trace",
        "userId": "user-1",
        "sessionId": "session-1",
        "release": "v1.0",
        "tags": ["production"],
        "observations": observations,
        "scores": scores or [],
    }
    t.update(trace_overrides)
    return t


# ── LangfuseDecoder.detect ────────────────────────────────────────


def test_langfuse_detect_list_with_observations():
    body = json.dumps([{"id": "t1", "observations": []}]).encode()
    assert LangfuseDecoder().detect(body, None) is True


def test_langfuse_detect_list_with_scores():
    body = json.dumps([{"id": "t1", "scores": []}]).encode()
    assert LangfuseDecoder().detect(body, None) is True


def test_langfuse_detect_dict_with_batch():
    body = json.dumps({"batch": [{"id": "t1"}]}).encode()
    assert LangfuseDecoder().detect(body, None) is True


def test_langfuse_detect_dict_with_observations():
    body = json.dumps({"id": "t1", "observations": []}).encode()
    assert LangfuseDecoder().detect(body, None) is True


def test_langfuse_detect_negative():
    assert LangfuseDecoder().detect(b'{"foo": "bar"}', None) is False
    assert LangfuseDecoder().detect(b"not json", None) is False


# ── LangfuseDecoder.decode (full) ─────────────────────────────────


@pytest.mark.asyncio
async def test_langfuse_decode_single_generation():
    events = await LangfuseDecoder().decode(
        json.dumps([_trace()]).encode(),
        Attribution(tenant_id="org_abc", source_format="langfuse"),
    )
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "langfuse.generation"
    assert e.name == "openai-chat"
    assert e.trace_id == "trace_1"
    assert e.span_id == "obs_1"
    assert e.source_format == "langfuse"
    assert e.metrics["input_tokens"] == 10.0
    assert e.metrics["output_tokens"] == 20.0
    assert e.metrics["total_tokens"] == 30.0
    assert e.outcome == "success"


@pytest.mark.asyncio
async def test_langfuse_decode_error_level_becomes_failure():
    trace = _trace(observations=[_generation_observation(level="ERROR")])
    events = await LangfuseDecoder().decode(
        json.dumps([trace]).encode(),
        Attribution(tenant_id="org_abc", source_format="langfuse"),
    )
    assert events[0].outcome == "failure"


@pytest.mark.asyncio
async def test_langfuse_decode_scores_become_attributes():
    trace = _trace(scores=[
        {"id": "s1", "observationId": "obs_1", "name": "quality", "value": 0.95}
    ])
    events = await LangfuseDecoder().decode(
        json.dumps([trace]).encode(),
        Attribution(tenant_id="org_abc", source_format="langfuse"),
    )
    assert events[0].attributes["score.quality"] == "0.95"


@pytest.mark.asyncio
async def test_langfuse_decode_trace_level_score_falls_back_to_attributes():
    """A score with no observationId is attached to the first event."""
    trace = _trace(scores=[
        {"id": "s1", "name": "overall", "value": 0.5}
    ])
    events = await LangfuseDecoder().decode(
        json.dumps([trace]).encode(),
        Attribution(tenant_id="org_abc", source_format="langfuse"),
    )
    assert events[0].attributes["score.overall"] == "0.5"


@pytest.mark.asyncio
async def test_langfuse_decode_span_type_event():
    trace = _trace(observations=[_generation_observation(
        id="obs_2", type="SPAN", name="some-span"
    )])
    events = await LangfuseDecoder().decode(
        json.dumps([trace]).encode(),
        Attribution(tenant_id="org_abc", source_format="langfuse"),
    )
    assert events[0].event_type == "langfuse.span"


@pytest.mark.asyncio
async def test_langfuse_decode_tool_type():
    trace = _trace(observations=[_generation_observation(
        id="obs_2", type="TOOL", name="web-search"
    )])
    events = await LangfuseDecoder().decode(
        json.dumps([trace]).encode(),
        Attribution(tenant_id="org_abc", source_format="langfuse"),
    )
    assert events[0].event_type == "langfuse.tool"


@pytest.mark.asyncio
async def test_langfuse_decode_batch_shape():
    """``{"batch": [...]}`` is accepted."""
    body = json.dumps({"batch": [_trace()]}).encode()
    events = await LangfuseDecoder().decode(
        body, Attribution(tenant_id="org_abc", source_format="langfuse")
    )
    assert len(events) == 1


@pytest.mark.asyncio
async def test_langfuse_decode_single_trace_dict():
    """A single dict (not in a list) is also accepted."""
    body = json.dumps(_trace()).encode()
    events = await LangfuseDecoder().decode(
        body, Attribution(tenant_id="org_abc", source_format="langfuse")
    )
    assert len(events) == 1


@pytest.mark.asyncio
async def test_langfuse_decode_trace_without_observations_emits_trace_event():
    trace = _trace(observations=[])
    events = await LangfuseDecoder().decode(
        json.dumps([trace]).encode(),
        Attribution(tenant_id="org_abc", source_format="langfuse"),
    )
    assert len(events) == 1
    assert events[0].event_type == "langfuse.trace"


@pytest.mark.asyncio
async def test_langfuse_decode_invalid_json_raises():
    with pytest.raises(SchemaInvalidError):
        await LangfuseDecoder().decode(
            b"not json",
            Attribution(tenant_id="org_abc", source_format="langfuse"),
        )


@pytest.mark.asyncio
async def test_langfuse_decode_empty_list_raises():
    with pytest.raises(SchemaInvalidError, match="no traces"):
        await LangfuseDecoder().decode(
            b"[]", Attribution(tenant_id="org_abc", source_format="langfuse")
        )


@pytest.mark.asyncio
async def test_langfuse_decode_tags_carry_through():
    trace = _trace()
    events = await LangfuseDecoder().decode(
        json.dumps([trace]).encode(),
        Attribution(tenant_id="org_abc", source_format="langfuse"),
    )
    assert "production" in events[0].tags
    assert "release:v1.0" in events[0].tags
    assert "langfuse.type:generation" in events[0].tags
