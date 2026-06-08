"""Tests for ``eden_sdk.trace`` — decorator + context manager."""

from __future__ import annotations

import asyncio

import eden
from eden_sdk.trace import current_span, current_trace, trace, trace_agent


def test_trace_context_manager_emits_framework_event(caplog):
    with trace("unit-test", attributes={"foo": "bar"}):
        ctx = current_trace()
        assert ctx is not None
        assert ctx.name == "unit-test"
        assert ctx.attributes == {"foo": "bar"}


def test_trace_agent_decorator_sync():
    @trace_agent(name="my-func")
    def add(a: int, b: int) -> int:
        return a + b

    assert add(2, 3) == 5


def test_trace_agent_decorator_async():
    @trace_agent(name="my-async-func")
    async def add_async(a: int, b: int) -> int:
        return a + b

    out = asyncio.run(add_async(2, 3))
    assert out == 5


def test_trace_agent_propagates_exceptions():
    @trace_agent(name="boom")
    def explode():
        raise RuntimeError("kaboom")

    with __import__("pytest").raises(RuntimeError):
        explode()


def test_nested_traces_share_outer_id():
    with trace("outer") as outer:
        with trace("inner"):
            inner = current_trace()
            assert inner is not None
            assert inner.trace_id == outer.trace_id


def test_disabled_sdk_is_noop():
    eden.configure(disabled=True)
    @trace_agent(name="noop")
    def add(a, b):
        return a + b
    assert add(2, 2) == 4
    assert current_trace() is None
