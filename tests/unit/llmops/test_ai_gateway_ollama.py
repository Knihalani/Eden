"""Tests for OllamaClient + SELF_HOSTED provider registration in the AI gateway.

Covers:
  - OllamaClient.complete() POSTs to ``<host>/v1/chat/completions`` with
    the OpenAI-compat payload shape and parses the response back into
    the ``{text, input_tokens, output_tokens}`` shape the gateway expects.
  - ``host`` from constructor wins over ``OLLAMA_HOST`` env, which wins
    over the default ``localhost:11434``.
  - ``register_default_providers`` wires SELF_HOSTED with an
    OllamaClient so the gateway actually has a self-hosted provider
    reachable after a fresh startup.
  - ``_estimate_provider_performance`` looks up known Ollama model
    strings (qwen2.5:32b etc.) in MODEL_PERFORMANCE and falls back
    to the generic local-model estimate when the model is unknown.
  - ``_estimate_cost`` returns 0.0 for self-hosted providers.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.llmops.ai_gateway import (
    AIGateway,
    OllamaClient,
    Provider,
    register_default_providers,
)

# ────────────────────────────────────────────────────────────────────────
# OllamaClient.complete — wire format
# ────────────────────────────────────────────────────────────────────────


def _mock_response(payload: dict) -> MagicMock:
    mock = MagicMock()
    mock.json.return_value = payload
    mock.raise_for_status = MagicMock()
    return mock


@pytest.mark.asyncio
async def test_complete_posts_to_v1_chat_completions(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    captured: dict = {}

    class _FakeAsyncClient:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json, headers=None):
            captured["url"] = url
            captured["payload"] = json
            captured["headers"] = headers or {}
            return _mock_response(
                {
                    "choices": [{"message": {"content": "hello"}}],
                    "usage": {"prompt_tokens": 11, "completion_tokens": 5},
                }
            )

    with patch("httpx.AsyncClient", _FakeAsyncClient):
        client = OllamaClient()
        result = await client.complete(model="llama3.1:8b", prompt="hi", temperature=0.5)

    assert captured["url"] == "http://localhost:11434/v1/chat/completions"
    assert captured["payload"]["model"] == "llama3.1:8b"
    assert captured["payload"]["stream"] is False
    assert captured["payload"]["messages"] == [{"role": "user", "content": "hi"}]
    # Ollama's auth header is a sentinel — server ignores it, but the
    # client still sends the standard Bearer shape.
    assert "Authorization" in captured["headers"]
    assert result == {"text": "hello", "input_tokens": 11, "output_tokens": 5}


@pytest.mark.asyncio
async def test_complete_handles_missing_usage_block(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)

    class _FakeAsyncClient:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json, headers=None):
            # Some Ollama versions omit ``usage`` unless ``stream=false``
            # is paired with the right options.  Graceful fallback.
            return _mock_response({"choices": [{"message": {"content": "ok"}}]})

    with patch("httpx.AsyncClient", _FakeAsyncClient):
        client = OllamaClient()
        result = await client.complete(model="llama3.1:8b", prompt="hi")

    assert result == {"text": "ok", "input_tokens": 0, "output_tokens": 0}


# ────────────────────────────────────────────────────────────────────────
# Host resolution
# ────────────────────────────────────────────────────────────────────────


def test_host_default_when_no_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    client = OllamaClient()
    assert client._base_url == "http://localhost:11434/v1"


def test_host_from_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OLLAMA_HOST", "http://my-gpu:11434")
    client = OllamaClient()
    assert client._base_url == "http://my-gpu:11434/v1"


def test_host_from_constructor_wins(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OLLAMA_HOST", "http://env-host:11434")
    client = OllamaClient(host="http://ctor-host:11434")
    assert client._base_url == "http://ctor-host:11434/v1"


def test_host_with_existing_v1_suffix_is_not_doubled(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OLLAMA_HOST", "http://localhost:11434/v1")
    client = OllamaClient()
    assert client._base_url == "http://localhost:11434/v1"


# ────────────────────────────────────────────────────────────────────────
# register_default_providers
# ────────────────────────────────────────────────────────────────────────


def test_register_default_providers_wires_ollama_client(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    gw = AIGateway()
    register_default_providers(gw)
    # After the env-driven refactor, local Ollama registers as
    # Provider.OLLAMA (not the catch-all SELF_HOSTED).
    assert Provider.OLLAMA in gw._providers
    assert isinstance(gw._providers[Provider.OLLAMA], OllamaClient)


def test_register_default_providers_is_idempotent(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    gw = AIGateway()
    register_default_providers(gw)
    first = gw._providers[Provider.OLLAMA]
    register_default_providers(gw)
    second = gw._providers[Provider.OLLAMA]
    assert first is second  # same instance — register_provider overwrites


# ────────────────────────────────────────────────────────────────────────
# Performance matrix — model-keyed lookup for SELF_HOSTED
# ────────────────────────────────────────────────────────────────────────


def test_estimate_performance_for_known_ollama_model():
    gw = AIGateway()
    q = gw._estimate_provider_performance(Provider.OLLAMA, "qwen2.5:32b")
    # Cost is genuinely 0.0 for self-hosted.
    assert q[2] == 0.0
    # Quality is in the matrix range (0..1) — not the generic fallback.
    assert q[0] > 0.8


def test_estimate_performance_for_unknown_ollama_model_falls_back():
    gw = AIGateway()
    q = gw._estimate_provider_performance(Provider.OLLAMA, "future-model-99b")
    # Generic fallback is also cost 0.0.
    assert q[2] == 0.0


def test_estimate_performance_keeps_cloud_costs_unchanged():
    gw = AIGateway()
    cloud = gw._estimate_provider_performance(Provider.OPENROUTER, "claude-sonnet-4-6")
    assert cloud[2] > 0  # cloud models still cost money


# ────────────────────────────────────────────────────────────────────────
# Cost = 0 for self-hosted (the killer feature)
# ────────────────────────────────────────────────────────────────────────


def test_estimate_cost_is_zero_for_self_hosted():
    gw = AIGateway()
    cost = gw._estimate_cost(
        Provider.OLLAMA,
        input_tokens=10_000,
        output_tokens=5_000,
        model_version="qwen2.5:32b",
    )
    assert cost == 0.0
