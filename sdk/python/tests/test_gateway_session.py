"""Tests for the high-level gateway session helpers.

These tests stub the openai package so they can run without the
real SDK installed. The OpenAI class is imported lazily inside
:func:`eden_sdk.gateway_session.openai_client`.
"""

from __future__ import annotations

import sys
import types

import pytest

from eden_sdk.config import EdenConfig
from eden_sdk.filters import FilterConfig, PIIConfig


class _FakeOpenAI:
    """Stand-in for ``openai.OpenAI``. Records kwargs the
    helper passes; returns a MagicMock so the test can assert
    on the call."""

    instances: list[dict] = []

    def __init__(self, *, api_key=None, base_url=None, default_headers=None):
        self.kwargs = {
            "api_key": api_key,
            "base_url": base_url,
            "default_headers": dict(default_headers or {}),
        }
        self.__class__.instances.append(self.kwargs)

    @classmethod
    def reset(cls) -> None:
        cls.instances = []


@pytest.fixture
def fake_openai(monkeypatch):
    """Inject a fake ``openai.OpenAI`` so :func:`openai_client` can
    run without the real package installed.
    """
    fake_module = types.ModuleType("openai")
    fake_module.OpenAI = _FakeOpenAI  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openai", fake_module)
    _FakeOpenAI.reset()
    return _FakeOpenAI


class TestOpenAIClientHelper:
    def test_returns_configured_client(self, fake_openai):
        from eden_sdk.gateway_session import openai_client

        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            gateway_url="https://gateway.eden.ai/v1",
        )
        client = openai_client(cfg)
        assert client.kwargs["base_url"] == "https://gateway.eden.ai/v1"
        assert client.kwargs["default_headers"]["X-Org-Api-Key"] == "k"

    def test_renders_filter_headers(self, fake_openai):
        from eden_sdk.gateway_session import openai_client

        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            filters=FilterConfig(
                pii=PIIConfig(
                    mode="fail_closed",
                    disabled_categories=["api_key"],
                ),
            ),
        )
        client = openai_client(cfg)
        h = client.kwargs["default_headers"]
        assert h["X-PII-Mode"] == "fail_closed"
        assert h["X-PII-Disabled-Categories"] == "api_key"

    def test_per_call_filter_override(self, fake_openai):
        from eden_sdk.gateway_session import openai_client

        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            filters=FilterConfig(pii=PIIConfig(mode="redact")),
        )
        client = openai_client(
            cfg,
            filters=FilterConfig(pii=PIIConfig(mode="off")),
        )
        h = client.kwargs["default_headers"]
        # Per-call override wins.
        assert h["X-PII-Mode"] == "off"

    def test_upstream_override_headers(self, fake_openai):
        from eden_sdk.gateway_session import openai_client

        cfg = EdenConfig(org_id="o", api_key="k")
        client = openai_client(
            cfg,
            upstream_base_url="https://my-internal.example.com/v1",
            upstream_api_key="sk-internal",
            upstream_provider="openai",
        )
        h = client.kwargs["default_headers"]
        assert h["X-Upstream-Base-Url"] == "https://my-internal.example.com/v1"
        assert h["X-Upstream-Api-Key"] == "sk-internal"
        assert h["X-Upstream-Provider"] == "openai"

    def test_imports_openai_lazily(self, monkeypatch):
        """When the openai package isn't installed, the import
        inside the helper raises a clear RuntimeError instead of
        a ModuleNotFoundError at module load time."""
        from eden_sdk import gateway_session

        monkeypatch.setitem(sys.modules, "openai", None)
        with pytest.raises(RuntimeError, match="openai package"):
            gateway_session.openai_client(
                EdenConfig(org_id="o", api_key="k"),
            )


class TestChatCompletionHelper:
    def test_makes_call_and_returns(self, fake_openai):
        """Smoke test: ``chat_completion`` builds the client and
        proxies to ``chat.completions.create``. We patch the
        namespace on the fake class so the test doesn't need a
        real ``openai`` SDK."""
        from eden_sdk import gateway_session

        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
        )

        # Build the nested chat.completions.create attribute on the
        # fake class so the helper can find it. We use a plain
        # callable as the mock so we can introspect the call.
        called_with: list[dict] = []

        def _create(**kwargs):
            called_with.append(kwargs)
            return {"id": "stub", "choices": []}

        _FakeOpenAI.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=_create),
        )

        resp = gateway_session.chat_completion(
            cfg,
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "hi"}],
        )
        assert resp == {"id": "stub", "choices": []}
        # Filter header was threaded into the client.
        assert _FakeOpenAI.instances[0]["default_headers"]["X-PII-Mode"] == "fail_closed"
        # And the call itself carried the right args.
        assert called_with[0]["model"] == "gpt-4o-mini"
        assert called_with[0]["messages"] == [{"role": "user", "content": "hi"}]
        assert called_with[0]["stream"] is False
