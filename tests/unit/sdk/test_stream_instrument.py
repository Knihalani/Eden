"""Unit tests for the streaming-aware auto-instrumentation wrappers.

The wrappers are pure async generators that take an upstream async
iterator and yield its chunks unchanged while sampling timing. We
exercise them with synthetic chunk sequences to verify the metric
math (TTFT, ITL avg, TPOT, completion duration) without depending
on the real OpenAI / Anthropic SDKs.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


async def _drain_pending() -> None:
    """Yield to the event loop until the wrapper's fire-and-forget
    ingest task has a chance to run. The wrappers use
    ``asyncio.create_task(collector.ingest(event))`` so the test must
    let the loop process the task before asserting on captured events.
    """
    for _ in range(5):
        await asyncio.sleep(0)


class _FakeCollector:
    """A minimal stand-in for ``TelemetryCollector`` whose ``ingest``
    attribute is a real coroutine function (not an ``AsyncMock``
    attribute, which gets intercepted by the mock's descriptor
    protocol and never properly awaits).
    """

    def __init__(self, ingest_fn):
        self.ingest = ingest_fn


def _patched_collector(ingest_fn):
    """Return a ``patch`` that swaps ``get_telemetry_collector`` for
    an async stub returning a ``_FakeCollector`` wrapping ``ingest_fn``.
    """
    captured = ingest_fn  # closure capture

    async def _fake_get():
        return _FakeCollector(captured)

    return patch(
        "eden.observability.telemetry_collector.get_telemetry_collector",
        new=_fake_get,
    )


# ── Helpers ───────────────────────────────────────────────────────────


async def _aiter(seq):
    for item in seq:
        yield item


class _FakeOpenAIChunk:
    def __init__(self, text: str | None = None, finish_reason: str | None = None,
                 completion_tokens: int | None = None):
        self.choices = []
        if text is not None or finish_reason is not None:
            choice = MagicMock()
            choice.delta = MagicMock()
            choice.delta.content = text
            choice.finish_reason = finish_reason
            self.choices.append(choice)
        if completion_tokens is not None:
            self.usage = MagicMock()
            self.usage.completion_tokens = completion_tokens


class _FakeAnthropicEvent:
    def __init__(self, etype: str, text: str | None = None,
                 stop_reason: str | None = None,
                 input_tokens: int | None = None,
                 output_tokens: int | None = None):
        self.type = etype
        if etype == "content_block_delta":
            self.delta = MagicMock()
            self.delta.type = "text_delta"
            self.delta.text = text
        elif etype == "message_start":
            self.message = MagicMock()
            self.message.usage = MagicMock()
            self.message.usage.input_tokens = input_tokens
        elif etype == "message_delta":
            self.delta = MagicMock()
            self.delta.stop_reason = stop_reason
            self.usage = MagicMock()
            if output_tokens is not None:
                self.usage.output_tokens = output_tokens


# Import the wrapper functions under test. We import from the
# internal helpers (no SDK installation required).
from eden.sdk.trace import (
    _extract_text_from_anthropic_event,
    _extract_text_from_openai_chunk,
    _itl_avg_ms,
    _streaming_summary,
    _tpot_ms,
    _wrap_anthropic_stream,
    _wrap_openai_stream,
)

# ── _extract_text_from_openai_chunk ──────────────────────────────────


def test_extract_text_with_text_delta():
    chunk = _FakeOpenAIChunk(text="hello")
    text, finish = _extract_text_from_openai_chunk(chunk)
    assert text == "hello"
    assert finish is None


def test_extract_text_with_finish_reason():
    chunk = _FakeOpenAIChunk(finish_reason="stop")
    text, finish = _extract_text_from_openai_chunk(chunk)
    assert text is None
    assert finish == "stop"


def test_extract_text_with_no_choices():
    chunk = _FakeOpenAIChunk()
    text, finish = _extract_text_from_openai_chunk(chunk)
    assert text is None
    assert finish is None


# ── _extract_text_from_anthropic_event ──────────────────────────────


def test_extract_anthropic_text_delta():
    ev = _FakeAnthropicEvent("content_block_delta", text="world")
    text, finish = _extract_text_from_anthropic_event(ev)
    assert text == "world"
    assert finish is None


def test_extract_anthropic_message_delta():
    ev = _FakeAnthropicEvent("message_delta", stop_reason="end_turn")
    text, finish = _extract_text_from_anthropic_event(ev)
    assert text is None
    assert finish == "end_turn"


def test_extract_anthropic_other_event():
    ev = _FakeAnthropicEvent("message_stop")
    text, finish = _extract_text_from_anthropic_event(ev)
    assert text is None
    assert finish is None


# ── Metric math ──────────────────────────────────────────────────────


def test_tpot_basic():
    # 1000ms total, 200ms TTFT, 10 output tokens → (1000-200)/9 = 88.88
    assert _tpot_ms(1000.0, 200.0, 10) == pytest.approx(88.888, abs=0.01)


def test_tpot_zero_tokens():
    assert _tpot_ms(1000.0, 200.0, 0) == 0.0


def test_tpot_one_token():
    assert _tpot_ms(1000.0, 200.0, 1) == 0.0


def test_itl_avg_basic():
    assert _itl_avg_ms(150.0, 5) == 30.0


def test_itl_avg_empty():
    assert _itl_avg_ms(0.0, 0) == 0.0


def test_streaming_summary_no_chunks():
    # Degenerate case: iterator yields nothing.
    t0 = 100.0
    t_last = 100.5
    s = _streaming_summary(
        t0=t0, t_first=None, t_last=t_last,
        itl_sum_ms=0.0, itl_count=0,
        output_tokens=0,
    )
    assert s["ttft_ms"] == 0.0
    assert s["itl_ms_avg"] == 0.0
    assert s["tpot_ms"] == 0.0
    assert s["completion_duration_ms"] == pytest.approx(500.0)
    assert s["output_tokens"] == 0.0


def test_streaming_summary_three_chunks():
    # t0=0, first chunk at 100ms, prev at 200ms, last at 500ms.
    # itl: 200-100 = 100ms (1 sample). output_tokens = 12.
    s = _streaming_summary(
        t0=0.0, t_first=0.100, t_last=0.500,
        itl_sum_ms=100.0, itl_count=1,
        output_tokens=12,
    )
    assert s["ttft_ms"] == pytest.approx(100.0)
    assert s["itl_ms_avg"] == pytest.approx(100.0)
    assert s["tpot_ms"] == pytest.approx((500 - 100) / 11.0, abs=0.01)
    assert s["completion_duration_ms"] == pytest.approx(500.0)


# ── _wrap_openai_stream ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wrap_openai_stream_emits_telemetry():
    """Wrap a 3-chunk stream. Verify chunks pass through + telemetry fires."""
    captured_events: list[Any] = []

    async def _fake_ingest(event):
        captured_events.append(event)
        return True

    with _patched_collector(_fake_ingest):
        chunks = [
            _FakeOpenAIChunk(text="Hel"),
            _FakeOpenAIChunk(text="lo "),
            _FakeOpenAIChunk(text="world", finish_reason="stop"),
        ]
        yielded: list[Any] = []
        async for c in _wrap_openai_stream(
            _aiter(chunks),
            model="gpt-4o",
            environment_id="env-1",
            tags=["production"],
            provider="openai",
        ):
            yielded.append(c)
            await asyncio.sleep(0)  # yield to loop
        await _drain_pending()

    assert len(yielded) == 3
    assert len(captured_events) == 1
    ev = captured_events[0]
    assert ev.event_type == "llm_completion_stream"
    assert ev.source_format == "eden-auto-instrument"
    assert "streaming" in ev.tags
    assert ev.metrics["completion_duration_ms"] > 0
    # Output tokens is rough-counted from text deltas.
    assert ev.metrics["output_tokens"] >= 3
    assert ev.payload["chunk_count"] == 3
    assert ev.payload["finish_reason"] == "stop"


@pytest.mark.asyncio
async def test_wrap_openai_stream_uses_usage_count():
    """If a chunk carries ``usage.completion_tokens``, that wins over
    the rough text-based count."""
    captured: list[Any] = []

    async def _ingest(event):
        captured.append(event)
        return True

    with _patched_collector(_ingest):
        chunks = [
            _FakeOpenAIChunk(text="abc"),
            _FakeOpenAIChunk(text="defg"),
            _FakeOpenAIChunk(completion_tokens=42),
        ]
        async for _ in _wrap_openai_stream(
            _aiter(chunks), model="gpt-4o",
            environment_id=None, tags=None, provider="openai",
        ):
            pass
        await _drain_pending()

    assert captured[0].metrics["output_tokens"] == 42


@pytest.mark.asyncio
async def test_wrap_openai_stream_handles_zero_chunks():
    """An empty stream still emits a telemetry event (degenerate case)."""
    captured: list[Any] = []

    async def _ingest(event):
        captured.append(event)
        return True

    with _patched_collector(_ingest):
        async for _ in _wrap_openai_stream(
            _aiter([]), model="gpt-4o",
            environment_id=None, tags=None, provider="openai",
        ):
            pass
        await _drain_pending()

    assert len(captured) == 1
    assert captured[0].metrics["output_tokens"] == 0
    assert captured[0].payload["chunk_count"] == 0


# ── _wrap_anthropic_stream ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_wrap_anthropic_stream_emits_telemetry():
    captured: list[Any] = []

    async def _ingest(event):
        captured.append(event)
        return True

    with _patched_collector(_ingest):
        events = [
            _FakeAnthropicEvent("message_start", input_tokens=10),
            _FakeAnthropicEvent("content_block_start"),
            _FakeAnthropicEvent("content_block_delta", text="Hel"),
            _FakeAnthropicEvent("content_block_delta", text="lo"),
            _FakeAnthropicEvent("content_block_stop"),
            _FakeAnthropicEvent("message_delta", stop_reason="end_turn",
                                output_tokens=5),
            _FakeAnthropicEvent("message_stop"),
        ]
        async for _ in _wrap_anthropic_stream(
            _aiter(events), model="claude-3-5-sonnet-20241022",
            environment_id=None, tags=None, provider="anthropic",
        ):
            pass
        await _drain_pending()

    assert len(captured) == 1
    ev = captured[0]
    assert ev.event_type == "llm_completion_stream"
    assert ev.metrics["output_tokens"] == 5  # from message_delta usage
    assert ev.metrics["input_tokens"] == 10  # from message_start usage
    assert ev.payload["finish_reason"] == "end_turn"
    assert ev.payload["chunk_count"] == 7


@pytest.mark.asyncio
async def test_wrap_anthropic_stream_rough_token_count():
    """Without usage metadata, output tokens is rough-counted from text."""
    captured: list[Any] = []

    async def _ingest(event):
        captured.append(event)
        return True

    with _patched_collector(_ingest):
        events = [
            _FakeAnthropicEvent("content_block_delta", text="a" * 40),
            _FakeAnthropicEvent("content_block_delta", text="b" * 40),
        ]
        async for _ in _wrap_anthropic_stream(
            _aiter(events), model="claude-3-5-sonnet-20241022",
            environment_id=None, tags=None, provider="anthropic",
        ):
            pass
        await _drain_pending()

    # 40 chars / 4 = 10 tokens per chunk, so 20.
    assert captured[0].metrics["output_tokens"] >= 18


# ── Streaming math accuracy under real timing ──────────────────────


@pytest.mark.asyncio
async def test_wrap_openai_stream_measures_real_timing():
    """Verify that the wrapper actually captures real wall-clock timing."""
    captured: list[Any] = []

    async def _ingest(event):
        captured.append(event)
        return True

    with _patched_collector(_ingest):
        async def slow_stream():
            yield _FakeOpenAIChunk(text="first")
            await asyncio.sleep(0.05)  # 50ms
            yield _FakeOpenAIChunk(text="second")
            await asyncio.sleep(0.05)  # 50ms
            yield _FakeOpenAIChunk(text="third", finish_reason="stop")

        async for _ in _wrap_openai_stream(
            slow_stream(), model="gpt-4o",
            environment_id=None, tags=None, provider="openai",
        ):
            pass
        await _drain_pending()

    metrics = captured[0].metrics
    # TTFT is measured from call start to first chunk.
    assert metrics["ttft_ms"] < 50  # first chunk is immediate
    # Total duration is at least the 100ms we slept.
    assert metrics["completion_duration_ms"] >= 90
    # ITL avg: 2 samples, both ~50ms.
    assert 30 <= metrics["itl_ms_avg"] <= 100
