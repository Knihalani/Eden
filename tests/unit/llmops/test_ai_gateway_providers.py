"""Full provider-matrix tests for the AI gateway.

Three wire formats, thirteen providers, all driven from env vars.

  Wire formats:
    - OpenAI-compatible  (POST /v1/chat/completions) — used by OpenAI,
      Groq, Together, Fireworks, OpenRouter, MiniMax, vLLM, LM Studio,
      llama.cpp, Ollama's /v1 endpoint.
    - Anthropic-compatible (POST /v1/messages) — used by Anthropic
      direct and any Anthropic-format proxy.
    - Ollama-compatible — same wire format as OpenAI-compatible for the
      gateway's purposes (we go through /v1/chat/completions), but
      routed via OllamaClient for the local case.

These tests are the integration seam — they verify that any provider
the user points Eden at (via env vars or explicit ``register_provider``
call) gets the right wire format, the right credentials, and the
right cost tracking.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from eden.llmops.ai_gateway import (
    AIGateway,
    AnthropicCompatibleClient,
    OllamaClient,
    OpenAICompatibleClient,
    PROVIDER_SPECS,
    Provider,
    ProviderSpec,
    WireFormat,
    _build_client_for_provider,
    register_default_providers,
    register_providers_from_env,
)


# ────────────────────────────────────────────────────────────────────────
# Provider enum + PROVIDER_SPECS table
# ────────────────────────────────────────────────────────────────────────


EXPECTED_PROVIDERS = {
    Provider.OPENAI, Provider.OPENROUTER, Provider.MINIMAX,
    Provider.ANTHROPIC,
    Provider.OLLAMA, Provider.OLLAMA_CLOUD,
    Provider.VLLM, Provider.LMSTUDIO, Provider.LLAMACPP,
    Provider.SELF_HOSTED,
}


def test_provider_enum_has_all_documented_providers():
    assert EXPECTED_PROVIDERS.issubset(set(Provider)), (
        f"missing: {EXPECTED_PROVIDERS - set(Provider)}"
    )


def test_provider_specs_covers_every_provider():
    assert EXPECTED_PROVIDERS.issubset(PROVIDER_SPECS.keys()), (
        f"missing specs for: {EXPECTED_PROVIDERS - PROVIDER_SPECS.keys()}"
    )


def test_every_provider_spec_has_required_fields():
    for provider, spec in PROVIDER_SPECS.items():
        assert isinstance(spec, ProviderSpec), f"{provider}: not a ProviderSpec"
        assert spec.wire_format in WireFormat, f"{provider}: bad wire_format"
        assert spec.base_url.startswith("http"), f"{provider}: bad base_url"
        assert 0.0 <= spec.quality <= 1.0, f"{provider}: quality out of range"
        assert 0.0 <= spec.reliability <= 1.0, f"{provider}: reliability out of range"
        assert spec.latency_p95_ms >= 0, f"{provider}: negative latency"
        assert spec.cost_per_1k_input >= 0.0, f"{provider}: negative input cost"
        assert spec.cost_per_1k_output >= 0.0, f"{provider}: negative output cost"


def test_wire_formats_partition_correctly():
    """Three wire formats, assigned correctly per the table above."""
    openai_compat = {
        Provider.OPENAI, Provider.OPENROUTER, Provider.MINIMAX,
        Provider.VLLM, Provider.LMSTUDIO, Provider.LLAMACPP,
        Provider.SELF_HOSTED,
    }
    anthropic_compat = {Provider.ANTHROPIC}
    ollama_compat = {Provider.OLLAMA, Provider.OLLAMA_CLOUD}
    for provider, spec in PROVIDER_SPECS.items():
        if provider in openai_compat:
            assert spec.wire_format == WireFormat.OPENAI, provider
        elif provider in anthropic_compat:
            assert spec.wire_format == WireFormat.ANTHROPIC, provider
        elif provider in ollama_compat:
            assert spec.wire_format == WireFormat.OLLAMA, provider


def test_self_hosted_providers_have_zero_cost():
    for provider in (Provider.OLLAMA, Provider.VLLM, Provider.LMSTUDIO,
                     Provider.LLAMACPP, Provider.SELF_HOSTED):
        spec = PROVIDER_SPECS[provider]
        assert spec.cost_per_1k_input == 0.0, f"{provider}: input cost should be 0"
        assert spec.cost_per_1k_output == 0.0, f"{provider}: output cost should be 0"


def test_cloud_providers_have_nonzero_cost():
    for provider in (Provider.OPENAI, Provider.ANTHROPIC,
                     Provider.OPENROUTER, Provider.MINIMAX,
                     Provider.OLLAMA_CLOUD):
        spec = PROVIDER_SPECS[provider]
        assert spec.cost_per_1k_input > 0.0, f"{provider}: should have nonzero input cost"
        assert spec.cost_per_1k_output > 0.0, f"{provider}: should have nonzero output cost"


# ────────────────────────────────────────────────────────────────────────
# OpenAICompatibleClient
# ────────────────────────────────────────────────────────────────────────


def _mock_response(payload: dict) -> MagicMock:
    mock = MagicMock()
    mock.json.return_value = payload
    mock.raise_for_status = MagicMock()
    return mock


@pytest.mark.asyncio
async def test_openai_compatible_posts_to_chat_completions():
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
                {"choices": [{"message": {"content": "ok"}}],
                 "usage": {"prompt_tokens": 5, "completion_tokens": 3}}
            )

    with patch("httpx.AsyncClient", _FakeAsyncClient):
        client = OpenAICompatibleClient(
            base_url="https://api.example.com/v1", api_key="test-key"
        )
        result = await client.complete(model="gpt-4o-mini", prompt="hi")

    assert captured["url"] == "https://api.example.com/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["payload"]["model"] == "gpt-4o-mini"
    assert captured["payload"]["messages"] == [{"role": "user", "content": "hi"}]
    assert result == {"text": "ok", "input_tokens": 5, "output_tokens": 3}


@pytest.mark.asyncio
async def test_openai_compatible_passes_system_prompt():
    captured: dict = {}

    class _FakeAsyncClient:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json, headers=None):
            captured["payload"] = json
            return _mock_response({"choices": [{"message": {"content": "ok"}}]})

    with patch("httpx.AsyncClient", _FakeAsyncClient):
        client = OpenAICompatibleClient(
            base_url="https://api.example.com/v1", api_key="k"
        )
        await client.complete(
            model="gpt-4o", prompt="hi", system_prompt="You are a helpful assistant."
        )

    assert captured["payload"]["messages"][:2] == [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "hi"},
    ]


@pytest.mark.asyncio
async def test_openai_compatible_passes_through_messages():
    """When caller supplies ``messages``, we use them verbatim — multi-turn."""
    captured: dict = {}

    class _FakeAsyncClient:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json, headers=None):
            captured["payload"] = json
            return _mock_response({"choices": [{"message": {"content": "ok"}}]})

    with patch("httpx.AsyncClient", _FakeAsyncClient):
        client = OpenAICompatibleClient(base_url="https://x/v1", api_key="k")
        await client.complete(
            model="gpt-4o",
            prompt="ignored",
            messages=[
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "first reply"},
                {"role": "user", "content": "follow-up"},
            ],
        )

    assert captured["payload"]["messages"] == [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "first reply"},
        {"role": "user", "content": "follow-up"},
    ]


def test_openai_compatible_reads_api_key_from_env():
    import os
    os.environ["MY_PROVIDER_KEY"] = "sk-test"
    client = OpenAICompatibleClient(
        base_url="https://my-openai-compat.example.com/v1",
        api_key_env="MY_PROVIDER_KEY",
    )
    assert client._api_key == "sk-test"


def test_openai_compatible_sentinel_for_no_auth(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("NOAUTH_KEY", raising=False)
    client = OpenAICompatibleClient(
        base_url="http://localhost:1234/v1", api_key_env="NOAUTH_KEY"
    )
    # Local servers (LM Studio, llama.cpp) ignore the key — the SDK
    # still needs one to satisfy the auth header shape.
    assert client._api_key == "not-needed"


# ────────────────────────────────────────────────────────────────────────
# AnthropicCompatibleClient
# ────────────────────────────────────────────────────────────────────────


def test_anthropic_client_requires_key():
    with pytest.raises(ValueError, match="api_key"):
        AnthropicCompatibleClient(api_key="")


@pytest.mark.asyncio
async def test_anthropic_client_posts_to_messages_endpoint():
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
            captured["headers"] = headers or {}
            captured["body"] = json
            return _mock_response(
                {"content": [{"type": "text", "text": "hello"}],
                 "usage": {"input_tokens": 8, "output_tokens": 4}}
            )

    with patch("httpx.AsyncClient", _FakeAsyncClient):
        client = AnthropicCompatibleClient(api_key="sk-ant-test")
        result = await client.complete(
            model="claude-sonnet-4-6", prompt="hi",
            system_prompt="You are concise.",
        )

    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["headers"]["x-api-key"] == "sk-ant-test"
    assert captured["headers"]["anthropic-version"] == "2023-06-01"
    assert captured["body"]["model"] == "claude-sonnet-4-6"
    assert captured["body"]["system"] == "You are concise."
    assert captured["body"]["messages"] == [{"role": "user", "content": "hi"}]
    assert result == {"text": "hello", "input_tokens": 8, "output_tokens": 4}


@pytest.mark.asyncio
async def test_anthropic_client_concatenates_multiple_text_blocks():
    class _FakeAsyncClient:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json, headers=None):
            return _mock_response(
                {"content": [
                    {"type": "text", "text": "part1 "},
                    {"type": "tool_use", "id": "x"},  # ignored
                    {"type": "text", "text": "part2"},
                ]}
            )

    with patch("httpx.AsyncClient", _FakeAsyncClient):
        client = AnthropicCompatibleClient(api_key="k")
        result = await client.complete(model="c", prompt="hi")
    assert result["text"] == "part1 part2"


@pytest.mark.asyncio
async def test_anthropic_client_handles_missing_usage_block():
    class _FakeAsyncClient:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json, headers=None):
            return _mock_response({"content": [{"type": "text", "text": "ok"}]})

    with patch("httpx.AsyncClient", _FakeAsyncClient):
        client = AnthropicCompatibleClient(api_key="k")
        result = await client.complete(model="c", prompt="hi")
    assert result == {"text": "ok", "input_tokens": 0, "output_tokens": 0}


# ────────────────────────────────────────────────────────────────────────
# OllamaClient — delegates to OpenAI-compatible
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ollama_client_delegates_to_openai_compatible(monkeypatch):
    """OllamaClient.complete should route through OpenAICompatibleClient
    so the OpenAI wire format has exactly one implementation."""
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
            return _mock_response(
                {"choices": [{"message": {"content": "ok"}}],
                 "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
            )

    with patch("httpx.AsyncClient", _FakeAsyncClient):
        client = OllamaClient()
        await client.complete(model="llama3.1:8b", prompt="hi")

    assert captured["url"] == "http://localhost:11434/v1/chat/completions"


# ────────────────────────────────────────────────────────────────────────
# Client factory — _build_client_for_provider
# ────────────────────────────────────────────────────────────────────────


def test_build_client_for_openai_compatible_provider():
    client = _build_client_for_provider(PROVIDER_SPECS[Provider.OPENAI])
    assert isinstance(client, OpenAICompatibleClient)
    assert client._base_url == "https://api.openai.com/v1"


def test_build_client_for_anthropic_provider():
    import os
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-test"
    client = _build_client_for_provider(PROVIDER_SPECS[Provider.ANTHROPIC])
    assert isinstance(client, AnthropicCompatibleClient)


def test_build_client_for_ollama_provider():
    client = _build_client_for_provider(PROVIDER_SPECS[Provider.OLLAMA])
    assert isinstance(client, OllamaClient)


# ────────────────────────────────────────────────────────────────────────
# register_providers_from_env
# ────────────────────────────────────────────────────────────────────────


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch):
    """Strip every LLM env var before each test in this class."""
    for var in (
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
        "MINIMAX_API_KEY", "OLLAMA_CLOUD_API_KEY",
        "VLLM_BASE_URL", "VLLM_API_KEY",
        "LMSTUDIO_BASE_URL", "LLAMACPP_BASE_URL",
        "OLLAMA_HOST",
    ):
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


def test_register_registers_only_providers_with_creds(clean_env):
    clean_env.setenv("OPENAI_API_KEY", "sk-test")
    clean_env.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    gw = AIGateway()
    registered = register_providers_from_env(gw)
    assert Provider.OPENAI in registered
    assert Provider.ANTHROPIC in registered
    # No creds → not registered (except OLLAMA which is on-by-default).
    assert Provider.OPENROUTER not in registered


def test_register_always_registers_local_ollama(clean_env):
    gw = AIGateway()
    registered = register_providers_from_env(gw)
    assert Provider.OLLAMA in registered
    assert isinstance(gw._providers[Provider.OLLAMA], OllamaClient)


def test_register_does_not_register_vllm_without_base_url(clean_env):
    gw = AIGateway()
    registered = register_providers_from_env(gw)
    assert Provider.VLLM not in registered
    assert Provider.LMSTUDIO not in registered


def test_register_vllm_when_base_url_set(clean_env):
    clean_env.setenv("VLLM_BASE_URL", "http://gpu-server:8000/v1")
    gw = AIGateway()
    registered = register_providers_from_env(gw)
    assert Provider.VLLM in registered
    assert gw._providers[Provider.VLLM]._base_url == "http://gpu-server:8000/v1"


def test_register_vllm_appends_v1_when_missing(clean_env):
    clean_env.setenv("VLLM_BASE_URL", "http://gpu-server:8000")  # no /v1
    gw = AIGateway()
    register_providers_from_env(gw)
    assert gw._providers[Provider.VLLM]._base_url == "http://gpu-server:8000/v1"


def test_register_skips_self_hosted_catchall(clean_env):
    """SELF_HOSTED is a backwards-compat alias; auto-registration
    should leave it for explicit callers only."""
    gw = AIGateway()
    register_providers_from_env(gw)
    assert Provider.SELF_HOSTED not in gw._providers


def test_register_is_idempotent(clean_env):
    clean_env.setenv("OPENAI_API_KEY", "sk-test")
    gw = AIGateway()
    first = register_providers_from_env(gw)
    second = register_providers_from_env(gw)
    assert first == second
    assert gw._providers[Provider.OPENAI] is gw._providers[Provider.OPENAI]


def test_register_preserves_user_overridden_client(clean_env):
    """If the caller manually replaces a provider's client, a subsequent
    call to register_providers_from_env must NOT clobber it."""
    clean_env.setenv("OPENAI_API_KEY", "sk-test")
    gw = AIGateway()
    custom = OpenAICompatibleClient(base_url="https://my-proxy/v1", api_key="k")
    gw.register_provider(Provider.OPENAI, custom)
    register_providers_from_env(gw)
    assert gw._providers[Provider.OPENAI] is custom


def test_register_default_providers_delegates_to_env(clean_env):
    """Backwards-compat: the old function name should still work."""
    gw = AIGateway()
    register_default_providers(gw)
    # Should have wired up the always-on Ollama at minimum.
    assert Provider.OLLAMA in gw._providers


# ────────────────────────────────────────────────────────────────────────
# Cost tracking per provider
# ────────────────────────────────────────────────────────────────────────


def test_cost_zero_for_local_ollama():
    gw = AIGateway()
    cost = gw._estimate_cost(
        Provider.OLLAMA, input_tokens=100_000, output_tokens=50_000,
        model_version="qwen2.5:32b",
    )
    assert cost == 0.0


def test_cost_zero_for_vllm_lmstudio_llamacpp():
    gw = AIGateway()
    for p in (Provider.VLLM, Provider.LMSTUDIO, Provider.LLAMACPP):
        cost = gw._estimate_cost(p, 100_000, 50_000)
        assert cost == 0.0, f"{p}: cost should be 0"


def test_cost_nonzero_for_cloud_providers():
    gw = AIGateway()
    for p in (Provider.OPENAI, Provider.ANTHROPIC,
              Provider.OPENROUTER, Provider.MINIMAX, Provider.OLLAMA_CLOUD):
        cost = gw._estimate_cost(p, 100_000, 50_000)
        assert cost > 0.0, f"{p}: cost should be > 0"


def test_cost_uses_per_model_rate_when_known():
    """gpt-4o-mini is much cheaper than gpt-4o on the same provider."""
    gw = AIGateway()
    mini = gw._estimate_cost(Provider.OPENAI, 1000, 1000, model_version="gpt-4o-mini")
    full = gw._estimate_cost(Provider.OPENAI, 1000, 1000, model_version="gpt-4o")
    assert mini < full
    assert full > mini * 5  # gpt-4o is ~10× more expensive than mini


# ────────────────────────────────────────────────────────────────────────
# Routing — _estimate_provider_performance uses MODEL_PERFORMANCE first
# ────────────────────────────────────────────────────────────────────────


def test_estimate_performance_uses_model_specific_entry():
    gw = AIGateway()
    # o1 is much slower than gpt-4o-mini; the matrix should reflect this.
    o1 = gw._estimate_provider_performance(Provider.OPENAI, "o1")
    mini = gw._estimate_provider_performance(Provider.OPENAI, "gpt-4o-mini")
    assert o1[1] > mini[1]  # latency p95


def test_estimate_performance_falls_back_to_provider_spec():
    """Unknown model on a known provider → provider-level defaults."""
    gw = AIGateway()
    perf = gw._estimate_provider_performance(Provider.OPENAI, "future-model")
    spec = PROVIDER_SPECS[Provider.OPENAI]
    # Quality + latency should match the spec (cost is blended).
    assert abs(perf[0] - spec.quality) < 0.01
    assert perf[1] == spec.latency_p95_ms