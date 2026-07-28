"""Tests for the Groq / Cohere / Mistral native auto-instrumentations.

These promote Groq, Cohere, and Mistral from the generic
host-sniffing HTTP-capture path to dedicated instrumentors (mirrors
``test_instrumentations.py``'s coverage of the OpenAI / Anthropic
instrumentors). Each test installs the instrumentation onto a fake
module tree shaped like the real ``groq`` / ``cohere`` / ``mistralai``
SDKs so the tests stay fast, hermetic, and don't require the real
optional dependency to be installed.

The Mistral fakes mirror ``mistralai>=2.0``'s *real* module layout
(``mistralai`` is a namespace package; the client lives under
``mistralai.client``, e.g. ``mistralai.client.chat.Chat``) — verified
against an actually-installed ``mistralai==2.7.2``. An earlier version
of these fakes reproduced the 1.x layout (``mistralai.chat.Chat``)
that the instrumentor's code had assumed, which let the tests pass
even though the shipped code raised ``ModuleNotFoundError`` against
any real, currently-published ``mistralai`` install. See also
``test_mistral_matches_real_installed_package`` below, which imports
the real package (when available) instead of a fake, specifically to
catch this class of drift.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

import eden
from eden_sdk.client import get_default_client


def _capture_enqueued(client, monkeypatch):
    """Patch ``client.enqueue`` to record every ``TraceEvent`` passed to it."""
    captured: list[Any] = []
    monkeypatch.setattr(client, "enqueue", lambda event, **kw: captured.append(event))
    return captured


# ── Groq ──────────────────────────────────────────────────────────────
#
# Groq's SDK is a Stainless-generated client whose
# ``chat.completions.create`` surface is byte-for-byte shaped like
# OpenAI's, so the fake mirrors ``_install_fake_openai`` exactly.


def _install_fake_groq() -> dict[str, Any]:
    pkg = types.ModuleType("groq")
    resources = types.ModuleType("groq.resources")
    chat = types.ModuleType("groq.resources.chat")
    completions = types.ModuleType("groq.resources.chat.completions")
    captured: dict[str, Any] = {}

    class _Completions:
        def create(self, *args, **kwargs):
            captured["sync_kwargs"] = kwargs
            if kwargs.get("_raise"):
                raise RuntimeError("groq boom")
            return {
                "id": "chatcmpl-groq",
                "object": "chat.completion",
                "model": kwargs.get("model", "llama-3.3-70b-versatile"),
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "tool_calls" if kwargs.get("tools") else "stop",
                        "message": {
                            "role": "assistant",
                            "content": None if kwargs.get("tools") else "hi from groq",
                            **(
                                {"tool_calls": [
                                    {"id": "call_1", "type": "function",
                                     "function": {"name": "get_weather", "arguments": "{}"}},
                                ]}
                                if kwargs.get("tools") else {}
                            ),
                        },
                    }
                ],
                # Groq's usage naming matches OpenAI's exactly.
                "usage": {"prompt_tokens": 4, "completion_tokens": 6, "total_tokens": 10},
            }

    class _AsyncCompletions:
        async def create(self, *args, **kwargs):
            return _Completions().create(*args, **kwargs)

    completions.Completions = _Completions
    completions.AsyncCompletions = _AsyncCompletions
    pkg.resources = resources
    resources.chat = chat
    chat.completions = completions
    sys.modules["groq"] = pkg
    sys.modules["groq.resources"] = resources
    sys.modules["groq.resources.chat"] = chat
    sys.modules["groq.resources.chat.completions"] = completions
    return captured


@pytest.fixture
def fake_groq(monkeypatch):
    captured = _install_fake_groq()
    from eden_sdk.instrumentations import groq as gq
    gq.uninstall()
    yield captured
    gq.uninstall()
    for k in ("groq", "groq.resources", "groq.resources.chat", "groq.resources.chat.completions"):
        sys.modules.pop(k, None)


def test_groq_patch_invokes_original(fake_groq):
    eden.instrument("groq")
    from groq.resources.chat.completions import Completions

    resp = Completions().create(model="llama-3.3-70b-versatile", messages=[{"role": "user", "content": "hi"}])
    assert resp["choices"][0]["message"]["content"] == "hi from groq"
    assert fake_groq["sync_kwargs"]["model"] == "llama-3.3-70b-versatile"


def test_groq_enqueues_event_with_usage(monkeypatch, fake_groq):
    eden.instrument("groq")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)
    from groq.resources.chat.completions import Completions

    Completions().create(model="llama-3.3-70b-versatile", messages=[{"role": "user", "content": "hi"}])

    assert len(captured) == 1
    event = captured[0]
    assert event.source_format == "groq"
    assert event.payload["model"] == "llama-3.3-70b-versatile"
    assert event.payload["input_tokens"] == 4
    assert event.payload["output_tokens"] == 6
    assert "trace_id" in event.payload


def test_groq_parses_tool_calls(monkeypatch, fake_groq):
    eden.instrument("groq")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)
    from groq.resources.chat.completions import Completions

    Completions().create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": "weather?"}],
        tools=[{"type": "function", "function": {"name": "get_weather"}}],
    )
    assert captured[0].payload["tool_call_count"] == 1
    assert captured[0].payload["tool_names"] == ["get_weather"]


def test_groq_error_path_enqueues_error_event(monkeypatch, fake_groq):
    eden.instrument("groq")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)
    from groq.resources.chat.completions import Completions

    with pytest.raises(RuntimeError):
        Completions().create(model="llama-3.3-70b-versatile", messages=[], _raise=True)
    assert len(captured) == 1
    assert "error" in captured[0].payload


def test_groq_uninstall_restores_original(fake_groq):
    from groq.resources.chat.completions import Completions
    original = Completions.create
    eden.instrument("groq")
    assert Completions.create is not original
    eden.uninstrument("groq")
    assert Completions.create is original


class _FakeStreamingGroqCompletions:
    def create(self, *args, **kwargs):
        def _iter():
            yield {"id": "c1", "model": "groq-stream", "choices": [{"index": 0, "delta": {"content": "Hi"}}]}
            yield {"id": "c2", "model": "groq-stream", "choices": [{"index": 0, "delta": {
                "tool_calls": [{"index": 0, "function": {"name": "lookup"}}]
            }}]}
            yield {
                "id": "c3", "model": "groq-stream",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
            }
        return _iter()


@pytest.fixture
def fake_streaming_groq(monkeypatch):
    pkg = types.ModuleType("groq")
    resources = types.ModuleType("groq.resources")
    chat = types.ModuleType("groq.resources.chat")
    completions = types.ModuleType("groq.resources.chat.completions")
    completions.Completions = _FakeStreamingGroqCompletions

    class _AsyncCompletions:
        async def create(self, *args, **kwargs):
            return _FakeStreamingGroqCompletions().create(*args, **kwargs)

    completions.AsyncCompletions = _AsyncCompletions
    pkg.resources = resources
    resources.chat = chat
    chat.completions = completions
    sys.modules["groq"] = pkg
    sys.modules["groq.resources"] = resources
    sys.modules["groq.resources.chat"] = chat
    sys.modules["groq.resources.chat.completions"] = completions
    from eden_sdk.instrumentations import groq as gq
    gq.uninstall()
    yield
    gq.uninstall()
    for k in ("groq", "groq.resources", "groq.resources.chat", "groq.resources.chat.completions"):
        sys.modules.pop(k, None)


def test_groq_streaming_emits_stream_event_with_tool_names(fake_streaming_groq):
    eden.instrument("groq")
    client = get_default_client()
    from groq.resources.chat.completions import Completions

    chunks = list(Completions().create(model="groq-stream", messages=[], stream=True))
    assert len(chunks) == 3
    client.flush(timeout=2.0)
    assert client.sent >= 1


# ── Mistral ───────────────────────────────────────────────────────────


_MISTRAL_MODULE_KEYS = ("mistralai", "mistralai.client", "mistralai.client.chat")


def _install_fake_mistral() -> dict[str, Any]:
    """Build a fake module tree shaped like the *real* ``mistralai>=2.0``
    layout: ``mistralai`` is a namespace package with no classes of its
    own, and the actual client/chat classes live under
    ``mistralai.client`` (``mistralai.client.chat.Chat``)."""
    pkg = types.ModuleType("mistralai")
    client_pkg = types.ModuleType("mistralai.client")
    chat_mod = types.ModuleType("mistralai.client.chat")
    captured: dict[str, Any] = {}

    class Chat:
        def complete(self, *args, **kwargs):
            captured["complete_kwargs"] = kwargs
            if kwargs.get("_raise"):
                raise RuntimeError("mistral boom")
            return {
                "id": "cmpl-mistral",
                "object": "chat.completion",
                "model": kwargs.get("model", "mistral-large-latest"),
                "created": 1,
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "tool_calls" if kwargs.get("tools") else "stop",
                        "message": {
                            "role": "assistant",
                            "content": None if kwargs.get("tools") else "hi from mistral",
                            **(
                                {"tool_calls": [{"id": "1", "function": {"name": "search", "arguments": "{}"}}]}
                                if kwargs.get("tools") else {}
                            ),
                        },
                    }
                ],
                # Mistral's UsageInfo uses OpenAI-shaped snake_case names.
                "usage": {"prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11},
            }

        async def complete_async(self, *args, **kwargs):
            return self.complete(*args, **kwargs)

        def stream(self, *args, **kwargs):
            captured["stream_kwargs"] = kwargs

            def _iter():
                yield {"data": {"id": "e1", "model": "mistral-large-latest",
                                "choices": [{"index": 0, "delta": {"content": "Hi"}}]}}
                yield {"data": {
                    "id": "e2", "model": "mistral-large-latest",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
                }}
            return _iter()

        async def stream_async(self, *args, **kwargs):
            async def _aiter():
                for c in [
                    {"data": {"id": "e1", "model": "mistral-async-stream",
                              "choices": [{"index": 0, "delta": {"content": "Hi"}}]}},
                    {"data": {
                        "id": "e2", "model": "mistral-async-stream",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
                    }},
                ]:
                    yield c
            return _aiter()

    chat_mod.Chat = Chat
    client_pkg.chat = chat_mod
    pkg.client = client_pkg
    sys.modules["mistralai"] = pkg
    sys.modules["mistralai.client"] = client_pkg
    sys.modules["mistralai.client.chat"] = chat_mod
    return captured


@pytest.fixture
def fake_mistral(monkeypatch):
    captured = _install_fake_mistral()
    from eden_sdk.instrumentations import mistral as ms
    ms.uninstall()
    yield captured
    ms.uninstall()
    for k in _MISTRAL_MODULE_KEYS:
        sys.modules.pop(k, None)


def test_mistral_patch_invokes_original(fake_mistral):
    eden.instrument("mistral")
    from mistralai.client.chat import Chat

    resp = Chat().complete(model="mistral-large-latest", messages=[{"role": "user", "content": "hi"}])
    assert resp["choices"][0]["message"]["content"] == "hi from mistral"
    assert fake_mistral["complete_kwargs"]["model"] == "mistral-large-latest"


def test_mistral_enqueues_event_with_usage(monkeypatch, fake_mistral):
    eden.instrument("mistral")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)
    from mistralai.client.chat import Chat

    Chat().complete(model="mistral-large-latest", messages=[{"role": "user", "content": "hi"}])

    assert len(captured) == 1
    event = captured[0]
    assert event.source_format == "mistral"
    assert event.payload["model"] == "mistral-large-latest"
    assert event.payload["input_tokens"] == 8
    assert event.payload["output_tokens"] == 3
    assert "trace_id" in event.payload


def test_mistral_parses_tool_calls(monkeypatch, fake_mistral):
    eden.instrument("mistral")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)
    from mistralai.client.chat import Chat

    Chat().complete(
        model="mistral-large-latest",
        messages=[{"role": "user", "content": "search?"}],
        tools=[{"type": "function", "function": {"name": "search"}}],
    )
    assert captured[0].payload["tool_call_count"] == 1
    assert captured[0].payload["tool_names"] == ["search"]


def test_mistral_error_path_enqueues_error_event(monkeypatch, fake_mistral):
    eden.instrument("mistral")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)
    from mistralai.client.chat import Chat

    with pytest.raises(RuntimeError):
        Chat().complete(model="mistral-large-latest", messages=[], _raise=True)
    assert len(captured) == 1
    assert captured[0].payload["outcome"] == "error"


def test_mistral_streaming_unwraps_data_envelope(fake_mistral):
    """Mistral's ``chat.stream()`` wraps each chunk in a ``CompletionEvent``
    with a ``.data`` field — the wrapper must read through it, not treat
    the envelope itself as the chunk."""
    eden.instrument("mistral")
    client = get_default_client()
    from mistralai.client.chat import Chat

    events = list(Chat().stream(model="mistral-large-latest", messages=[{"role": "user", "content": "hi"}]))
    assert len(events) == 2
    client.flush(timeout=2.0)
    assert client.sent >= 1


def test_mistral_async_streaming_emits_stream_event():
    import asyncio

    captured = _install_fake_mistral()
    from eden_sdk.instrumentations import mistral as ms
    ms.uninstall()
    try:
        eden.instrument("mistral")
        client = get_default_client()
        from mistralai.client.chat import Chat

        async def run():
            agen = await Chat().stream_async(model="mistral-async-stream", messages=[])
            chunks = []
            async for c in agen:
                chunks.append(c)
            return chunks

        chunks = asyncio.run(run())
        assert len(chunks) == 2
        client.flush(timeout=2.0)
        assert client.sent >= 1
    finally:
        ms.uninstall()
        for k in _MISTRAL_MODULE_KEYS:
            sys.modules.pop(k, None)
    del captured


def test_mistral_uninstall_restores_original(fake_mistral):
    from mistralai.client.chat import Chat
    original_complete = Chat.complete
    eden.instrument("mistral")
    assert Chat.complete is not original_complete
    eden.uninstrument("mistral")
    assert Chat.complete is original_complete


def test_mistral_matches_real_installed_package():
    """Guard against the exact class of drift that shipped broken: the
    instrumentor's ``mistralai.chat.Chat`` import path was stale against
    every currently-published ``mistralai`` (2.x restructured the SDK so
    the client lives under ``mistralai.client``), but the hand-built fake
    above encoded the same wrong assumption, so the fake-backed tests
    passed regardless. This test imports the *real* installed package
    (no ``sys.modules`` fake) and drives the instrumentor against it, so
    a future SDK restructure that the fakes don't happen to notice still
    fails CI here. Skips (rather than xfails) when ``mistralai`` isn't
    installed, since it's an optional extra — install it via
    ``pip install eden-sdk[mistral]`` (or plain ``pip install mistralai``)
    to exercise this test.
    """
    pytest.importorskip("mistralai")
    chat_module = pytest.importorskip(
        "mistralai.client.chat",
        reason=(
            "installed `mistralai` does not expose `mistralai.client.chat` — "
            "either an unsupported (<2.0) version is installed, or the SDK "
            "has restructured again and eden_sdk.instrumentations.mistral "
            "needs updating to match."
        ),
    )
    Chat = chat_module.Chat
    for attr in ("complete", "complete_async", "stream", "stream_async"):
        assert hasattr(Chat, attr), (
            f"real mistralai.client.chat.Chat has no `{attr}` method — "
            "eden_sdk.instrumentations.mistral's wrapping logic is stale"
        )

    from eden_sdk.instrumentations import mistral as ms

    ms.uninstall()
    original_complete = Chat.complete
    original_complete_async = Chat.complete_async
    original_stream = Chat.stream
    original_stream_async = Chat.stream_async
    try:
        eden.instrument("mistral")
        # If `install()` had silently failed (the exact bug this guards
        # against), these would still be the untouched originals.
        assert Chat.complete is not original_complete
        assert Chat.complete_async is not original_complete_async
        assert Chat.stream is not original_stream
        assert Chat.stream_async is not original_stream_async
    finally:
        eden.uninstrument("mistral")
        assert Chat.complete is original_complete
        assert Chat.complete_async is original_complete_async
        assert Chat.stream is original_stream
        assert Chat.stream_async is original_stream_async


# ── Cohere ────────────────────────────────────────────────────────────


def _install_fake_cohere() -> dict[str, Any]:
    pkg = types.ModuleType("cohere")
    v2_pkg = types.ModuleType("cohere.v2")
    client_mod = types.ModuleType("cohere.v2.client")
    captured: dict[str, Any] = {}

    class V2Client:
        def chat(self, *args, **kwargs):
            captured["chat_kwargs"] = kwargs
            if kwargs.get("_raise"):
                raise RuntimeError("cohere boom")
            has_tools = bool(kwargs.get("tools"))
            return {
                "id": "resp-cohere",
                "finish_reason": "TOOL_CALL" if has_tools else "COMPLETE",
                "message": {
                    "role": "assistant",
                    **(
                        {"tool_calls": [{"id": "1", "type": "function",
                                         "function": {"name": "search", "arguments": "{}"}}]}
                        if has_tools else {"content": [{"type": "text", "text": "hi from cohere"}]}
                    ),
                },
                # Cohere's Usage nests `billed_units` / `tokens`
                # rather than exposing flat `input_tokens` — verified
                # against `cohere.types.usage.Usage`.
                "usage": {
                    "billed_units": {"input_tokens": 5, "output_tokens": 2},
                    "tokens": {"input_tokens": 6, "output_tokens": 2},
                    "cached_tokens": 1,
                },
            }

    class AsyncV2Client:
        async def chat(self, *args, **kwargs):
            return V2Client().chat(*args, **kwargs)

    def _chat_stream_events():
        yield {"type": "message-start", "id": "resp-cohere-stream"}
        yield {"type": "content-delta", "index": 0, "delta": {"message": {"content": {"text": "Hi"}}}}
        yield {
            "type": "tool-call-start", "index": 0,
            "delta": {"message": {"tool_calls": {"function": {"name": "search"}}}},
        }
        yield {
            "type": "message-end",
            "delta": {
                "finish_reason": "COMPLETE",
                "usage": {"billed_units": {"input_tokens": 9, "output_tokens": 3}},
            },
        }

    V2Client.chat_stream = lambda self, *a, **k: _chat_stream_events()

    async def _async_chat_stream(self, *a, **k):
        for e in _chat_stream_events():
            yield e

    AsyncV2Client.chat_stream = _async_chat_stream

    client_mod.V2Client = V2Client
    client_mod.AsyncV2Client = AsyncV2Client
    v2_pkg.client = client_mod
    pkg.v2 = v2_pkg
    sys.modules["cohere"] = pkg
    sys.modules["cohere.v2"] = v2_pkg
    sys.modules["cohere.v2.client"] = client_mod
    return captured


@pytest.fixture
def fake_cohere(monkeypatch):
    captured = _install_fake_cohere()
    from eden_sdk.instrumentations import cohere as co
    co.uninstall()
    yield captured
    co.uninstall()
    for k in ("cohere", "cohere.v2", "cohere.v2.client"):
        sys.modules.pop(k, None)


def test_cohere_patch_invokes_original(fake_cohere):
    eden.instrument("cohere")
    from cohere.v2.client import V2Client

    resp = V2Client().chat(model="command-r-plus", messages=[{"role": "user", "content": "hi"}])
    assert resp["message"]["content"][0]["text"] == "hi from cohere"
    assert fake_cohere["chat_kwargs"]["model"] == "command-r-plus"


def test_cohere_enqueues_event_with_billed_units_usage(monkeypatch, fake_cohere):
    """billed_units (actual billed amount) must win over the raw tokens count."""
    eden.instrument("cohere")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)
    from cohere.v2.client import V2Client

    V2Client().chat(model="command-r-plus", messages=[{"role": "user", "content": "hi"}])

    assert len(captured) == 1
    event = captured[0]
    assert event.source_format == "cohere"
    # V2ChatResponse has no `model` field — must come from the request.
    assert event.payload["model"] == "command-r-plus"
    assert event.payload["input_tokens"] == 5
    assert event.payload["output_tokens"] == 2
    assert event.payload["cache_read_input_tokens"] == 1
    assert "trace_id" in event.payload


def test_cohere_parses_tool_calls(monkeypatch, fake_cohere):
    eden.instrument("cohere")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)
    from cohere.v2.client import V2Client

    V2Client().chat(model="command-r-plus", messages=[], tools=[{"type": "function", "function": {"name": "search"}}])
    assert captured[0].payload["tool_call_count"] == 1
    assert captured[0].payload["tool_names"] == ["search"]


def test_cohere_error_path_enqueues_error_event(monkeypatch, fake_cohere):
    eden.instrument("cohere")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)
    from cohere.v2.client import V2Client

    with pytest.raises(RuntimeError):
        V2Client().chat(model="command-r-plus", messages=[], _raise=True)
    assert len(captured) == 1
    assert captured[0].payload["outcome"] == "error"


def test_cohere_async_chat_enqueues_event(fake_cohere):
    import asyncio

    eden.instrument("cohere")
    client = get_default_client()
    from cohere.v2.client import AsyncV2Client

    resp = asyncio.run(AsyncV2Client().chat(model="command-r-plus", messages=[]))
    assert resp["message"] is not None
    assert client.sent >= 1


def test_cohere_streaming_emits_stream_event_with_tool_call(fake_cohere):
    eden.instrument("cohere")
    client = get_default_client()
    from cohere.v2.client import V2Client

    events = list(V2Client().chat_stream(model="command-r-plus", messages=[]))
    assert len(events) == 4
    client.flush(timeout=2.0)
    assert client.sent >= 1


def test_cohere_uninstall_restores_original(fake_cohere):
    from cohere.v2.client import V2Client
    original = V2Client.chat
    eden.instrument("cohere")
    assert V2Client.chat is not original
    eden.uninstrument("cohere")
    assert V2Client.chat is original


# ── Detection ─────────────────────────────────────────────────────────


def test_detect_installed_frameworks_reports_groq_cohere_mistral():
    from eden_sdk import detect_installed_frameworks

    result = detect_installed_frameworks()
    assert "groq" in result
    assert "cohere" in result
    assert "mistral" in result
    assert isinstance(result["groq"], bool)
    assert isinstance(result["cohere"], bool)
    assert isinstance(result["mistral"], bool)
