"""Tests for the OpenAI / Anthropic / Bedrock / Gemini provider decoders."""

import json

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.providers import (
    AnthropicDecoder,
    BedrockDecoder,
    GeminiDecoder,
    OpenAIDecoder,
)


# ── OpenAI ──────────────────────────────────────────────────────────


def _openai_response(**overrides) -> dict:
    r = {
        "id": "chatcmpl-abc123",
        "object": "chat.completion",
        "created": 1700000000,
        "model": "gpt-4o-2024-08-06",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Hello there",
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
        },
    }
    r.update(overrides)
    return r


def test_openai_detect_positive():
    body = json.dumps(_openai_response()).encode()
    assert OpenAIDecoder().detect(body, None) is True


def test_openai_detect_minimal_usage():
    body = json.dumps({"model": "gpt-4o-mini", "usage": {"total_tokens": 5}}).encode()
    assert OpenAIDecoder().detect(body, None) is True


def test_openai_detect_negative():
    body = json.dumps({"foo": "bar"}).encode()
    assert OpenAIDecoder().detect(body, None) is False


@pytest.mark.asyncio
async def test_openai_decode_full_response():
    events = await OpenAIDecoder().decode(
        json.dumps(_openai_response()).encode(),
        Attribution(tenant_id="org_abc", source_format="openai"),
    )
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "openai.chat_completion"
    assert e.source_format == "openai"
    assert e.name == "gpt-4o-2024-08-06"
    assert e.metrics["input_tokens"] == 100.0
    assert e.metrics["output_tokens"] == 50.0
    assert e.metrics["total_tokens"] == 150.0
    assert e.payload["openai"]["first_message_content"] == "Hello there"
    assert e.payload["openai"]["finish_reason"] == "stop"


@pytest.mark.asyncio
async def test_openai_decode_list_input():
    body = json.dumps([_openai_response(), _openai_response(id="chatcmpl-xyz")]).encode()
    events = await OpenAIDecoder().decode(
        body, Attribution(tenant_id="org_abc", source_format="openai")
    )
    assert len(events) == 2


# ── Anthropic ──────────────────────────────────────────────────────


def _anthropic_response(**overrides) -> dict:
    r = {
        "id": "msg_abc123",
        "type": "message",
        "role": "assistant",
        "model": "claude-3-5-sonnet-20241022",
        "content": [
            {"type": "text", "text": "Hello!"},
        ],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 100,
            "output_tokens": 50,
        },
    }
    r.update(overrides)
    return r


def test_anthropic_detect_message_type():
    body = json.dumps(_anthropic_response()).encode()
    assert AnthropicDecoder().detect(body, None) is True


def test_anthropic_detect_usage_only():
    body = json.dumps({"usage": {"input_tokens": 10, "output_tokens": 5}}).encode()
    assert AnthropicDecoder().detect(body, None) is True


def test_anthropic_detect_negative():
    assert AnthropicDecoder().detect(b'{"foo": "bar"}', None) is False


@pytest.mark.asyncio
async def test_anthropic_decode_message():
    events = await AnthropicDecoder().decode(
        json.dumps(_anthropic_response()).encode(),
        Attribution(tenant_id="org_abc", source_format="anthropic"),
    )
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "anthropic.message"
    assert e.source_format == "anthropic"
    assert e.name == "claude-3-5-sonnet-20241022"
    assert e.metrics["input_tokens"] == 100.0
    assert e.metrics["output_tokens"] == 50.0
    assert e.metrics["total_tokens"] == 150.0  # 100 + 50
    assert e.outcome == "success"
    assert e.payload["anthropic"]["content_text"] == "Hello!"


@pytest.mark.asyncio
async def test_anthropic_decode_max_tokens_outcome():
    events = await AnthropicDecoder().decode(
        json.dumps(_anthropic_response(stop_reason="max_tokens")).encode(),
        Attribution(tenant_id="org_abc", source_format="anthropic"),
    )
    assert events[0].outcome == "partial"


@pytest.mark.asyncio
async def test_anthropic_decode_caching_tokens():
    events = await AnthropicDecoder().decode(
        json.dumps(_anthropic_response(usage={
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_creation_input_tokens": 200,
            "cache_read_input_tokens": 300,
        })).encode(),
        Attribution(tenant_id="org_abc", source_format="anthropic"),
    )
    assert events[0].metrics["cache_creation_tokens"] == 200.0
    assert events[0].metrics["cache_read_tokens"] == 300.0


# ── Bedrock ────────────────────────────────────────────────────────


def _bedrock_response(**overrides) -> dict:
    r = {
        "modelId": "anthropic.claude-3-sonnet-20240229-v1:0",
        "requestId": "req_xyz789",
        "usage": {
            "inputTokens": 100,
            "outputTokens": 50,
            "totalTokens": 150,
        },
        "stopReason": "end_turn",
        "input": {"messages": [{"role": "user", "content": [{"text": "Hi"}]}]},
        "output": {"message": {"content": [{"text": "Hello!"}]}},
    }
    r.update(overrides)
    return r


def test_bedrock_detect_positive():
    body = json.dumps(_bedrock_response()).encode()
    assert BedrockDecoder().detect(body, None) is True


def test_bedrock_detect_negative():
    body = json.dumps({"foo": "bar"}).encode()
    assert BedrockDecoder().detect(body, None) is False


@pytest.mark.asyncio
async def test_bedrock_decode_invoke_model():
    events = await BedrockDecoder().decode(
        json.dumps(_bedrock_response()).encode(),
        Attribution(tenant_id="org_abc", source_format="bedrock"),
    )
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "bedrock.invoke_model"
    assert e.source_format == "bedrock"
    assert e.name == "anthropic.claude-3-sonnet-20240229-v1:0"
    assert e.metrics["input_tokens"] == 100.0
    assert e.metrics["output_tokens"] == 50.0
    assert e.outcome == "success"


@pytest.mark.asyncio
async def test_bedrock_decode_error_outcome():
    events = await BedrockDecoder().decode(
        json.dumps(_bedrock_response(error={"message": "throttled"})).encode(),
        Attribution(tenant_id="org_abc", source_format="bedrock"),
    )
    assert events[0].outcome == "failure"


# ── Gemini ─────────────────────────────────────────────────────────


def _gemini_response(**overrides) -> dict:
    r = {
        "modelVersion": "gemini-1.5-pro-002",
        "responseId": "resp_abc",
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [{"text": "Hello there"}]
                },
                "finishReason": "STOP",
                "index": 0
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 50,
            "totalTokenCount": 150,
        },
    }
    r.update(overrides)
    return r


def test_gemini_detect_positive():
    body = json.dumps(_gemini_response()).encode()
    assert GeminiDecoder().detect(body, None) is True


def test_gemini_detect_with_contents():
    body = json.dumps({
        "model": "gemini-pro",
        "contents": [{"parts": [{"text": "Hi"}]}]
    }).encode()
    assert GeminiDecoder().detect(body, None) is True


def test_gemini_detect_negative():
    body = json.dumps({"foo": "bar"}).encode()
    assert GeminiDecoder().detect(body, None) is False


@pytest.mark.asyncio
async def test_gemini_decode_response():
    events = await GeminiDecoder().decode(
        json.dumps(_gemini_response()).encode(),
        Attribution(tenant_id="org_abc", source_format="gemini"),
    )
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "gemini.generate_content"
    assert e.source_format == "gemini"
    assert e.name == "gemini-1.5-pro-002"
    assert e.metrics["input_tokens"] == 100.0
    assert e.metrics["output_tokens"] == 50.0
    assert e.metrics["total_tokens"] == 150.0
    assert e.outcome == "success"
    assert e.payload["gemini"]["first_text"] == "Hello there"


@pytest.mark.asyncio
async def test_gemini_decode_safety_block_outcome():
    events = await GeminiDecoder().decode(
        json.dumps(_gemini_response(candidates=[
            {"content": {"parts": []}, "finishReason": "SAFETY", "index": 0}
        ])).encode(),
        Attribution(tenant_id="org_abc", source_format="gemini"),
    )
    assert events[0].outcome == "failure"


@pytest.mark.asyncio
async def test_gemini_decode_max_tokens_outcome():
    events = await GeminiDecoder().decode(
        json.dumps(_gemini_response(candidates=[
            {"content": {"parts": []}, "finishReason": "MAX_TOKENS", "index": 0}
        ])).encode(),
        Attribution(tenant_id="org_abc", source_format="gemini"),
    )
    assert events[0].outcome == "partial"
