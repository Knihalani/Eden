"""Integration tests for the per-request upstream routing contract.

Covers the new ``X-Upstream-Base-Url`` / ``X-Upstream-Api-Key`` /
``X-Upstream-Provider`` headers that let a customer pick their own
upstream (URL + key + provider) for every gateway call. Also
exercises the in-place PII redactor (so PII never reaches the
upstream), the outbound header forwarding (so OpenRouter
attribution / Anthropic version headers still land on the wire),
and the structured message redactor helper.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


class _StubUsage:
    def __init__(self, prompt=12, completion=7, total=19):
        self.prompt_tokens = prompt
        self.completion_tokens = completion
        self.total_tokens = total


class _StubMessage:
    def __init__(self, role="assistant", content="ok", tool_calls=None):
        self.role = role
        self.content = content
        self.refusal = None
        self.tool_calls = tool_calls
        self.function_call = None
        self.audio = None


class _StubChoice:
    def __init__(self, message=None, finish_reason="stop"):
        self.index = 0
        self.message = message or _StubMessage()
        self.finish_reason = finish_reason
        self.logprobs = None


class _StubChatResponse:
    def __init__(self, content="ok", model="openai/gpt-4o-mini"):
        self.id = "chatcmpl-stub-1"
        self.object = "chat.completion"
        self.created = 1700000000
        self.model = model
        self.choices = [_StubChoice(message=_StubMessage(content=content))]
        self.usage = _StubUsage()
        self.system_fingerprint = "fp_stub"


class _StubEmbeddingItem:
    def __init__(self, embedding, index=0):
        self.object = "embedding"
        self.index = index
        self.embedding = embedding


class _StubEmbeddingResponse:
    def __init__(self):
        self.object = "list"
        self.data = [_StubEmbeddingItem([0.1, 0.2, 0.3], 0)]
        self.model = "openai/text-embedding-3-small"
        self.usage = _StubUsage(prompt=4, total=4)


@pytest.fixture
def mock_collector() -> AsyncMock:
    collector = AsyncMock()
    collector.ingest_batch = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "total": 1}
    )
    collector.ingest = AsyncMock(return_value=True)
    return collector


@pytest.fixture
def upstream_routing_auth(api_client: TestClient, mock_collector, monkeypatch):
    """Override auth + collector + settings; do NOT pre-stub the
    AsyncOpenAI client. We want the production resolver to run so
    we can assert on the per-request upstream routing logic."""
    from eden.api.app import app
    from eden.api.deps import get_gateway_auth
    from eden.api.routes import gateway as gateway_module
    from eden.config import Settings, get_settings
    from eden.observability import telemetry_collector as tc_module

    fake_auth = {
        "org_id": "org-test",
        "user_id": None,
        "api_key_id": "key-xyz",
        "auth_method": "api_key",
    }
    app.dependency_overrides[get_gateway_auth] = lambda: fake_auth

    async def _get():
        return mock_collector

    monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(gateway_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(gateway_module, "_gateway", None)
    monkeypatch.setattr(gateway_module, "_upstream_client_cache", {})

    blank_settings = Settings(
        openrouter_api_key="sk-test-openrouter",
        openrouter_base_url="https://openrouter.ai/api/v1",
        minimax_api_key="sk-test-minimax",
        minimax_base_url="https://api.minimax.io/v1",
        use_minimax=False,
    )
    monkeypatch.setattr(gateway_module, "_settings", lambda: blank_settings)
    monkeypatch.setattr("eden.config.get_settings", lambda: blank_settings)

    try:
        yield {"auth": fake_auth}
    finally:
        app.dependency_overrides.pop(get_gateway_auth, None)
        get_settings.cache_clear()


def _patch_upstream_create(monkeypatch, response: Any):
    """Patch ``AsyncOpenAI.create`` (the underlying coroutine factory
    the SDK uses) so we can intercept per-request client construction
    without going through a real network."""
    from eden.api.routes import gateway as gateway_module

    created_clients: list[Any] = []

    real_init = gateway_module.AsyncOpenAI.__init__

    def _spy_init(self, **kwargs):
        created_clients.append((kwargs.get("base_url"), kwargs.get("api_key")))
        real_init(self, **kwargs)

    monkeypatch.setattr(
        gateway_module.AsyncOpenAI, "__init__", _spy_init, raising=True
    )

    # Patch the underlying coroutine on every client class attribute.
    async def _create(**kwargs):
        return response

    monkeypatch.setattr(
        gateway_module.AsyncOpenAI,
        "chat",
        MagicMock(
            completions=MagicMock(create=AsyncMock(side_effect=_create)),
        ),
        raising=False,
    )
    monkeypatch.setattr(
        gateway_module.AsyncOpenAI,
        "embeddings",
        MagicMock(create=AsyncMock(side_effect=_create)),
        raising=False,
    )
    return created_clients


# ── Per-request upstream resolution ───────────────────────────────


class TestPerRequestUpstream:
    def test_default_uses_server_openrouter(
        self, api_client: TestClient, upstream_routing_auth, monkeypatch
    ):
        from eden.api.routes import gateway as gateway_module

        created = _patch_upstream_create(
            monkeypatch, _StubChatResponse(content="hi"),
        )
        # Also patch the .chat attribute on the cached client the
        # gateway resolves so the route handler doesn't actually try
        # to hit the network.
        async def _create(**kwargs):
            return _StubChatResponse(content="hi")
        # Reach into the cached singleton after construction by
        # wrapping AsyncOpenAI.chat at the class level.
        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "chat",
            MagicMock(completions=MagicMock(create=AsyncMock(side_effect=_create))),
            raising=False,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{"role": "user", "content": "hi"}],
            },
        )
        assert r.status_code == 200, r.text
        assert len(created) == 1
        base_url, api_key = created[0]
        assert base_url == "https://openrouter.ai/api/v1"
        assert api_key == "sk-test-openrouter"

    def test_per_request_base_url_and_key_override_server(
        self, api_client: TestClient, upstream_routing_auth, monkeypatch
    ):
        from eden.api.routes import gateway as gateway_module

        async def _create(**kwargs):
            # The caller is allowed to add extra_headers via the
            # X-Upstream-* forwarding layer.
            assert "extra_headers" in kwargs
            headers = kwargs["extra_headers"]
            # OpenAI SDK lowercases header names when forwarding, so
            # check the lowercase form. (HTTP/2 mandates lowercase
            # anyway; this is just what we observe on the wire.)
            assert headers.get("x-custom-app") == "eden-test"
            return _StubChatResponse(content="ok")

        created: list[tuple[str, str]] = []

        real_init = gateway_module.AsyncOpenAI.__init__

        def _spy_init(self, **kwargs):
            created.append((kwargs.get("base_url"), kwargs.get("api_key")))
            real_init(self, **kwargs)

        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "__init__", _spy_init, raising=True,
        )
        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "chat",
            MagicMock(completions=MagicMock(create=AsyncMock(side_effect=_create))),
            raising=False,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": "hi"}],
            },
            headers={
                "X-Upstream-Base-Url": "https://my-internal-llm.example.com/v1",
                "X-Upstream-Api-Key": "sk-internal-abc",
                "X-Upstream-Provider": "openai",
                "X-Custom-App": "eden-test",  # arbitrary X-* should forward
            },
        )
        assert r.status_code == 200, r.text
        # The first created client must be the caller's upstream,
        # not the server-configured one.
        assert created[0] == (
            "https://my-internal-llm.example.com/v1",
            "sk-internal-abc",
        )

    def test_upstream_credentials_not_leaked_to_provider(
        self, api_client: TestClient, upstream_routing_auth, monkeypatch
    ):
        """``X-Upstream-Api-Key`` must NOT be present in the extra_headers
        forwarded to the upstream. Same for ``X-Org-Api-Key``."""
        from eden.api.routes import gateway as gateway_module

        seen_headers: dict[str, str] = {}

        async def _create(**kwargs):
            seen_headers.update(kwargs.get("extra_headers", {}))
            return _StubChatResponse(content="ok")

        real_init = gateway_module.AsyncOpenAI.__init__

        def _spy_init(self, **kwargs):
            real_init(self, **kwargs)

        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "__init__", _spy_init, raising=True,
        )
        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "chat",
            MagicMock(completions=MagicMock(create=AsyncMock(side_effect=_create))),
            raising=False,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": "hi"}],
            },
            headers={
                "X-Upstream-Base-Url": "https://upstream.example.com/v1",
                "X-Upstream-Api-Key": "sk-secret-upstream",
                "X-Org-Api-Key": "sk-secret-eden",
                "X-Custom-App": "should-pass",
                "HTTP-Referer": "https://my-app.example.com",
            },
        )
        assert r.status_code == 200, r.text
        assert "X-Upstream-Api-Key" not in seen_headers
        assert "x-upstream-api-key" not in seen_headers
        assert "X-Org-Api-Key" not in seen_headers
        # ``HTTP-Referer`` is an OpenRouter attribution header — must pass.
        # ``HTTP-Referer`` is an OpenRouter attribution header — must pass.
        assert seen_headers.get("http-referer") == "https://my-app.example.com"
        # ``X-Custom-App`` is an arbitrary caller header — must pass.
        assert seen_headers.get("x-custom-app") == "should-pass"

    def test_provider_label_inferred_from_base_url(self):
        """Pure-function tests for ``_infer_provider_from_base_url`` —
        no request needed, just exercise the URL → label mapping."""
        from eden.api.routes import gateway as gw

        assert gw._infer_provider_from_base_url(
            "https://openrouter.ai/api/v1"
        ) == "openrouter"
        assert gw._infer_provider_from_base_url(
            "https://api.anthropic.com/v1"
        ) == "anthropic"
        assert gw._infer_provider_from_base_url(
            "http://localhost:11434/v1"
        ) == "ollama"
        assert gw._infer_provider_from_base_url(
            "http://localhost:8000/v1"
        ) == "vllm"
        assert gw._infer_provider_from_base_url(
            "https://my-weird-host.example.com/v1"
        ) == "custom"
        assert gw._infer_provider_from_base_url(
            "http://localhost:1234/v1"
        ) == "lmstudio"
        assert gw._infer_provider_from_base_url(
            "http://localhost:8080/v1"
        ) == "llamacpp"

    def test_provider_label_emitted_in_telemetry_tag(
        self, api_client: TestClient, upstream_routing_auth, mock_collector, monkeypatch
    ):
        from eden.api.routes import gateway as gateway_module

        async def _create(**kwargs):
            return _StubChatResponse(content="ok")

        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "chat",
            MagicMock(completions=MagicMock(create=AsyncMock(side_effect=_create))),
            raising=False,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{"role": "user", "content": "hi"}],
            },
            headers={
                "X-Upstream-Base-Url": "https://openrouter.ai/api/v1",
                "X-Upstream-Provider": "openrouter",
            },
        )
        assert r.status_code == 200, r.text
        event = mock_collector.ingest_batch.await_args[0][0][0]
        assert "provider:openrouter" in event.tags
        assert event.payload.get("pii_findings") == []


# ── PII redaction in-place ──────────────────────────────────────────


class TestPIIRedaction:
    def test_pii_in_user_message_is_redacted_in_place(
        self, api_client: TestClient, upstream_routing_auth, mock_collector, monkeypatch
    ):
        from eden.api.routes import gateway as gateway_module

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "chat",
            MagicMock(completions=MagicMock(create=AsyncMock(side_effect=_create))),
            raising=False,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Email me at alice@example.com or call 415-555-1234",
                }],
            },
        )
        assert r.status_code == 200, r.text
        assert len(seen_messages) == 1
        # The message that hit the upstream must NOT contain the raw
        # email or phone — the redactor runs *before* the upstream call.
        text = seen_messages[0][0]["content"]
        assert "alice@example.com" not in text
        assert "415-555-1234" not in text
        # Telemetry records the redaction count.
        event = mock_collector.ingest_batch.await_args[0][0][0]
        findings = event.payload.get("pii_findings") or []
        assert any("pii_redacted" in f for f in findings)

    def test_pii_in_multipart_message_redacts_text_only(
        self, api_client: TestClient, upstream_routing_auth, monkeypatch
    ):
        from eden.api.routes import gateway as gateway_module

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "chat",
            MagicMock(completions=MagicMock(create=AsyncMock(side_effect=_create))),
            raising=False,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "openai/gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "my SSN is 123-45-6789"},
                        {"type": "image_url",
                         "image_url": {"url": "https://example.com/x.png"}},
                    ],
                }],
            },
        )
        assert r.status_code == 200, r.text
        parts = seen_messages[0][0]["content"]
        # Text part redacted, image part untouched.
        assert "123-45-6789" not in parts[0]["text"]
        assert "REDACTED" in parts[0]["text"].upper() or "SSN" in parts[0]["text"].upper()
        assert parts[1]["image_url"]["url"] == "https://example.com/x.png"


# ── /completions + /embeddings with per-request upstream ────────────


class TestLegacyEndpointsUpstream:
    def test_completions_uses_per_request_upstream(
        self, api_client: TestClient, upstream_routing_auth, monkeypatch
    ):
        from eden.api.routes import gateway as gateway_module

        created: list[tuple[str, str]] = []

        real_init = gateway_module.AsyncOpenAI.__init__

        def _spy_init(self, **kwargs):
            created.append((kwargs.get("base_url"), kwargs.get("api_key")))
            real_init(self, **kwargs)

        async def _create(**kwargs):
            return _StubChatResponse(content="hello world")

        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "__init__", _spy_init, raising=True,
        )
        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "completions",
            MagicMock(create=AsyncMock(side_effect=_create)),
            raising=False,
        )

        r = api_client.post(
            "/gateway/v1/completions",
            json={"model": "gpt-4o-mini", "prompt": "hi"},
            headers={
                "X-Upstream-Base-Url": "https://my-internal.example.com/v1",
                "X-Upstream-Api-Key": "sk-internal",
            },
        )
        assert r.status_code == 200, r.text
        assert created[0] == (
            "https://my-internal.example.com/v1",
            "sk-internal",
        )

    def test_embeddings_uses_per_request_upstream(
        self, api_client: TestClient, upstream_routing_auth, mock_collector, monkeypatch
    ):
        from eden.api.routes import gateway as gateway_module

        created: list[tuple[str, str]] = []

        real_init = gateway_module.AsyncOpenAI.__init__

        def _spy_init(self, **kwargs):
            created.append((kwargs.get("base_url"), kwargs.get("api_key")))
            real_init(self, **kwargs)

        async def _create(**kwargs):
            return _StubEmbeddingResponse()

        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "__init__", _spy_init, raising=True,
        )
        monkeypatch.setattr(
            gateway_module.AsyncOpenAI, "embeddings",
            MagicMock(create=AsyncMock(side_effect=_create)),
            raising=False,
        )

        r = api_client.post(
            "/gateway/v1/embeddings",
            json={"model": "text-embedding-3-small", "input": "hello"},
            headers={
                "X-Upstream-Base-Url": "https://embed.example.com/v1",
                "X-Upstream-Api-Key": "sk-embed",
            },
        )
        assert r.status_code == 200, r.text
        assert created[0] == (
            "https://embed.example.com/v1",
            "sk-embed",
        )


# ── Structured message redactor helper ─────────────────────────────


class TestRedactorHelper:
    def test_redacts_string_content(self):
        from eden.llmops.openai_adapter import redact_pii_in_messages

        msgs = [{
            "role": "user",
            "content": "Email me at bob@x.com",
        }]
        out, count, findings = redact_pii_in_messages(msgs)
        assert count == 1
        assert "bob@x.com" not in out[0]["content"]

    def test_redacts_multipart_text(self):
        from eden.llmops.openai_adapter import redact_pii_in_messages

        msgs = [{
            "role": "user",
            "content": [
                {"type": "text", "text": "call 415-555-9999"},
                {"type": "image_url", "image_url": {"url": "https://x"}},
            ],
        }]
        out, count, findings = redact_pii_in_messages(msgs)
        assert count == 1
        assert "415-555-9999" not in out[0]["content"][0]["text"]
        assert out[0]["content"][1]["image_url"]["url"] == "https://x"

    def test_no_pii_returns_zero_count(self):
        from eden.llmops.openai_adapter import redact_pii_in_messages

        msgs = [{"role": "user", "content": "hello there"}]
        _, count, findings = redact_pii_in_messages(msgs)
        assert count == 0

    def test_tool_call_arguments_redacted(self):
        from eden.llmops.openai_adapter import redact_pii_in_messages

        msgs = [{
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "send_email",
                    "arguments": '{"to": "secret@x.com"}',
                },
            }],
        }]
        out, count, findings = redact_pii_in_messages(msgs)
        assert count >= 1
        assert "secret@x.com" not in out[0]["tool_calls"][0]["function"]["arguments"]
