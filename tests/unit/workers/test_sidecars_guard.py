"""Regression tests for the cross-process sidecar guard.

eden.workers.main and eden.workers.background used to duplicate the
same quality_pipeline/trace_finalized/closed_loop start+stop logic
with only the ``EDEN_RUN_BACKGROUND_WORKERS`` env var separating the
two processes — no real cross-process guard. eden.workers.sidecars
consolidates the duplicated logic and adds a Redis leader-lock guard
so at most one process hosts the bundle at a time.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_sidecars_state():
    from eden.workers import sidecars as sidecars_module

    sidecars_module._reset_state_for_tests()
    yield
    sidecars_module._reset_state_for_tests()


@pytest.mark.asyncio
async def test_second_process_is_blocked_when_guard_already_held() -> None:
    """Simulates two processes racing to start the sidecar bundle: only
    the first should actually start anything."""
    from eden.workers import sidecars as sidecars_module

    with patch(
        "eden.workers.sidecars.Lock.acquire",
        new=AsyncMock(side_effect=[True]),
    ), patch(
        "eden.workers.sidecars.Lock.release", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.sidecars._extend_lock_periodically",
        new=AsyncMock(),
    ), patch(
        "eden.observability.quality_pipeline.worker.start_worker",
        new_callable=AsyncMock,
    ) as start_q, patch(
        "eden.workers.trace_finalized_consumer.start_consumer",
        new_callable=AsyncMock,
    ), patch(
        "eden.closed_loop.event_bus.start_consumer",
        new_callable=AsyncMock,
    ), patch(
        "eden.closed_loop.verify.start_verify_worker",
        new_callable=AsyncMock,
    ):
        first = await sidecars_module.start_quality_and_closed_loop_sidecars(
            "worker"
        )

    assert first is True
    start_q.assert_awaited_once()

    # A second process (fresh module state) racing for the same guard
    # loses — Lock.acquire returns False for every attempt.
    sidecars_module._reset_state_for_tests()
    with patch(
        "eden.workers.sidecars.Lock.acquire",
        new=AsyncMock(return_value=False),
    ), patch(
        "eden.workers.sidecars._GUARD_RETRY_DELAY_SECONDS", 0.0
    ), patch(
        "eden.observability.quality_pipeline.worker.start_worker",
        new_callable=AsyncMock,
    ) as start_q2:
        second = await sidecars_module.start_quality_and_closed_loop_sidecars(
            "background"
        )

    assert second is False
    start_q2.assert_not_awaited()


@pytest.mark.asyncio
async def test_guard_retries_before_failing_closed() -> None:
    """A transient Redis blip should not permanently block sidecar start —
    a few quick retries ride it out."""
    from eden.workers import sidecars as sidecars_module

    acquire_mock = AsyncMock(side_effect=[False, False, True])

    with patch(
        "eden.workers.sidecars.Lock.acquire", new=acquire_mock
    ), patch(
        "eden.workers.sidecars._GUARD_RETRY_DELAY_SECONDS", 0.0
    ), patch(
        "eden.workers.sidecars._extend_lock_periodically", new=AsyncMock()
    ), patch(
        "eden.observability.quality_pipeline.worker.start_worker",
        new_callable=AsyncMock,
    ) as start_q, patch(
        "eden.workers.trace_finalized_consumer.start_consumer",
        new_callable=AsyncMock,
    ), patch(
        "eden.closed_loop.event_bus.start_consumer", new_callable=AsyncMock
    ), patch(
        "eden.closed_loop.verify.start_verify_worker", new_callable=AsyncMock
    ):
        ok = await sidecars_module.start_quality_and_closed_loop_sidecars("worker")

    assert ok is True
    assert acquire_mock.await_count == 3
    start_q.assert_awaited_once()


@pytest.mark.asyncio
async def test_stop_releases_guard_and_resets_started_state() -> None:
    from eden.workers import sidecars as sidecars_module

    with patch(
        "eden.workers.sidecars.Lock.acquire", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.sidecars.Lock.release", new=AsyncMock(return_value=True)
    ) as release_mock, patch(
        "eden.workers.sidecars._extend_lock_periodically", new=AsyncMock()
    ), patch(
        "eden.observability.quality_pipeline.worker.start_worker",
        new_callable=AsyncMock,
    ), patch(
        "eden.workers.trace_finalized_consumer.start_consumer",
        new_callable=AsyncMock,
    ), patch(
        "eden.closed_loop.event_bus.start_consumer", new_callable=AsyncMock
    ), patch(
        "eden.closed_loop.verify.start_verify_worker", new_callable=AsyncMock
    ), patch(
        "eden.observability.quality_pipeline.worker.stop_worker",
        new_callable=AsyncMock,
    ), patch(
        "eden.workers.trace_finalized_consumer.stop_consumer",
        new_callable=AsyncMock,
    ), patch(
        "eden.closed_loop.event_bus.stop_consumer", new_callable=AsyncMock
    ), patch(
        "eden.closed_loop.verify.stop_verify_worker", new_callable=AsyncMock
    ):
        await sidecars_module.start_quality_and_closed_loop_sidecars("worker")
        assert sidecars_module._guard_lock is not None
        await sidecars_module.stop_quality_and_closed_loop_sidecars("worker")

    release_mock.assert_awaited()
    assert sidecars_module._guard_lock is None
    assert sidecars_module._started is False
