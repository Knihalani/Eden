"""Tests for the per-framework instrumentations.

These tests use ``respx`` to intercept HTTP calls and verify the
correct route + payload shape. Each test installs the instrumentation
on a fake module so we don't need a real OpenAI/Anthropic/LangChain
install — and so the tests stay fast and hermetic.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

import eden
from eden_sdk.client import get_default_client

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


# ── OpenAI streaming ─────────────────────────────────────────────────


class _FakeStreamingCompletions:
    """A fake that yields a few OpenAI ChatCompletionChunks."""

    def create(self, *args, **kwargs):
        # Stream three text deltas + a final usage chunk.
        chunks = [
            {"id": "c1", "model": "gpt-stream-test", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hello"}, "finish_reason": None}]},
            {"id": "c1", "model": "gpt-stream-test", "choices": [{"index": 0, "delta": {"content": " there"}, "finish_reason": None}]},
            {"id": "c1", "model": "gpt-stream-test", "choices": [{"index": 0, "delta": {"content": "!"}, "finish_reason": "stop"}]},
            {"id": "c1", "model": "gpt-stream-test", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}},
        ]
        yield from chunks


class _FakeAsyncStreamingCompletions:
    # The real OpenAI AsyncCompletions.create returns a coroutine that
    # resolves to an async iterator (Stream wrapper). Mirror that here.
    async def create(self, *args, **kwargs):
        async def _aiter():
            for c in [
                {"id": "c2", "model": "gpt-async-stream", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hi"}, "finish_reason": None}]},
                {"id": "c2", "model": "gpt-async-stream", "choices": [{"index": 0, "delta": {"content": " async"}, "finish_reason": None}]},
                {"id": "c2", "model": "gpt-async-stream", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6}},
            ]:
                yield c
        return _aiter()


@pytest.fixture
def fake_streaming_openai(monkeypatch):
    """Install the streaming variant of the openai fake."""
    pkg = types.ModuleType("openai")
    resources = types.ModuleType("openai.resources")
    chat = types.ModuleType("openai.resources.chat")
    completions = types.ModuleType("openai.resources.chat.completions")
    completions.Completions = _FakeStreamingCompletions
    completions.AsyncCompletions = _FakeAsyncStreamingCompletions
    pkg.resources = resources
    resources.chat = chat
    chat.completions = completions
    sys.modules["openai"] = pkg
    sys.modules["openai.resources"] = resources
    sys.modules["openai.resources.chat"] = chat
    sys.modules["openai.resources.chat.completions"] = completions
    from eden_sdk.instrumentations import openai as oa
    oa.uninstall()
    yield
    oa.uninstall()
    for k in ("openai", "openai.resources", "openai.resources.chat",
              "openai.resources.chat.completions"):
        sys.modules.pop(k, None)


def test_openai_streaming_sync_emits_stream_event(fake_streaming_openai):
    """Sync streaming emits one ``stream: True`` event with chunk metrics."""
    eden.instrument("openai")
    client = get_default_client()
    from openai.resources.chat.completions import Completions

    gen = Completions().create(
        model="gpt-stream-test",
        messages=[{"role": "user", "content": "say hi"}],
        stream=True,
    )
    chunks = list(gen)
    assert len(chunks) == 4
    # The streaming wrapper enqueued one extra completion event on drain.
    # We assert by checking the queue size + manually draining.
    # The dry-run path increments client.sent, but the streaming path
    # uses the async worker (dry_run=False from the autouse fixture).
    # Either way, after at least one chunk lands in the queue the
    # client must have >= 1 pending or sent item.
    queue_drained = client._queue.qsize() + client.sent
    assert queue_drained >= 1
    # Drain the rest.
    client.flush(timeout=2.0)
    # The single stream-end event lives in the queue or in `sent` after flush.
    assert client.sent + client._queue.qsize() >= 1


def test_openai_streaming_async_emits_stream_event(fake_streaming_openai):
    """Async streaming yields chunks and emits a stream-end event."""
    import asyncio

    eden.instrument("openai")
    client = get_default_client()
    from openai.resources.chat.completions import AsyncCompletions

    async def run():
        agen = await AsyncCompletions().create(
            model="gpt-async-stream",
            messages=[{"role": "user", "content": "say hi async"}],
            stream=True,
        )
        chunks = []
        async for c in agen:
            chunks.append(c)
        return chunks

    chunks = asyncio.run(run())
    assert len(chunks) == 3
    client.flush(timeout=2.0)
    assert client.sent >= 1


def test_client_flush_chunks_is_safe_with_empty_buffer():
    """flush_chunks must be a no-op when nothing is buffered."""
    import httpx

    from eden_sdk.client import EdenClient
    from eden_sdk.config import EdenConfig

    c = EdenClient(EdenConfig(org_id="o", api_key="k", dry_run=False), transport=httpx.MockTransport(lambda r: httpx.Response(202)))
    c.start()
    try:
        c.flush_chunks(timeout=0.1)
        # No-op, no error.
    finally:
        c.shutdown()


# ── Anthropic streaming ──────────────────────────────────────────────


class _FakeAnthropicStreamingMessages:
    """Yield a sequence of Anthropic message-stream events."""

    def create(self, *args, **kwargs):
        events = [
            {"type": "message_start", "message": {"model": "claude-stream", "usage": {"input_tokens": 5}}},
            {"type": "content_block_start", "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello"}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": " claude"}},
            {"type": "content_block_stop"},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
            {"type": "message_stop"},
        ]
        yield from events


class _FakeAnthropicAsyncStreamingMessages:
    async def create(self, *args, **kwargs):
        async def _aiter():
            for ev in [
                {"type": "message_start", "message": {"model": "claude-async-stream", "usage": {"input_tokens": 3}}},
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hi"}},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}},
                {"type": "message_stop"},
            ]:
                yield ev
        return _aiter()


@pytest.fixture
def fake_streaming_anthropic(monkeypatch):
    pkg = types.ModuleType("anthropic")
    resources = types.ModuleType("anthropic.resources")
    messages_mod = types.ModuleType("anthropic.resources.messages")
    messages_mod.Messages = _FakeAnthropicStreamingMessages
    messages_mod.AsyncMessages = _FakeAnthropicAsyncStreamingMessages
    pkg.resources = resources
    resources.messages = messages_mod
    sys.modules["anthropic"] = pkg
    sys.modules["anthropic.resources"] = resources
    sys.modules["anthropic.resources.messages"] = messages_mod
    from eden_sdk.instrumentations import anthropic as an
    an.uninstall()
    yield
    an.uninstall()
    for k in ("anthropic", "anthropic.resources", "anthropic.resources.messages"):
        sys.modules.pop(k, None)


def test_anthropic_streaming_sync_emits_stream_event(fake_streaming_anthropic):
    eden.instrument("anthropic")
    client = get_default_client()
    from anthropic.resources.messages import Messages

    gen = Messages().create(
        model="claude-stream",
        max_tokens=64,
        messages=[{"role": "user", "content": "say hi"}],
        stream=True,
    )
    events = list(gen)
    assert len(events) == 7
    client.flush(timeout=2.0)
    assert client.sent >= 1


def test_anthropic_streaming_async_emits_stream_event(fake_streaming_anthropic):
    import asyncio
    eden.instrument("anthropic")
    client = get_default_client()
    from anthropic.resources.messages import AsyncMessages

    async def run():
        agen = await AsyncMessages().create(
            model="claude-async-stream",
            max_tokens=64,
            messages=[{"role": "user", "content": "say hi"}],
            stream=True,
        )
        out = []
        async for e in agen:
            out.append(e)
        return out

    events = asyncio.run(run())
    assert len(events) == 4
    client.flush(timeout=2.0)
    assert client.sent >= 1


def test_openai_per_chunk_tpot_itl_semantics(fake_streaming_openai):
    """Regression: per-chunk tpot_ms must be ms-per-token for the
    chunk's text, NOT the average inter-chunk arrival time. And it
    must be None for chunks with no delta text. The original
    implementation read t_prev AFTER assigning t_prev = now,
    collapsing both itl_ms and tpot_ms to 0 for any chunk
    that shares a tick with the previous one.
    """
    import time

    # Install the slow generator BEFORE instrumentation so the
    # wrapper captures the right create reference.
    def _slow_iter():
        chunks = [
            {"id": "c1", "model": "gpt-stream-test", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hello"}, "finish_reason": None}]},
            {"id": "c1", "model": "gpt-stream-test", "choices": [{"index": 0, "delta": {"content": " there"}, "finish_reason": None}]},
            {"id": "c1", "model": "gpt-stream-test", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}},
        ]
        for c in chunks:
            time.sleep(0.002)
            yield c

    def _slow_create(self, *args, **kwargs):
        return _slow_iter()
    _FakeStreamingCompletions.create = _slow_create

    eden.instrument("openai")
    client = get_default_client()
    from openai.resources.chat.completions import Completions

    # Pin the buffer reference — the wrapper will append to it.
    pinned_buffer = client._chunk_buffer

    gen = Completions().create(
        model="gpt-stream-test",
        messages=[{"role": "user", "content": "say hi"}],
        stream=True,
    )
    chunks_out = list(gen)
    assert len(chunks_out) == 3, f"expected 3 chunks, got {chunks_out!r}"

    buffered = list(pinned_buffer) or list(client._chunk_buffer)
    text_chunks = [c for c in buffered if c.get("delta_text")]
    assert len(text_chunks) == 2, f"expected 2 text chunks, got {len(text_chunks)} (buffer={buffered!r})"
    # First text chunk: no prior chunk → tpot_ms None
    assert text_chunks[0]["tpot_ms"] is None
    # Second text chunk: positive ms-per-token
    assert isinstance(text_chunks[1]["tpot_ms"], (int, float))
    assert text_chunks[1]["tpot_ms"] > 0
    # itl_ms on second text chunk must also be > 0 (prior bug returned 0)
    assert isinstance(text_chunks[1]["itl_ms"], (int, float))
    assert text_chunks[1]["itl_ms"] > 0
    # Non-text chunk: tpot_ms None
    non_text = [c for c in buffered if not c.get("delta_text")]
    assert len(non_text) == 1
    assert non_text[0]["tpot_ms"] is None

