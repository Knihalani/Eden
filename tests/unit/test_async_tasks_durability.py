"""A fire-and-forget task must survive the GC and the shutdown.

``bounded_create_task`` returned ``loop.create_task(...)`` and every caller on
the hot paths discarded it. The event loop holds tasks only *weakly* — CPython's
own docs on ``asyncio.create_task`` say "Save a reference to the result of this
function, to avoid a task disappearing mid-execution" — so an in-flight task was
collectable at any await point.

For the tasks scheduled through here that is not a cosmetic risk. They are the
work that is not recorded anywhere else yet: ``_emit_billing_events``, telemetry
fan-out, debugger checkpoints. A collected billing task means usage that is
never billed, with no error, no log line, and no row. It is the quietest
possible failure.

Two more silences lived in the same function: a failed task was logged at
``debug`` (invisible at default level) and neither drop path was counted, so the
load-shed and failure rates were unobservable. And nothing waited for in-flight
tasks at shutdown, so a pod restart abandoned them mid-await.
"""

from __future__ import annotations

import asyncio
import gc

import pytest

from eden.async_tasks import (
    bounded_create_task,
    drain_background_tasks,
    pending_background_tasks,
    reset_bounded_task_semaphores,
)
from eden.observability.drop_metrics import get_drop_metrics, reset_for_tests


@pytest.fixture(autouse=True)
def _clean() -> None:
    reset_bounded_task_semaphores()
    reset_for_tests()
    yield
    reset_bounded_task_semaphores()
    reset_for_tests()


class TestStrongReference:
    @pytest.mark.asyncio
    async def test_completes_when_the_caller_discards_the_handle(self) -> None:
        """A smoke test, not the GC proof — and deliberately named as such.

        Forcing CPython to actually collect a scheduled task inside a test window
        is not reliable: the loop's reference keeps it alive for most of a task's
        life, and the weakness bites at specific points that cannot be summoned
        on demand. Verified by mutation — removing ``_track`` leaves *this* test
        green.

        The deterministic guard for the strong reference is ``_pending``
        membership, asserted by the two tests below and by the drain tests, all
        three of which do fail when ``_track`` is removed. This one only pins
        that the ordinary discard-the-handle call still runs to completion.
        """
        done = asyncio.Event()

        async def _work() -> None:
            await asyncio.sleep(0.05)
            done.set()

        bounded_create_task(_work(), name="billing")  # return value discarded
        gc.collect()
        gc.collect()

        await asyncio.wait_for(done.wait(), timeout=5.0)
        assert done.is_set()

    @pytest.mark.asyncio
    async def test_pending_count_reflects_in_flight_tasks(self) -> None:
        gate = asyncio.Event()

        async def _work() -> None:
            await gate.wait()

        for _ in range(3):
            bounded_create_task(_work(), name="w")
        await asyncio.sleep(0)
        assert pending_background_tasks() == 3

        gate.set()
        await asyncio.sleep(0.05)
        assert pending_background_tasks() == 0

    @pytest.mark.asyncio
    async def test_reference_is_released_when_the_task_finishes(self) -> None:
        """A strong reference that is never dropped is a memory leak."""

        async def _work() -> None:
            return None

        task = bounded_create_task(_work(), name="w")
        await task
        await asyncio.sleep(0)
        assert pending_background_tasks() == 0


class TestDrain:
    @pytest.mark.asyncio
    async def test_drain_waits_for_in_flight_work(self) -> None:
        finished: list[str] = []

        async def _work() -> None:
            await asyncio.sleep(0.05)
            finished.append("done")

        bounded_create_task(_work(), name="billing")
        cancelled = await drain_background_tasks(timeout=5.0)

        assert cancelled == 0
        assert finished == ["done"], "shutdown abandoned an in-flight write"

    @pytest.mark.asyncio
    async def test_drain_cancels_and_counts_what_will_not_finish(self) -> None:
        """A bounded drain: one wedged task must not hold the pod open."""

        async def _wedged() -> None:
            await asyncio.sleep(3600)

        bounded_create_task(_wedged(), name="wedged")
        cancelled = await asyncio.wait_for(
            drain_background_tasks(timeout=0.05), timeout=10.0
        )

        assert cancelled == 1
        assert get_drop_metrics().get(("queue", "shutdown"), 0.0) == 1.0

    @pytest.mark.asyncio
    async def test_drain_with_nothing_pending_is_a_no_op(self) -> None:
        assert await drain_background_tasks(timeout=1.0) == 0

    @pytest.mark.asyncio
    async def test_drain_is_registered_before_the_postgres_close(self) -> None:
        """In-flight tasks write through the pool they must not outlive."""
        from eden.api.app import _shutdown_steps

        names = [n for n, _, _ in _shutdown_steps(background_workers=True)]
        assert "background_tasks" in names, "shutdown never drains bounded tasks"
        assert names.index("background_tasks") < names.index("postgres")


class TestDropAccounting:
    @pytest.mark.asyncio
    async def test_a_failing_task_is_counted_not_just_debug_logged(self) -> None:
        async def _boom() -> None:
            raise RuntimeError("pg write failed")

        await bounded_create_task(_boom(), name="boom")
        assert get_drop_metrics().get(("queue", "write_error"), 0.0) == 1.0

    @pytest.mark.asyncio
    async def test_a_load_shed_drop_is_counted(self) -> None:
        gate = asyncio.Event()

        async def _work() -> None:
            await gate.wait()

        # limit=1, max_waiting=1: the third submission has nowhere to go.
        for _ in range(3):
            bounded_create_task(_work(), name="w", limit=1, max_waiting=1)
        await asyncio.sleep(0)

        assert get_drop_metrics().get(("queue", "queue_full"), 0.0) >= 1.0
        gate.set()

    @pytest.mark.asyncio
    async def test_a_cancelled_task_is_not_counted_as_a_failure(self) -> None:
        """Shutdown cancellation is accounted separately, not as a write error."""

        async def _work() -> None:
            await asyncio.sleep(3600)

        task = bounded_create_task(_work(), name="w")
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert get_drop_metrics().get(("queue", "write_error"), 0.0) == 0.0

    @pytest.mark.asyncio
    async def test_a_successful_task_records_no_drop(self) -> None:
        async def _work() -> None:
            return None

        await bounded_create_task(_work(), name="w")
        assert get_drop_metrics().get(("queue", "write_error"), 0.0) == 0.0
        assert get_drop_metrics().get(("queue", "queue_full"), 0.0) == 0.0
