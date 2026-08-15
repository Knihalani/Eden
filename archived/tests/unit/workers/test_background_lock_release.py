"""The bundle lock must be released on shutdown, not left to expire.

``BackgroundWorkers.stop()`` cancels the supervisor task. The release used to
live in ``_supervise``'s ``finally``:

    finally:
        extender_stop.set()
        ...
        await self._stop_all(self._state, include_adopted=False)
        await lock.release()

Every ``await`` in the ``finally`` of a task that has just been cancelled
re-raises ``CancelledError`` at its first suspension point, so ``lock.release()``
was routinely never reached. The bundle lock then sat held until its TTL expired
and no other replica could take over the background fleet for up to
``_BUNDLE_LOCK_TTL_SECONDS`` after *every* deploy.

Nothing reported it. From the outside a fleet that is leaderless for a minute
after each rollout looks like a slow rollout.

The release now happens in ``stop()``, which the lifespan calls and which is not
itself cancelled, so its awaits complete. ``_supervise`` still releases on the
paths where it can (lock loss, Postgres fallback) and clears ``_held`` when it
does, making the ``stop()`` release idempotent.

A note on the ordering: the plan for this work said "release the lock *before*
the drain". That would be wrong. Releasing first lets a peer acquire the lock and
start the same loops while this replica's loops are still flushing — two live
leaders, which is the single failure this module exists to prevent. The drain
runs first and the release is made robust instead.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from eden.workers.background import BackgroundWorkers


class _FakeRedisLock:
    def __init__(self) -> None:
        self.released = 0

    async def release(self) -> bool:
        self.released += 1
        return True


class TestStopReleasesLeadership:
    @pytest.mark.asyncio
    async def test_redis_lock_is_released(self) -> None:
        workers = BackgroundWorkers()
        lock = _FakeRedisLock()
        workers._held = ("redis", lock)

        await workers._release_leadership()

        assert lock.released == 1, (
            "the bundle lock was not released — the fleet stays leaderless "
            "until the TTL expires"
        )
        assert workers._held is None

    @pytest.mark.asyncio
    async def test_postgres_lease_is_released(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from eden.storage import pg_lease

        calls: list[tuple[str, str]] = []

        async def _release(name: str, identity: str) -> bool:
            calls.append((name, identity))
            return True

        monkeypatch.setattr(pg_lease, "release", _release)
        workers = BackgroundWorkers()
        workers._held = ("postgres", "host:1")

        await workers._release_leadership()

        assert len(calls) == 1
        assert calls[0][1] == "host:1"
        assert workers._held is None

    @pytest.mark.asyncio
    async def test_release_is_idempotent(self) -> None:
        """``_supervise`` may already have released it on a lock-loss path."""
        workers = BackgroundWorkers()
        lock = _FakeRedisLock()
        workers._held = ("redis", lock)

        await workers._release_leadership()
        await workers._release_leadership()

        assert lock.released == 1

    @pytest.mark.asyncio
    async def test_nothing_held_is_a_no_op(self) -> None:
        workers = BackgroundWorkers()
        assert workers._held is None
        await workers._release_leadership()  # must not raise

    @pytest.mark.asyncio
    async def test_a_failing_release_does_not_break_shutdown(self) -> None:
        """A dead Redis at shutdown must not abort the rest of the teardown."""

        class _Boom:
            async def release(self) -> bool:
                raise RuntimeError("connection reset")

        workers = BackgroundWorkers()
        workers._held = ("redis", _Boom())
        await workers._release_leadership()  # must not raise
        assert workers._held is None


class TestStopCallsRelease:
    @pytest.mark.asyncio
    async def test_stop_releases_after_draining(self) -> None:
        """Order matters: drain, then release. Never the reverse."""
        order: list[str] = []
        workers = BackgroundWorkers()

        async def _fake_stop_all(_state: Any, **_kw: Any) -> None:
            order.append("drain")

        async def _fake_release() -> None:
            order.append("release")

        workers._stop_all = _fake_stop_all  # type: ignore[method-assign]
        workers._release_leadership = _fake_release  # type: ignore[method-assign]

        async def _noop() -> None:
            return None

        workers._task = asyncio.create_task(_noop())
        await workers.stop(timeout=1.0)

        assert order == ["drain", "release"], (
            "releasing before the drain lets a peer start the same loops while "
            "this replica is still flushing — two live leaders"
        )

    @pytest.mark.asyncio
    async def test_stop_without_a_task_does_not_release(self) -> None:
        """Never started means nothing was ever held."""
        called: list[str] = []
        workers = BackgroundWorkers()

        async def _fake_release() -> None:
            called.append("release")

        workers._release_leadership = _fake_release  # type: ignore[method-assign]
        await workers.stop(timeout=1.0)
        assert called == []

    @pytest.mark.asyncio
    async def test_release_survives_a_cancelled_supervisor(self) -> None:
        """The actual regression: the release must not ride on the cancelled task.

        ``stop()`` cancels ``_task``; a release awaited inside that task's
        ``finally`` is skipped. Here the supervisor is genuinely cancelled and
        the release must still happen.
        """
        workers = BackgroundWorkers()
        lock = _FakeRedisLock()
        workers._held = ("redis", lock)

        async def _hang() -> None:
            await asyncio.sleep(3600)

        async def _fake_stop_all(_state: Any, **_kw: Any) -> None:
            return None

        workers._stop_all = _fake_stop_all  # type: ignore[method-assign]
        workers._task = asyncio.create_task(_hang())

        await asyncio.wait_for(workers.stop(timeout=0.05), timeout=10.0)

        assert lock.released == 1, (
            "the release was skipped because the supervisor task was cancelled"
        )
