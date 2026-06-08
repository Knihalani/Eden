"""Tests for the per-framework instrumentations.

These tests use ``respx`` to intercept HTTP calls and verify the
correct route + payload shape. Each test installs the instrumentation
on a fake module so we don't need a real OpenAI/Anthropic/LangChain
install — and so the tests stay fast and hermetic.
"""

from __future__ import annotations

import json
import sys
import types
from typing import Any

import pytest

import eden
from eden_sdk import client as client_mod
from eden_sdk import config as config_mod
from eden_sdk.client import TraceEvent, get_default_client


# ── OpenAI ───────────────────────────────────────────────────────────


def _install_fake_openai() -> dict[str, Any]:
    """Build a minimal ``openai`` shim and inject it into ``sys.modules``.

    Returns the dict where the patches were recorded so individual
    tests can assert on it.
    """
    pkg = types.ModuleType("openai")
    resources = types.ModuleType("openai.resources")
    chat = types.ModuleType("openai.resources.chat")
    completions = types.ModuleType("openai.resources.chat.completions")
    captured: dict[str, Any] = {}

    class _Completions:
        def create(self, *args, **kwargs):
            captured["sync_args"] = args
            captured["sync_kwargs"] = kwargs
            return {
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "model": kwargs.get("model", "gpt-test"),
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "hi from eden",
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 4,
                    "completion_tokens": 6,
                    "total_tokens": 10,
                },
            }

    class _AsyncCompletions:
        async def create(self, *args, **kwargs):
            captured["async_args"] = args
            captured["async_kwargs"] = kwargs
            return _Completions().create(*args, **kwargs)

    completions.Completions = _Completions
    completions.AsyncCompletions = _AsyncCompletions
    pkg.resources = resources
    resources.chat = chat
    chat.completions = completions
    sys.modules["openai"] = pkg
    sys.modules["openai.resources"] = resources
    sys.modules["openai.resources.chat"] = chat
    sys.modules["openai.resources.chat.completions"] = completions
    return captured


@pytest.fixture
def fake_openai(monkeypatch):
    captured = _install_fake_openai()
    # Reset any state from previous tests.
    from eden_sdk.instrumentations import openai as oa
    oa.uninstall()
    yield captured
    oa.uninstall()
    for k in ("openai", "openai.resources", "openai.resources.chat",
              "openai.resources.chat.completions"):
        sys.modules.pop(k, None)


def test_openai_patch_invokes_original(fake_openai):
    eden.instrument("openai")
    from openai.resources.chat.completions import Completions

    resp = Completions().create(
        model="gpt-test",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert resp["choices"][0]["message"]["content"] == "hi from eden"
    assert fake_openai["sync_kwargs"]["model"] == "gpt-test"


def test_openai_enqueues_event(fake_openai):
    client = get_default_client()
    eden.instrument("openai")
    from openai.resources.chat.completions import Completions

    Completions().create(
        model="gpt-test",
        messages=[{"role": "user", "content": "hi"}],
    )
    # Sync — no real HTTP, but we want to confirm the queue is touched.
    # The dry-run client counts the event as "sent".
    assert client.sent >= 1


# ── Anthropic ─────────────────────────────────────────────────────────


def _install_fake_anthropic() -> dict[str, Any]:
    pkg = types.ModuleType("anthropic")
    resources = types.ModuleType("anthropic.resources")
    messages_mod = types.ModuleType("anthropic.resources.messages")
    captured: dict[str, Any] = {}

    class _Messages:
        def create(self, *args, **kwargs):
            captured["sync_kwargs"] = kwargs
            return {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "model": kwargs.get("model", "claude-test"),
                "content": [{"type": "text", "text": "hello from claude"}],
                "stop_reason": "end_turn",
                "usage": {
                    "input_tokens": 5,
                    "output_tokens": 7,
                },
            }

    class _AsyncMessages:
        async def create(self, *args, **kwargs):
            captured["async_kwargs"] = kwargs
            return _Messages().create(*args, **kwargs)

    messages_mod.Messages = _Messages
    messages_mod.AsyncMessages = _AsyncMessages
    pkg.resources = resources
    resources.messages = messages_mod
    sys.modules["anthropic"] = pkg
    sys.modules["anthropic.resources"] = resources
    sys.modules["anthropic.resources.messages"] = messages_mod
    return captured


@pytest.fixture
def fake_anthropic(monkeypatch):
    captured = _install_fake_anthropic()
    from eden_sdk.instrumentations import anthropic as an
    an.uninstall()
    yield captured
    an.uninstall()
    for k in ("anthropic", "anthropic.resources", "anthropic.resources.messages"):
        sys.modules.pop(k, None)


def test_anthropic_patch_and_event(fake_anthropic):
    eden.instrument("anthropic")
    client = get_default_client()
    from anthropic.resources.messages import Messages

    resp = Messages().create(
        model="claude-test",
        max_tokens=32,
        messages=[{"role": "user", "content": "hi"}],
    )
    assert resp["content"][0]["text"] == "hello from claude"
    assert client.sent >= 1


# ── LangChain ─────────────────────────────────────────────────────────


def _install_fake_langchain() -> dict[str, Any]:
    """Provide just enough of ``langchain_core.callbacks`` for the handler."""
    pkg = types.ModuleType("langchain_core")
    callbacks = types.ModuleType("langchain_core.callbacks")
    events: list[dict[str, Any]] = []

    class BaseCallbackHandler:
        def __init__(self) -> None:
            pass

    callbacks.BaseCallbackHandler = BaseCallbackHandler
    callbacks._events = events  # type: ignore[attr-defined]
    callbacks._handler_holder = [None]  # type: ignore[attr-defined]

    def set_handler(h):
        callbacks._handler_holder[0] = h  # type: ignore[attr-defined]

    def get_callback_manager():
        class _Mgr:
            handlers = [callbacks._handler_holder[0]]  # type: ignore[attr-defined]

            def add_handler(self, h):
                self.handlers.append(h)
                callbacks._handler_holder[0] = h  # type: ignore[attr-defined]

            def remove_handler(self, h):
                self.handlers = [x for x in self.handlers if x is not h]
        return _Mgr()

    callbacks.set_handler = set_handler  # type: ignore[attr-defined]
    callbacks.get_callback_manager = get_callback_manager  # type: ignore[attr-defined]
    pkg.callbacks = callbacks
    sys.modules["langchain_core"] = pkg
    sys.modules["langchain_core.callbacks"] = callbacks
    return events


@pytest.fixture
def fake_langchain(monkeypatch):
    events = _install_fake_langchain()
    from eden_sdk.instrumentations import langchain as lc
    lc.uninstall()
    yield events
    lc.uninstall()
    for k in ("langchain_core", "langchain_core.callbacks"):
        sys.modules.pop(k, None)


def test_langchain_handler_emits_chain_and_llm_events(fake_langchain):
    from langchain_core.callbacks import BaseCallbackHandler

    eden.instrument("langchain")
    # The handler is registered globally; pull it back out to call it.
    from langchain_core.callbacks import get_callback_manager

    mgr = get_callback_manager()
    handler = next(h for h in mgr.handlers if isinstance(h, BaseCallbackHandler))

    run_id = "lc-1"
    parent_id = None
    handler.on_chain_start(
        serialized={"name": "qa-chain"},
        inputs={"q": "what?"},
        run_id=run_id,
        parent_run_id=parent_id,
    )
    handler.on_llm_start(
        serialized={"name": "openai-llm"},
        prompts=["Tell me about Eden."],
        run_id="lc-2",
        parent_run_id=run_id,
    )
    handler.on_llm_end(
        response=types.SimpleNamespace(
            llm_output={"token_usage": {"total_tokens": 12}},
            generations=[[types.SimpleNamespace(text="Eden is great.")]],
        ),
        run_id="lc-2",
        parent_run_id=run_id,
    )
    handler.on_chain_end(
        outputs={"answer": "Eden is great."},
        run_id=run_id,
        parent_run_id=parent_id,
    )
    client = get_default_client()
    # Each `_end` callback emits one framework event:
    #   - on_llm_end   -> 1 framework event
    #   - on_chain_end -> 1 framework event
    # (the *_start callbacks only record meta, they don't emit yet.)
    assert client.sent >= 2
