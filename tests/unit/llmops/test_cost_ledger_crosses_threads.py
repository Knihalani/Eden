"""Spend booked from a worker thread must reach the ledger.

``LLMClient.acall`` and ``ModelRouter.aroute`` run the synchronous
``call()`` in a worker thread, and ``_log_usage`` fires from inside it.
That meant ``schedule_record_from_usage`` was called off-loop on every
async LLM call — the common case, not an edge case — and had two
independent reasons to drop the write:

1. ``contextvars`` do not cross ``loop.run_in_executor``, so
   ``current_cost_context()`` came back empty and the ``if not oid``
   guard returned. Fixed by dispatching with ``asyncio.to_thread``.
2. A worker thread has no running loop, so no task could be created.
   ``to_thread`` does NOT fix this — no worker thread has a loop.
   Fixed by ``bind_event_loop``.

Fixing either alone still drops the write, so both are asserted here,
including a test that each half fails on its own.
"""

from __future__ import annotations

import asyncio
import contextvars

import pytest

from eden.llmops import cost_ledger as cl


@pytest.fixture(autouse=True)
def _clean_binding():
    cl.reset_event_loop_binding()
    yield
    cl.reset_event_loop_binding()


def test_run_in_executor_loses_contextvars_but_to_thread_does_not():
    """The mechanism, pinned directly.

    This is the property the fix depends on. If a future Python changes
    it, the dispatch choice in client.acall stops mattering and this
    test says so.
    """
    probe: contextvars.ContextVar[str] = contextvars.ContextVar(
        "probe", default="MISSING"
    )

    def read() -> str:
        return probe.get()

    async def main() -> tuple[str, str]:
        probe.set("SET")
        loop = asyncio.get_running_loop()
        via_executor = await loop.run_in_executor(None, read)
        via_to_thread = await asyncio.to_thread(read)
        return via_executor, via_to_thread

    via_executor, via_to_thread = asyncio.run(main())
    assert via_executor == "MISSING", "run_in_executor should drop context"
    assert via_to_thread == "SET", "to_thread must carry context"


def test_worker_thread_has_no_running_loop_either_way():
    """The second gate, and why to_thread alone is not enough."""

    def loop_state() -> str:
        try:
            asyncio.get_running_loop()
            return "has-loop"
        except RuntimeError:
            return "no-loop"

    async def main() -> tuple[str, str]:
        loop = asyncio.get_running_loop()
        return (
            await loop.run_in_executor(None, loop_state),
            await asyncio.to_thread(loop_state),
        )

    assert asyncio.run(main()) == ("no-loop", "no-loop")


def test_spend_from_a_worker_thread_reaches_the_ledger(monkeypatch):
    """End-to-end: the write survives the thread hop."""
    recorded: list[cl.CostEvent] = []

    async def _capture(event: cl.CostEvent) -> bool:
        recorded.append(event)
        return True

    monkeypatch.setattr(cl, "record_cost_event", _capture)

    async def main() -> None:
        cl.bind_event_loop()

        def in_thread() -> None:
            # Exactly what _log_usage does from inside the executor.
            cl.schedule_record_from_usage(
                model="tencent/hy3",
                prompt_tokens=100,
                completion_tokens=20,
                total_tokens=120,
                cost_usd=0.0042,
                org_id="org-thread",
                feature="trace_annotator",
            )

        await asyncio.to_thread(in_thread)
        # run_coroutine_threadsafe schedules; give the loop a turn.
        for _ in range(20):
            if recorded:
                break
            await asyncio.sleep(0.01)

    asyncio.run(main())

    assert recorded, (
        "spend booked from a worker thread never reached the ledger"
    )
    assert recorded[0].org_id == "org-thread"
    assert recorded[0].cost_usd == 0.0042
    assert recorded[0].model == "tencent/hy3"


def test_without_the_loop_binding_the_write_is_dropped(monkeypatch):
    """The regression itself: unbound, an off-thread write goes nowhere.

    This is what production did on every routed LLM call.
    """
    recorded: list[cl.CostEvent] = []

    async def _capture(event: cl.CostEvent) -> bool:
        recorded.append(event)
        return True

    monkeypatch.setattr(cl, "record_cost_event", _capture)

    async def main() -> None:
        cl.reset_event_loop_binding()  # no binding

        def in_thread() -> None:
            cl.schedule_record_from_usage(
                model="tencent/hy3", cost_usd=0.0042, org_id="org-thread",
            )

        await asyncio.to_thread(in_thread)
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert recorded == [], (
        "without a bound loop the write cannot be scheduled — if this "
        "starts passing, the fallback path changed"
    )


def test_missing_org_still_drops_the_write(monkeypatch):
    """The oid guard is still load-bearing — an unattributable event
    must not be booked against nobody."""
    recorded: list[cl.CostEvent] = []

    async def _capture(event: cl.CostEvent) -> bool:  # pragma: no cover
        recorded.append(event)
        return True

    monkeypatch.setattr(cl, "record_cost_event", _capture)

    async def main() -> None:
        cl.bind_event_loop()

        def in_thread() -> None:
            cl.schedule_record_from_usage(
                model="tencent/hy3", cost_usd=0.01, org_id=None,
            )

        await asyncio.to_thread(in_thread)
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert recorded == []
