"""RequestCoalescer unit tests (Part 4.6).

Covers the dedup window, in-flight entry expiry, key stability,
failure propagation to waiters, sequential non-coalescing, and the
stats surface — behaviors that had zero test coverage before Wave 4.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from eden.llm.client import LLMResponse, UsageStats
from eden.optimization.coalescer import RequestCoalescer, _InflightRequest


def _response(text: str = "hi") -> LLMResponse:
    return LLMResponse(
        content=text,
        usage=UsageStats(prompt_tokens=3, completion_tokens=1, total_tokens=4),
        model="gpt-4o-mini",
        finish_reason="stop",
    )


async def test_concurrent_identical_requests_make_one_call() -> None:
    """Two identical in-flight requests coalesce to a single upstream call."""
    coalescer = RequestCoalescer(window_ms=1000.0)
    calls = 0

    async def call_fn() -> LLMResponse:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return _response("same")

    results = await asyncio.gather(
        coalescer.execute("hello world", "gpt-4o-mini", call_fn=call_fn),
        coalescer.execute("hello world", "gpt-4o-mini", call_fn=call_fn),
    )
    assert calls == 1
    assert [r.content for r in results] == ["same", "same"]
    stats = coalescer.get_stats()
    assert stats["coalesced_requests"] == 1
    assert stats["active_inflight"] == 0


async def test_expired_inflight_entry_is_cleaned_and_not_coalesced() -> None:
    """An entry older than the window is dropped, never waited on."""
    coalescer = RequestCoalescer(window_ms=50.0)
    stale_future = asyncio.get_running_loop().create_future()
    coalescer._inflight["stale"] = _InflightRequest(
        future=stale_future,
        created_at=time.time() - 10.0,
        key="stale",
    )
    calls = 0

    async def call_fn() -> LLMResponse:
        nonlocal calls
        calls += 1
        return _response()

    result = await coalescer.execute("fresh", "gpt-4o-mini", call_fn=call_fn)
    assert calls == 1
    assert stale_future.cancelled()
    assert "stale" not in coalescer._inflight
    assert result.content == "hi"
    assert coalescer.get_stats()["coalesced_requests"] == 0


async def test_unexpired_inflight_entry_blocks_window() -> None:
    """A still-fresh in-flight entry is coalesced even if identical."""
    coalescer = RequestCoalescer(window_ms=1000.0)
    key = coalescer._make_key("key-a", "gpt-4o-mini", 0.7, 4096)
    pending_future = asyncio.get_running_loop().create_future()
    coalescer._inflight[key] = _InflightRequest(
        future=pending_future,
        created_at=time.time(),
        key=key,
    )
    calls = 0

    async def call_fn() -> LLMResponse:
        nonlocal calls
        calls += 1
        return _response()

    task = asyncio.create_task(coalescer.execute("key-a", "gpt-4o-mini", call_fn=call_fn))
    await asyncio.sleep(0.01)
    pending_future.set_result(_response("waiter"))
    result = await task
    assert calls == 0  # never reached upstream — matched the seeded entry
    assert result.content == "waiter"
    assert coalescer.get_stats()["coalesced_requests"] == 1


def test_key_stability_and_sensitivity() -> None:
    """Key normalizes whitespace/case but splits on every other input."""
    coalescer = RequestCoalescer()
    k1 = coalescer._make_key("  Hello   WORLD ", "gpt-4o-mini", 0.7, 4096)
    k2 = coalescer._make_key("hello world", "gpt-4o-mini", 0.7, 4096)
    assert k1 == k2  # whitespace + case normalized

    assert coalescer._make_key("hello world", "gpt-4o", 0.7, 4096) != k1
    assert coalescer._make_key("hello world", "gpt-4o-mini", 0.0, 4096) != k1
    assert coalescer._make_key("hello world", "gpt-4o-mini", 0.7, 128) != k1
    assert (
        coalescer._make_key(
            "hello world", "gpt-4o-mini", 0.7, 4096, system_prompt="be terse"
        )
        != k1
    )
    # Same system prompt text → same key (hashed deterministically).
    assert coalescer._make_key(
        "hello world", "gpt-4o-mini", 0.7, 4096, system_prompt="be terse"
    ) == coalescer._make_key(
        "hello world", "gpt-4o-mini", 0.7, 4096, system_prompt="be terse"
    )


async def test_leader_failure_propagates_to_waiters() -> None:
    """A failing upstream call surfaces in every coalesced waiter."""
    coalescer = RequestCoalescer(window_ms=1000.0)
    calls = 0

    async def call_fn() -> LLMResponse:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)  # yield so the waiter interleaves
        raise RuntimeError("upstream boom")

    with pytest.raises(RuntimeError, match="upstream boom"):
        await asyncio.gather(
            coalescer.execute("boom", "gpt-4o-mini", call_fn=call_fn),
            coalescer.execute("boom", "gpt-4o-mini", call_fn=call_fn),
        )
    assert calls == 1
    assert coalescer.get_stats()["active_inflight"] == 0


async def test_different_key_not_blocked_by_waiter() -> None:
    """A waiter must not hold the coalescer lock while awaiting.

    Regression for a latent bug: the waiter path awaited the in-flight
    future *inside* the lock scope, so an unrelated (different-key)
    request queued behind the slow in-flight call. The comment claimed
    the lock was released first — it never was.
    """
    coalescer = RequestCoalescer(window_ms=1000.0)
    release_a = asyncio.Event()
    c_completed = asyncio.Event()

    async def gated_call() -> LLMResponse:
        await release_a.wait()  # A's upstream call blocks until released
        return _response("a")

    async def fast_call() -> LLMResponse:
        c_completed.set()
        return _response("c")

    a_task = asyncio.create_task(
        coalescer.execute("key-a", "gpt-4o-mini", call_fn=gated_call)
    )
    await asyncio.sleep(0)  # A is leader, parked inside call_fn
    b_task = asyncio.create_task(
        coalescer.execute("key-a", "gpt-4o-mini", call_fn=gated_call)
    )
    await asyncio.sleep(0)  # B coalesced onto A and awaits its future
    c_task = asyncio.create_task(
        coalescer.execute("key-c", "gpt-4o-mini", call_fn=fast_call)
    )
    await asyncio.sleep(0)  # C must be able to run its own call immediately

    assert c_completed.is_set(), (
        "different-key request was blocked behind a coalescing waiter"
    )
    release_a.set()
    await asyncio.gather(a_task, b_task, c_task)
    assert coalescer.get_stats()["coalesced_requests"] == 1


async def test_sequential_same_key_is_not_coalesced() -> None:
    """A completed request is not deduped against the next one."""
    coalescer = RequestCoalescer(window_ms=1000.0)
    calls = 0

    async def call_fn() -> LLMResponse:
        nonlocal calls
        calls += 1
        return _response()

    await coalescer.execute("seq", "gpt-4o-mini", call_fn=call_fn)
    await coalescer.execute("seq", "gpt-4o-mini", call_fn=call_fn)
    assert calls == 2
    assert coalescer.get_stats()["coalesced_requests"] == 0


async def test_call_fn_required_for_leader() -> None:
    coalescer = RequestCoalescer()
    with pytest.raises(ValueError, match="call_fn is required"):
        await coalescer.execute("no fn", "gpt-4o-mini")


async def test_get_stats_shape() -> None:
    coalescer = RequestCoalescer(window_ms=123.0)
    assert coalescer.get_stats() == {
        "coalesced_requests": 0,
        "window_ms": 123.0,
        "active_inflight": 0,
    }
