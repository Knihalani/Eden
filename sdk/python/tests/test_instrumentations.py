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



# ── LangChain streaming (on_llm_new_token) ──────────────────────────


def test_langchain_streaming_emits_per_chunk_events(fake_langchain):
    """``on_llm_new_token`` should push a per-token dict to
    ``client._chunk_buffer`` so the per-chunk TTFT / ITL /
    TPOT dashboards render for LangChain streams (parity with
    the OpenAI + Anthropic streaming instrumentations).

    The previous implementation never implemented
    ``on_llm_new_token`` at all — streaming LangChain calls
    emitted only the aggregate framework event with no model
    or input_tokens on the wire. Pricing lookups could not
    roll them up.
    """
    from langchain_core.callbacks import BaseCallbackHandler
    import langchain_core.callbacks as _callbacks

    eden.instrument("langchain")
    mgr = _callbacks.get_callback_manager()
    handler = next(h for h in mgr.handlers if isinstance(h, BaseCallbackHandler))

    client = get_default_client()
    # The streaming instrumentation pushes directly to the
    # client buffer; snapshot it for assertion.
    pinned_buffer = client._chunk_buffer

    run_id = "lc-stream-1"
    parent_id = None
    handler.on_llm_start(
        serialized={"name": "openai-llm"},
        prompts=["Tell me about Eden."],
        run_id=run_id,
        parent_run_id=parent_id,
        tags=[],
        metadata={},
    )
    # Three tokens. The first one is the TTFT sample; the
    # second + third produce a real ITL/TPOT reading.
    handler.on_llm_new_token(token="Eden", run_id=run_id)
    handler.on_llm_new_token(token=" is", run_id=run_id)
    handler.on_llm_new_token(token=" great", run_id=run_id)
    # End the run with an LLMResult carrying usage + model
    # metadata (modern LangChain shape).
    handler.on_llm_end(
        response=types.SimpleNamespace(
            llm_output={"token_usage": {"prompt_tokens": 8, "completion_tokens": 3}},
            response_metadata={"model_name": "gpt-4o-mini"},
            generations=[[types.SimpleNamespace(text="Eden is great")]],
        ),
        run_id=run_id,
        parent_run_id=parent_id,
    )

    # 3 tokens → 3 chunk-buffer pushes.
    assert len(pinned_buffer) == 3, f"expected 3 chunk pushes, got {len(pinned_buffer)}"
    # All three carry the same trace_id + a sequential
    # ``chunk_index`` from 0.
    trace_ids = {c["trace_id"] for c in pinned_buffer}
    assert len(trace_ids) == 1, f"chunks should share a trace_id, got {trace_ids!r}"
    assert [c["chunk_index"] for c in pinned_buffer] == [0, 1, 2]
    # delta_text preserved verbatim on every chunk.
    assert [c["delta_text"] for c in pinned_buffer] == ["Eden", " is", " great"]
    # First chunk has TTFT but no ITL/TPOT (no prior chunk).
    assert pinned_buffer[0]["ttft_ms"] is not None
    assert pinned_buffer[0]["ttft_ms"] >= 0
    assert pinned_buffer[0]["itl_ms"] is None
    assert pinned_buffer[0]["tpot_ms"] is None
    # Second + third chunks have non-null ITL + TPOT.
    for c in pinned_buffer[1:]:
        assert c["itl_ms"] is not None
        assert c["itl_ms"] >= 0
        # ``tpot_ms`` is per-chunk (time for THIS chunk's
        # tokens / THIS chunk's token count). It must be a
        # finite non-negative number.
        assert c["tpot_ms"] is not None
        assert c["tpot_ms"] >= 0

    # Aggregate event: the per-run streaming state is
    # popped in ``on_llm_end`` and its fields are surfaced
    # on the framework event payload (``model`` +
    # ``input_tokens``). We don't ship the event (the test
    # transport would have to be a MockTransport, and this
    # test focuses on the buffer + state hoisting). Instead
    # we directly assert that ``on_llm_end`` left the
    # streaming state behind the right fields by checking
    # the public enqueue path: the ``_record_end`` helper
    # runs at the end of ``on_llm_end`` and emits a
    # framework event with ``kind="llm.end"`` to the
    # client queue. We can verify the enqueue happened
    # via the queue size and the on-wire fields by
    # inspecting the payload dict we just produced.
    # Easier and more targeted: the per-run state has been
    # popped by ``on_llm_end`` (asserted below) AND the
    # aggregate framework event was enqueued — we use the
    # ``_record_end``-emitted ``event_id`` to confirm the
    # end path ran. The most targeted thing to assert is
    # that the streaming state is gone and the aggregate
    # fields were built correctly, so we look at the
    # event that ``_record_end`` would have built.
    # (The buffer + state cleanup is the real bug pin;
    # the aggregate-on-the-wire assertion belongs in a
    # separate end-to-end test with a mock transport.)
    assert run_id not in handler._stream_state


def test_langchain_streaming_aggregate_event_carries_model_and_usage(fake_langchain, monkeypatch):
    """The aggregate ``llm.end`` framework event must carry the
    model name + input_tokens that ``on_llm_new_token``
    captured. Previously the framework event had no model or
    input_tokens on the wire even when the streaming callback
    had them — pricing lookups could not roll up LangChain
    streams.

    Uses a ``MockTransport`` so we can assert on the actual
    JSON the sender thread ships.
    """
    import json
    from langchain_core.callbacks import BaseCallbackHandler
    import httpx

    # Install a mock transport on the default client so we
    # can capture the wire body the SDK actually ships.
    from eden_sdk.client import EdenClient, TraceEvent
    from eden_sdk.config import EdenConfig

    captured: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode("utf-8")
        try:
            captured.append(json.loads(body))
        except Exception:
            captured.append({"raw": body})
        return httpx.Response(202, json={"ok": True}, request=request)

    transport = httpx.MockTransport(handler)
    real_client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    real_client.start()
    monkeypatch.setattr(
        "eden_sdk.instrumentations.langchain.get_default_client",
        lambda: real_client,
    )

    eden.instrument("langchain")
    from langchain_core.callbacks import get_callback_manager
    mgr = get_callback_manager()
    handler_obj = next(h for h in mgr.handlers if isinstance(h, BaseCallbackHandler))

    run_id = "lc-stream-agg"
    handler_obj.on_llm_start(
        serialized={"name": "openai-llm"},
        prompts=["hi"],
        run_id=run_id,
        parent_run_id=None,
        tags=[],
        metadata={},
    )
    handler_obj.on_llm_new_token(token="Eden", run_id=run_id)
    # Modern LangChain supplies the per-chunk AIMessageChunk
    # on the ``chunk`` kwarg. Simulate one with usage +
    # response_metadata so the callback extracts them.
    handler_obj.on_llm_new_token(
        token=" is",
        run_id=run_id,
        chunk={
            "usage_metadata": {"input_tokens": 7, "output_tokens": 2},
            "response_metadata": {"model_name": "gpt-4o-mini"},
        },
    )
    handler_obj.on_llm_end(
        response=types.SimpleNamespace(
            llm_output={"token_usage": {"prompt_tokens": 7, "completion_tokens": 2}},
            response_metadata={"model_name": "gpt-4o-mini"},
            generations=[[types.SimpleNamespace(text="Eden is")]],
        ),
        run_id=run_id,
        parent_run_id=None,
    )
    real_client.flush(timeout=2.0)
    real_client.shutdown(timeout=2.0)

    # Find the framework event in the captured batches.
    framework_events: list[dict] = []
    for body in captured:
        for ev in body if isinstance(body, list) else [body]:
            if isinstance(ev, dict) and ev.get("event_type") == "framework.callback":
                framework_events.append(ev)
    assert framework_events, f"no framework events captured: {captured!r}"
    # At least one of the captured framework events is the
    # ``llm.end`` (kind="llm.end") with model + input_tokens
    # hoisted from the streaming state.
    llm_end = next(
        (e for e in framework_events
         if e.get("attributes", {}).get("langchain.kind") == "llm.end"),
        None,
    )
    assert llm_end is not None
    assert llm_end.get("model") == "gpt-4o-mini", (
        f"model not hoisted on llm.end; got {llm_end!r}"
    )
    assert llm_end.get("input_tokens") == 7, (
        f"input_tokens not hoisted on llm.end; got {llm_end!r}"
    )
    assert llm_end.get("output_tokens") == 2


def test_langchain_streaming_state_cleaned_on_error(fake_langchain):
    """``on_llm_error`` must drop the per-run streaming state
    so a stream that errors mid-flight does not leak the
    ``_stream_state`` dict forever. The chunks already
    pushed still ship — the test only pins the cleanup.
    """
    from langchain_core.callbacks import BaseCallbackHandler

    eden.instrument("langchain")
    from langchain_core.callbacks import get_callback_manager
    mgr = get_callback_manager()
    handler = next(h for h in mgr.handlers if isinstance(h, BaseCallbackHandler))

    run_id = "lc-stream-err"
    handler.on_llm_start(
        serialized={"name": "openai-llm"},
        prompts=["hi"],
        run_id=run_id,
        parent_run_id=None,
        tags=[],
        metadata={},
    )
    assert run_id in handler._stream_state
    handler.on_llm_new_token(token="half", run_id=run_id)
    assert handler._stream_state[run_id]["chunk_count"] == 1
    handler.on_llm_error(
        error=RuntimeError("upstream timeout"),
        run_id=run_id,
        parent_run_id=None,
    )
    # State for the run must be gone (no leak).
    assert run_id not in handler._stream_state


