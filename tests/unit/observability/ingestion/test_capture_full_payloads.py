"""Phase 7.2 — full LLM-call capture tests.

These tests verify that every decoder populates the new capture
columns (request_body, response_body, reasoning, tool_calls_full,
tool_results, images, audio, logprobs, citations, finish_reason,
system_fingerprint, cache_hit, prompt_cache_savings_usd) from the
provider's wire format. Round-trip every field, including the rare
ones (o1 reasoning, Anthropic thinking, Gemini thoughts, citations,
logprobs, audio, prompt-cache hit detection).
"""

import asyncio
import json
import sys
import pytest

sys.path.insert(0, "src")

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.providers import (
    OpenAIDecoder,
    AnthropicDecoder,
    BedrockDecoder,
    GeminiDecoder,
)
from eden.observability.ingestion.helicone import HeliconeDecoder
from eden.observability.ingestion.otel import OtelDecoder
from eden.observability.ingestion.langfuse import LangfuseDecoder


def _attr():
    return Attribution(
        tenant_id="t1", project_id="p1", source_format="x",
        user_id=None, api_key_id=None, auth_method="test",
    )


# ── OpenAI ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_openai_capture_o1_reasoning():
    body = json.dumps({
        "id": "r1", "model": "o3-mini", "object": "chat.completion",
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "42"}}],
        "usage": {
            "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
            "completion_tokens_details": {"reasoning_tokens": 200},
        },
    }).encode()
    events = await OpenAIDecoder().decode(body, _attr())
    e = events[0]
    assert e.reasoning is not None
    assert e.reasoning["o1_tokens"] == 200
    assert e.response_body is not None
    assert e.response_body["id"] == "r1"


@pytest.mark.asyncio
async def test_openai_capture_tool_calls():
    body = json.dumps({
        "id": "r2", "model": "gpt-4o",
        "choices": [{"finish_reason": "tool_calls", "message": {
            "role": "assistant", "content": None,
            "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": {"name": "get_weather", "arguments": '{"city":"NYC"}'},
            }],
        }}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    }).encode()
    events = await OpenAIDecoder().decode(body, _attr())
    e = events[0]
    assert len(e.tool_calls_full) == 1
    assert e.tool_calls_full[0]["function"]["name"] == "get_weather"
    assert e.tool_calls_full[0]["function"]["arguments"] == '{"city":"NYC"}'
    assert e.finish_reason == "tool_calls"


@pytest.mark.asyncio
async def test_openai_capture_logprobs():
    body = json.dumps({
        "id": "r3", "model": "gpt-4o",
        "choices": [{
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "Hi"},
            "logprobs": {"content": [{"token": "Hi", "logprob": -0.01, "bytes": [72, 105]}]},
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }).encode()
    events = await OpenAIDecoder().decode(body, _attr())
    assert events[0].logprobs is not None
    assert events[0].logprobs["content"][0]["token"] == "Hi"


@pytest.mark.asyncio
async def test_openai_capture_citations():
    body = json.dumps({
        "id": "r4", "model": "o3",
        "choices": [{
            "finish_reason": "stop",
            "message": {
                "role": "assistant", "content": "Yes",
                "annotations": [
                    {"type": "url_citation", "url": "https://example.com",
                     "title": "Example", "start_index": 0, "end_index": 5},
                ],
            },
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }).encode()
    events = await OpenAIDecoder().decode(body, _attr())
    assert len(events[0].citations) == 1
    assert events[0].citations[0]["url"] == "https://example.com"


@pytest.mark.asyncio
async def test_openai_capture_cache_hit():
    body = json.dumps({
        "id": "r5", "model": "gpt-4o",
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "x"}}],
        "usage": {
            "prompt_tokens": 100, "completion_tokens": 1, "total_tokens": 101,
            "prompt_tokens_details": {"cached_tokens": 80},
        },
    }).encode()
    events = await OpenAIDecoder().decode(body, _attr())
    assert events[0].cache_hit is True
    assert events[0].reasoning["cached_input_tokens"] == 80
    assert events[0].metrics.get("cache_read_tokens") == 80.0


@pytest.mark.asyncio
async def test_openai_capture_system_fingerprint():
    body = json.dumps({
        "id": "r6", "model": "gpt-4o",
        "system_fingerprint": "fp_abc123",
        "service_tier": "default",
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "x"}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }).encode()
    events = await OpenAIDecoder().decode(body, _attr())
    assert events[0].system_fingerprint == "fp_abc123"
    assert events[0].service_tier == "default"


# ── Anthropic ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_anthropic_capture_thinking():
    body = json.dumps({
        "id": "msg_1", "type": "message", "role": "assistant",
        "model": "claude-sonnet-4-5",
        "content": [
            {"type": "thinking", "thinking": "Let me reason...", "signature": "sig"},
            {"type": "redacted_thinking", "data": "encrypted"},
            {"type": "text", "text": "Final answer"},
        ],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 100, "output_tokens": 50},
    }).encode()
    events = await AnthropicDecoder().decode(body, _attr())
    e = events[0]
    assert e.reasoning is not None
    assert len(e.reasoning["thinking"]) == 1
    assert e.reasoning["thinking"][0]["thinking"] == "Let me reason..."
    assert len(e.reasoning["redacted"]) == 1


@pytest.mark.asyncio
async def test_anthropic_capture_tool_use():
    body = json.dumps({
        "id": "msg_2", "type": "message", "role": "assistant",
        "model": "claude-sonnet-4-5",
        "content": [
            {"type": "text", "text": "Looking it up..."},
            {"type": "tool_use", "id": "toolu_1", "name": "search",
             "input": {"query": "weather NYC"}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 100, "output_tokens": 50},
    }).encode()
    events = await AnthropicDecoder().decode(body, _attr())
    assert len(events[0].tool_calls_full) == 1
    assert events[0].tool_calls_full[0]["name"] == "search"
    assert events[0].finish_reason == "tool_use"


@pytest.mark.asyncio
async def test_anthropic_capture_prompt_caching():
    body = json.dumps({
        "id": "msg_3", "type": "message", "role": "assistant",
        "model": "claude-sonnet-4-5",
        "content": [{"type": "text", "text": "Hi"}],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 1000, "output_tokens": 50,
            "cache_creation_input_tokens": 200,
            "cache_read_input_tokens": 700,
        },
    }).encode()
    events = await AnthropicDecoder().decode(body, _attr())
    e = events[0]
    assert e.metrics.get("cache_read_tokens") == 700.0
    assert e.cache_hit is True


@pytest.mark.asyncio
async def test_anthropic_capture_image_input():
    body = json.dumps({
        "id": "msg_4", "type": "message", "role": "assistant",
        "model": "claude-sonnet-4-5",
        "content": [
            {"type": "image", "source": {
                "type": "base64", "media_type": "image/png", "data": "iVBORw0K",
            }},
            {"type": "text", "text": "What is this?"},
        ],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 100, "output_tokens": 10},
    }).encode()
    events = await AnthropicDecoder().decode(body, _attr())
    e = events[0]
    assert len(e.images) == 1
    assert e.images[0]["content_type"] == "image/png"


# ── Gemini ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gemini_capture_thoughts():
    body = json.dumps({
        "modelVersion": "gemini-2.0-flash-thinking",
        "responseId": "resp_1",
        "candidates": [{
            "content": {"parts": [
                {"thought": True, "text": "I need to think..."},
                {"text": "Answer is 42"},
            ]},
            "finishReason": "STOP",
        }],
        "usageMetadata": {
            "promptTokenCount": 10, "candidatesTokenCount": 5,
            "thoughtsTokenCount": 200, "totalTokenCount": 215,
        },
    }).encode()
    events = await GeminiDecoder().decode(body, _attr())
    e = events[0]
    assert e.reasoning is not None
    assert len(e.reasoning["thoughts"]) == 1
    assert e.reasoning["thoughts_tokens"] == 200


@pytest.mark.asyncio
async def test_gemini_capture_function_call():
    body = json.dumps({
        "candidates": [{
            "content": {"parts": [
                {"functionCall": {"name": "get_weather", "args": {"city": "NYC"}}},
            ]},
            "finishReason": "STOP",
        }],
        "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 1, "totalTokenCount": 6},
    }).encode()
    events = await GeminiDecoder().decode(body, _attr())
    assert len(events[0].tool_calls_full) == 1
    assert events[0].tool_calls_full[0]["name"] == "get_weather"


@pytest.mark.asyncio
async def test_gemini_capture_citations():
    body = json.dumps({
        "candidates": [{
            "content": {"parts": [{"text": "Yes"}]},
            "finishReason": "STOP",
            "citationMetadata": {"citationSources": [
                {"uri": "https://a.com", "title": "A"},
            ]},
        }],
        "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
    }).encode()
    events = await GeminiDecoder().decode(body, _attr())
    assert len(events[0].citations) == 1
    assert events[0].citations[0]["url"] == "https://a.com"


# ── Bedrock ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bedrock_capture_converse_tool_use():
    body = json.dumps({
        "modelId": "anthropic.claude-3-sonnet",
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "t1", "name": "search", "input": {"q": "x"}}}],
            },
            "stopReason": "tool_use",
        },
        "usage": {"inputTokens": 100, "outputTokens": 50, "cacheReadInputTokens": 80},
    }).encode()
    events = await BedrockDecoder().decode(body, _attr())
    e = events[0]
    assert len(e.tool_calls_full) == 1
    assert e.tool_calls_full[0]["name"] == "search"
    assert e.cache_hit is True
    assert e.finish_reason == "tool_use"


# ── Helicone ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_helicone_capture_full_payload():
    body = json.dumps({
        "request_id": "req-1",
        "model": "gpt-4o",
        "request": {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]},
        "response": {
            "id": "r1",
            "choices": [{"finish_reason": "stop", "message": {
                "role": "assistant", "content": "Hello",
                "tool_calls": [{"id": "t1", "function": {"name": "f", "arguments": "{}"}}],
            }}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        },
    }).encode()
    events = await HeliconeDecoder().decode(body, _attr())
    e = events[0]
    assert e.request_body is not None
    assert e.request_body["messages"][0]["content"] == "hi"
    assert e.response_body is not None
    assert e.response_body["choices"][0]["message"]["content"] == "Hello"
    assert len(e.tool_calls_full) == 1
    assert e.finish_reason == "stop"


# ── OTel ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_otel_capture_user_assistant_messages():
    body = json.dumps({
        "resourceSpans": [{
            "scopeSpans": [{
                "spans": [{
                    "traceId": "abc", "spanId": "def",
                    "name": "openai.chat", "kind": 3,
                    "startTimeUnixNano": "1717200000000000000",
                    "endTimeUnixNano": "1717200001000000000",
                    "attributes": [
                        {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
                        {"key": "gen_ai.request.model", "value": {"stringValue": "gpt-4o"}},
                    ],
                    "events": [
                        {"name": "gen_ai.user.message", "timeUnixNano": "0",
                         "attributes": [{"key": "content", "value": {"stringValue": "Hello"}}]},
                        {"name": "gen_ai.assistant.message", "timeUnixNano": "0",
                         "attributes": [{"key": "content", "value": {"stringValue": "Hi"}}]},
                    ],
                }],
            }],
        }],
    }).encode()
    events = await OtelDecoder().decode(body, _attr())
    e = events[0]
    assert e.request_body is not None
    assert e.request_body["messages"][0]["content"] == "Hello"
    assert e.response_body is not None
    assert e.response_body["choices"][0]["message"]["content"] == "Hi"


# ── Langfuse ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_langfuse_capture_tool_use():
    body = json.dumps([{
        "id": "trace_1", "name": "t",
        "observations": [{
            "id": "obs_1", "traceId": "trace_1", "type": "GENERATION",
            "name": "openai-chat",
            "startTime": "2024-01-01T00:00:00Z",
            "endTime": "2024-01-01T00:00:01Z",
            "model": "gpt-4o",
            "input": {"messages": [{"role": "user", "content": "hi"}]},
            "output": [
                {"role": "assistant", "content": "Hello"},
                {"type": "tool_use", "id": "t1", "name": "search", "input": {"q": "x"}},
            ],
            "usage": {"promptTokens": 10, "completionTokens": 5, "totalTokens": 15},
        }],
    }]).encode()
    events = await LangfuseDecoder().decode(body, _attr())
    e = events[0]
    assert e.request_body is not None
    assert e.response_body is not None
    assert len(e.tool_calls_full) == 1
    assert e.tool_calls_full[0]["name"] == "search"
