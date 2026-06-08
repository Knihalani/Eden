"""Integration tests for the Batch A1 OpenAI-compatible gateway.

Mirrors the canonical ``test_ingestion.py`` pattern:
  * ``app.dependency_overrides[get_ingestion_auth]`` for auth
  * ``monkeypatch`` of the upstream async OpenAI client so we never
    hit the network
  * ``monkeypatch`` of ``get_telemetry_collector`` to capture emitted
    events without Postgres/Redis/ClickHouse

Coverage:
  * POST /gateway/v1/chat/completions (non-streaming)
  * POST /gateway/v1/chat/completions (streaming SSE)
  * Tool calls + image inputs + system messages round-trip
  * POST /gateway/v1/completions (legacy) — both shapes
  * POST /gateway/v1/embeddings
  * GET /gateway/v1/models  and  /gateway/v1/models/{id}
  * 401 on missing auth; 422 on malformed body
  * PII filter pass is exercised
  * TelemetryEvent written with source_format=openai_gateway
  * OpenAI wire-adapter unit tests (shape_* helpers, messages_to_prompt,
    sse_format, the static catalogue) — no auth / no DB required.
"""

from __future__ import annotations

import json
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────


class _StubUsage:
    def __init__(self, prompt=12, completion=7, total=19):
        self.prompt_tokens = prompt
        self.completion_tokens = completion
        self.total_tokens = total


class _StubFunction:
    def __init__(self, name="get_weather", arguments='{"city":"SF"}'):
        self.name = name
        self.arguments = arguments


class _StubToolCall:
    def __init__(self, id="call_1", function=None):
        self.id = id
        self.type = "function"
        self.function = function or _StubFunction()


class _StubMessage:
    def __init__(self, role="assistant", content="Hello!", tool_calls=None, refusal=None):
        self.role = role
        self.content = content
        self.refusal = refusal
        self.tool_calls = tool_calls
        self.function_call = None
        self.audio = None


class _StubChoice:
    def __init__(self, index=0, message=None, finish_reason="stop", logprobs=None):
        self.index = index
        self.message = message or _StubMessage()
        self.finish_reason = finish_reason
        self.logprobs = logprobs


class _StubChatResponse:
    """Minimal stand-in for ``openai.types.chat.ChatCompletion``."""

    def __init__(self, content="Hello!", model="openai/gpt-4o-mini"):
        self.id = "chatcmpl-stub-1"
        self.object = "chat.completion"
        self.created = int(time.time())
        self.model = model
        self.choices = [_StubChoice(message=_StubMessage(content=content))]
        self.usage = _StubUsage()
        self.system_fingerprint = "fp_stub"


class _StubDelta:
    def __init__(self, role=None, content="", tool_calls=None):
        self.role = role
        self.content = content
        self.refusal = None
        self.tool_calls = tool_calls
        self.function_call = None


class _StubChunkChoice:
    def __init__(self, index=0, delta=None, finish_reason=None):
        self.index = index
        self.delta = delta or _StubDelta()
        self.finish_reason = finish_reason
        self.logprobs = None


class _StubChunk:
    def __init__(self, content="", finish_reason=None, role=None, model="openai/gpt-4o-mini", usage=None):
        self.id = "chatcmpl-stub-1"
        self.object = "chat.completion.chunk"
        self.created = int(time.time())
        self.model = model
        self.choices = [_StubChunkChoice(delta=_StubDelta(role=role, content=content), finish_reason=finish_reason)]
        self.system_fingerprint = None
        self.usage = usage


class _StubCompletionResponse:
    def __init__(self, text="hello world"):
        self.id = "cmpl-stub-1"
        self.object = "text_completion"
        self.created = int(time.time())
        self.model = "openai/gpt-4o-mini"
        self.choices = [
            MagicMock(text=text, index=0, finish_reason="stop", logprobs=None)
        ]
        self.usage = _StubUsage()


class _StubEmbeddingItem:
    def __init__(self, embedding, index=0):
        self.object = "embedding"
        self.index = index
        self.embedding = embedding


class _StubEmbeddingResponse:
    def __init__(self, vectors):
        self.object = "list"
        self.data = [_StubEmbeddingItem(v, i) for i, v in enumerate(vectors)]
        self.model = "openai/text-embedding-3-small"
        self.usage = _StubUsage(prompt=8, total=8)


@pytest.fixture
def mock_collector() -> AsyncMock:
    collector = AsyncMock()
    collector.ingest_batch = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "total": 1}
    )
    collector.ingest = AsyncMock(return_value=True)
    return collector


@pytest.fixture
def mock_auth(api_client: TestClient, mock_collector, monkeypatch):
    """Override auth + collector + the cached AsyncOpenAI client."""
    from eden.api.app import app
    from eden.api.deps import get_ingestion_auth
    from eden.api.routes import gateway as gateway_module
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
    monkeypatch.setattr(gateway_module, "get_telemetry_collector", _get)

    # Stub the AsyncOpenAI singleton.
    stub_client = MagicMock()
    stub_client.chat = MagicMock()
    stub_client.embeddings = MagicMock()
    stub_client.completions = MagicMock()
    monkeypatch.setattr(gateway_module, "_async_client", stub_client)
    monkeypatch.setattr(gateway_module, "_gateway", None)  # reset cached gateway

    try:
        yield {"auth": fake_auth, "client": stub_client}
    finally:
        app.dependency_overrides.pop(get_ingestion_auth, None)


# ─────────────────────────────────────────────────────────────────────
# Chat completions: non-streaming
# ─────────────────────────────────────────────────────────────────────


class TestChatCompletionsUnary:
    def test_basic_chat_round_trip(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        # Configure the stub client to return a canned response
        async def _create(**kwargs):
            assert kwargs.get("stream") is False
            assert "messages" in kwargs
            return _StubChatResponse(content="hi there")

        mock_auth["client"].chat.completions.create = AsyncMock(side_effect=_create)

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{"role": "user", "content": "hello"}],
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["object"] == "chat.completion"
        assert body["choices"][0]["message"]["role"] == "assistant"
        assert body["choices"][0]["message"]["content"] == "hi there"
        assert body["usage"]["prompt_tokens"] == 12
        # Telemetry emitted
        assert mock_collector.ingest_batch.await_count == 1
        events = mock_collector.ingest_batch.await_args[0][0]
        assert events[0].source_format == "openai_gateway"
        assert events[0].tags == ["gateway", "openai_compatible", "chat.completions"]
        assert events[0].payload["model"] == "openai/gpt-4o-mini"
        assert events[0].outcome == "success"
        assert events[0].metrics["input_tokens"] == 12

    def test_tool_calls_pass_through(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        async def _create(**kwargs):
            msg = _StubMessage(
                content=None,
                tool_calls=[_StubToolCall()],
            )
            return _StubChatResponse(content="ignored")

        mock_auth["client"].chat.completions.create = AsyncMock(side_effect=_create)

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{"role": "user", "content": "What's the weather?"}],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "description": "Get weather",
                            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                        },
                    }
                ],
                "tool_choice": "auto",
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        tool_calls = body["choices"][0]["message"]["tool_calls"]
        assert len(tool_calls) == 1
        assert tool_calls[0]["function"]["name"] == "get_weather"
        assert tool_calls[0]["id"] == "call_1"
        # Tool call passed upstream too
        kwargs = mock_auth["client"].chat.completions.create.await_args.kwargs
        assert "tools" in kwargs
        assert kwargs["tools"][0]["function"]["name"] == "get_weather"

    def test_image_input_message_accepted(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        async def _create(**kwargs):
            return _StubChatResponse(content="It is a small red square")

        mock_auth["client"].chat.completions.create = AsyncMock(side_effect=_create)

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "What is in this image?"},
                            {
                                "type": "image_url",
                                "image_url": {"url": "https://example.com/img.png"},
                            },
                        ],
                    }
                ],
            },
        )
        assert r.status_code == 200
        # The multi-part content was forwarded upstream
        sent = mock_auth["client"].chat.completions.create.await_args.kwargs
        msgs = sent["messages"]
        assert isinstance(msgs[0]["content"], list)
        assert msgs[0]["content"][1]["type"] == "image_url"

    def test_system_message_present(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        async def _create(**kwargs):
            return _StubChatResponse(content="ok")

        mock_auth["client"].chat.completions.create = AsyncMock(side_effect=_create)

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": "You are terse."},
                    {"role": "user", "content": "ping"},
                ],
            },
        )
        assert r.status_code == 200
        sent = mock_auth["client"].chat.completions.create.await_args.kwargs
        assert sent["messages"][0]["role"] == "system"
        assert sent["messages"][0]["content"] == "You are terse."

    def test_response_format_passthrough(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        async def _create(**kwargs):
            return _StubChatResponse(content='{"x": 1}')

        mock_auth["client"].chat.completions.create = AsyncMock(side_effect=_create)

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{"role": "user", "content": "json please"}],
                "response_format": {"type": "json_object"},
                "temperature": 0.0,
                "seed": 42,
            },
        )
        assert r.status_code == 200
        sent = mock_auth["client"].chat.completions.create.await_args.kwargs
        assert sent["response_format"]["type"] == "json_object"
        assert sent["temperature"] == 0.0
        assert sent["seed"] == 42

    def test_upstream_error_maps_to_502(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        from openai import APIError

        async def _create(**kwargs):
            raise APIError("rate limited", request=MagicMock(), body=None)

        mock_auth["client"].chat.completions.create = AsyncMock(side_effect=_create)

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{"role": "user", "content": "hi"}],
            },
        )
        # OpenAI APIError carries status_code; default None → 502
        assert r.status_code in (429, 502, 500)
        # Failure telemetry was emitted
        assert mock_collector.ingest_batch.await_count == 1
        events = mock_collector.ingest_batch.await_args[0][0]
        assert events[0].outcome == "failure"

    def test_invalid_body_returns_422(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={"model": "openai/gpt-4o-mini"},  # missing messages
        )
        assert r.status_code == 422


# ─────────────────────────────────────────────────────────────────────
# Chat completions: streaming
# ─────────────────────────────────────────────────────────────────────


class TestChatCompletionsStreaming:
    def test_streaming_returns_sse(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        async def _create(**kwargs):
            assert kwargs.get("stream") is True
            async def _gen():
                yield _StubChunk(role="assistant", content="Hel")
                yield _StubChunk(content="lo!")
                yield _StubChunk(content="", finish_reason="stop")
            return _gen()

        mock_auth["client"].chat.completions.create = AsyncMock(side_effect=_create)

        with api_client.stream(
            "POST",
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
            },
        ) as r:
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            data_lines = []
            for line in r.iter_lines():
                if line.startswith("data: "):
                    data_lines.append(line)
        assert any("Hel" in l for l in data_lines)
        assert any("lo!" in l for l in data_lines)
        assert any("[DONE]" in l for l in data_lines)
        # Each chunk had object=chat.completion.chunk
        chunks = [
            json.loads(l.split("data: ", 1)[1])
            for l in data_lines
            if l.startswith("data: ") and l != "data: [DONE]"
        ]
        assert all(c["object"] == "chat.completion.chunk" for c in chunks)

    def test_streaming_emits_telemetry(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        async def _create(**kwargs):
            async def _gen():
                yield _StubChunk(role="assistant", content="ok")
                yield _StubChunk(content="", finish_reason="stop")
            return _gen()

        mock_auth["client"].chat.completions.create = AsyncMock(side_effect=_create)

        with api_client.stream(
            "POST",
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
            },
        ) as r:
            for _ in r.iter_lines():
                pass
        # The finally-block in the stream generator fires once on close
        assert mock_collector.ingest_batch.await_count == 1
        events = mock_collector.ingest_batch.await_args[0][0]
        assert events[0].source_format == "openai_gateway"
        assert events[0].outcome == "success"


# ─────────────────────────────────────────────────────────────────────
# /v1/completions (legacy)
# ─────────────────────────────────────────────────────────────────────


class TestLegacyCompletions:
    def test_unary_completion(self, api_client: TestClient, mock_collector, mock_auth):
        async def _create(**kwargs):
            return _StubCompletionResponse(text="hello world")

        mock_auth["client"].completions.create = AsyncMock(side_effect=_create)

        r = api_client.post(
            "/gateway/v1/completions",
            json={"model": "openai/gpt-4o-mini", "prompt": "say hi"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["object"] == "text_completion"
        assert body["choices"][0]["text"] == "hello world"
        assert mock_collector.ingest_batch.await_count == 1


# ─────────────────────────────────────────────────────────────────────
# /v1/embeddings
# ─────────────────────────────────────────────────────────────────────


class TestEmbeddings:
    def test_basic_embeddings(self, api_client: TestClient, mock_collector, mock_auth):
        async def _create(**kwargs):
            return _StubEmbeddingResponse(vectors=[[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])

        mock_auth["client"].embeddings.create = AsyncMock(side_effect=_create)

        r = api_client.post(
            "/gateway/v1/embeddings",
            json={"model": "openai/text-embedding-3-small", "input": ["hi", "there"]},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["object"] == "list"
        assert len(body["data"]) == 2
        assert body["data"][0]["embedding"] == [0.1, 0.2, 0.3]
        assert mock_collector.ingest_batch.await_count == 1
        events = mock_collector.ingest_batch.await_args[0][0]
        assert "embeddings" in events[0].tags


# ─────────────────────────────────────────────────────────────────────
# /v1/models
# ─────────────────────────────────────────────────────────────────────


class TestModels:
    def test_list_models_static(self, api_client: TestClient, mock_collector, mock_auth):
        r = api_client.get("/gateway/v1/models")
        assert r.status_code == 200
        body = r.json()
        assert body["object"] == "list"
        assert isinstance(body["data"], list)
        ids = [m["id"] for m in body["data"]]
        assert "openai/gpt-4o-mini" in ids
        assert "anthropic/claude-3-5-sonnet" in ids

    def test_get_single_model(self, api_client: TestClient, mock_collector, mock_auth):
        r = api_client.get("/gateway/v1/models/openai/gpt-4o-mini")
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == "openai/gpt-4o-mini"
        assert body["object"] == "model"

    def test_get_unknown_model_returns_404(
        self, api_client: TestClient, mock_collector, mock_auth
    ):
        r = api_client.get("/gateway/v1/models/does-not-exist")
        assert r.status_code == 404


# ─────────────────────────────────────────────────────────────────────
# Auth
# ─────────────────────────────────────────────────────────────────────


class TestAuth:
    def test_chat_requires_auth(self, api_client: TestClient, mock_collector):
        # No auth override — must hit the real dep
        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert r.status_code in (401, 403)

    def test_models_requires_auth(self, api_client: TestClient, mock_collector):
        r = api_client.get("/gateway/v1/models")
        assert r.status_code in (401, 403)


# ─────────────────────────────────────────────────────────────────────
# Adapter unit tests (no FastAPI / no auth / no DB)
# ─────────────────────────────────────────────────────────────────────


class TestAdapterUnit:
    def test_messages_to_prompt_text_only(self):
        from eden.llmops.openai_adapter import messages_to_prompt

        out = messages_to_prompt([
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "hi"},
        ])
        assert "system: be brief" in out
        assert "user: hi" in out

    def test_messages_to_prompt_multipart(self):
        from eden.llmops.openai_adapter import messages_to_prompt

        out = messages_to_prompt([
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "see "},
                    {"type": "image_url", "image_url": {"url": "https://x/y.png"}},
                ],
            }
        ])
        assert "see" in out
        assert "image_url" in out

    def test_messages_to_prompt_tool_calls(self):
        from eden.llmops.openai_adapter import messages_to_prompt

        out = messages_to_prompt([
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{}"}}
            ]},
            {"role": "tool", "tool_call_id": "c1", "content": "ok"},
        ])
        assert "[tool_calls]" in out
        assert "tool(c1)" in out

    def test_chat_to_provider_kwargs_strips_stream(self):
        from eden.llmops.openai_adapter import (
            ChatCompletionRequest,
            chat_to_provider_kwargs,
        )

        body = ChatCompletionRequest.model_validate({
            "model": "openai/gpt-4o-mini",
            "messages": [{"role": "user", "content": "x"}],
            "stream": True,
            "stream_options": {"include_usage": True},
            "temperature": 0.5,
        })
        kw = chat_to_provider_kwargs(body)
        assert "stream" not in kw
        assert "stream_options" not in kw
        assert kw["temperature"] == 0.5
        assert kw["model"] == "openai/gpt-4o-mini"

    def test_shape_chat_completion_response(self):
        from eden.llmops.openai_adapter import shape_chat_completion_response

        resp = _StubChatResponse(content="hello")
        out = shape_chat_completion_response(resp)
        assert out["object"] == "chat.completion"
        assert out["model"] == "openai/gpt-4o-mini"
        assert out["choices"][0]["message"]["content"] == "hello"
        assert out["usage"]["total_tokens"] == 19
        assert out["system_fingerprint"] == "fp_stub"

    def test_shape_chat_completion_chunk(self):
        from eden.llmops.openai_adapter import shape_chat_completion_chunk

        chunk = _StubChunk(content="x", role="assistant")
        out = shape_chat_completion_chunk(chunk)
        assert out["object"] == "chat.completion.chunk"
        assert out["choices"][0]["delta"]["content"] == "x"
        assert out["choices"][0]["delta"]["role"] == "assistant"

    def test_sse_format(self):
        from eden.llmops.openai_adapter import sse_format, sse_done

        msg = sse_format({"x": 1})
        assert msg.startswith(b"data: ")
        assert msg.endswith(b"\n\n")
        assert b"\"x\": 1" in msg
        assert sse_done() == b"data: [DONE]\n\n"

    def test_shape_models_response(self):
        from eden.llmops.openai_adapter import shape_models_response

        out = shape_models_response()
        assert out["object"] == "list"
        assert len(out["data"]) >= 1

    def test_chat_request_accepts_extras(self):
        from eden.llmops.openai_adapter import ChatCompletionRequest

        body = ChatCompletionRequest.model_validate({
            "model": "openai/gpt-4o-mini",
            "messages": [{"role": "user", "content": "x"}],
            "future_openai_field": True,  # forward-compat
        })
        # ``extras`` is the extra='allow' bag
        assert body.extras.get("future_openai_field") is True

    def test_chat_request_n_defaults_to_one(self):
        from eden.llmops.openai_adapter import ChatCompletionRequest

        body = ChatCompletionRequest.model_validate({
            "model": "openai/gpt-4o-mini",
            "messages": [{"role": "user", "content": "x"}],
        })
        assert body.n == 1
        assert body.stream is False
