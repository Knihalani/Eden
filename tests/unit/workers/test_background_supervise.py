"""Regression tests for eden.workers.background's crash-restart wrapper,
decoupled leader-lock TTL, and shared sidecar guard consolidation.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_background_start_restarts_supervise_after_crash() -> None:
    """BackgroundWorkers.start()'s leader-supervisor task must self-heal.

    Regression: previously an unhandled exception inside ``_supervise``
    permanently killed every leader-gated background loop for the
    process's lifetime — no restart, no self-healing, unlike
    eden.workers.main's loops which already had this via its own
    ``_supervise`` helper.
    """
    from eden.workers import background as background_module

    workers = background_module.BackgroundWorkers()
    attempts = 0

    async def _fake_supervise(settings: object) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("boom")
        workers._stop.set()

    settings = MagicMock()
    settings.run_background_workers = True

    with patch.object(workers, "_supervise", _fake_supervise), patch.object(
        background_module, "_RESTART_BACKOFF_SECONDS", 0.01
    ):
        await workers.start(settings)
        assert workers._task is not None
        await asyncio.wait_for(workers._task, timeout=2.0)

    assert attempts == 2, "crashed leader-supervisor must restart, not die silently"


@pytest.mark.asyncio
async def test_background_start_does_not_restart_after_stop() -> None:
    """Once stop is set, a subsequent crash must not trigger a restart."""
    from eden.workers import background as background_module

    workers = background_module.BackgroundWorkers()
    attempts = 0

    async def _fake_supervise(settings: object) -> None:
        nonlocal attempts
        attempts += 1
        workers._stop.set()
        raise RuntimeError("boom after stop")

    settings = MagicMock()
    settings.run_background_workers = True

    with patch.object(workers, "_supervise", _fake_supervise), patch.object(
        background_module, "_RESTART_BACKOFF_SECONDS", 0.01
    ):
        await workers.start(settings)
        await asyncio.wait_for(workers._task, timeout=2.0)

    assert attempts == 1


@pytest.mark.asyncio
async def test_background_leader_lock_ttl_decoupled_from_interval() -> None:
    """The api-background lock's TTL must be the fixed leader.py constant,
    not scaled off the (possibly large) configured tick interval.

    Regression: previously ``ttl=int(interval * 3)`` — with
    ``redis_leader_tick_seconds`` configured large, a hard-crashed
    leader blocked failover for a correspondingly long time.
    """
    from eden.workers import background as background_module
    from eden.workers.leader import _DEFAULT_LOCK_TTL_SECONDS
    from eden.storage.redis import Lock as RealLock

    captured_ttls: list[int] = []
    orig_init = RealLock.__init__

    def _spy_init(self, name, ttl=30, prefix="eden:lock"):
        captured_ttls.append(ttl)
        orig_init(self, name, ttl=ttl, prefix=prefix)

    workers = background_module.BackgroundWorkers()

    async def _fake_start_all(settings, state):
        workers._stop.set()

    settings = MagicMock()
    settings.redis_leader_tick_seconds = 3600  # a large configured interval

    with patch.object(RealLock, "__init__", _spy_init), patch(
        "eden.workers.background.Lock.acquire", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.background.Lock.release", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.background.Lock.extend", new=AsyncMock(return_value=True)
    ), patch.object(
        workers, "_start_all", _fake_start_all
    ), patch.object(
        workers, "_stop_all", new=AsyncMock()
    ):
        await asyncio.wait_for(workers._supervise(settings), timeout=2.0)

    assert captured_ttls, "Lock should have been constructed"
    assert captured_ttls[0] == _DEFAULT_LOCK_TTL_SECONDS
    assert captured_ttls[0] < 3600 * 3


@pytest.mark.asyncio
async def test_background_uses_shared_sidecar_bundle_helper() -> None:
    """_start_all/_stop_all must delegate quality/closed-loop sidecars to
    the shared eden.workers.sidecars helper (single guarded place),
    not duplicate the start/stop logic inline.
    """
    import inspect

    from eden.workers import background as background_module

    start_src = inspect.getsource(background_module.BackgroundWorkers._start_all)
    stop_src = inspect.getsource(background_module.BackgroundWorkers._stop_all)
    assert "eden.workers.sidecars" in start_src
    assert "start_quality_and_closed_loop_sidecars" in start_src
    assert "eden.workers.sidecars" in stop_src
    assert "stop_quality_and_closed_loop_sidecars" in stop_src
    # The old inline importlib-based stop loop must be gone.
    assert "importlib" not in stop_src
