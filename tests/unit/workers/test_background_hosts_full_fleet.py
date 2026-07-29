"""The API-hosted bundle must host the whole background fleet.

`eden.workers.main` is a daemon that was deployed as a Northflank *Job*.
Jobs are for finite work: the container was reaped and restarted every
96-270s (measured from heartbeat gaps, and from the leader-acquire
counters resetting to zero between writes), so none of its loops ever
completed a single tick. For 7.4 days that meant no webhook delivery, no
scheduled EQL alerts, no retention/compaction, no artifact demotion and
no self-observability heartbeat — while the job reported RUNNING and
`/health` reported healthy.

Five of those loops existed *only* in `workers.main`. They are now also
hosted by `workers.background`, which runs inside the always-on API
service. These tests pin that adoption, because losing it silently is
exactly the failure mode that went unnoticed for a week.
"""

from __future__ import annotations

import asyncio
import inspect
from unittest.mock import patch

import pytest

from eden.workers import background as bg


#: Loops that have no home other than the API bundle now.
ADOPTED = {
    "webhook_drain",
    "eql_alert_watchdog",
    "artifact_demotion",
    "maintenance",
    "self_obs_probes",
}


def test_all_worker_only_loops_are_adopted() -> None:
    names = {name for name, _ in bg._leader_loops_from_worker_main()}
    assert names == ADOPTED, (
        f"background bundle no longer hosts {ADOPTED - names or names - ADOPTED}"
    )


def test_adopted_factories_are_the_real_coroutine_functions() -> None:
    """Guards against a rename silently yielding None and being skipped."""
    for name, factory in bg._leader_loops_from_worker_main():
        assert factory is not None, name
        assert inspect.iscoroutinefunction(factory), f"{name} is not async"


def test_missing_factory_degrades_instead_of_raising() -> None:
    """A rename in workers.main must not stop the API from booting."""

    class _Stub:
        _leader_webhook_drain_loop = None

    with patch.object(bg, "logger") as log:
        with patch.dict("sys.modules", {}, clear=False):
            # Simulate the attribute vanishing.
            import eden.workers.main as real

            with patch.object(real, "_leader_maintenance", None, create=False):
                names = {n for n, _ in bg._leader_loops_from_worker_main()}
    assert "maintenance" not in names
    assert names, "one missing factory must not drop the rest"
    assert log.warning.called


def test_import_failure_returns_empty_not_exception() -> None:
    with patch.dict("sys.modules", {"eden.workers.main": None}):
        # A None module makes `from eden.workers import main` raise.
        try:
            result = bg._leader_loops_from_worker_main()
        except Exception as exc:  # pragma: no cover - the thing we forbid
            pytest.fail(f"import guard let an exception escape: {exc!r}")
    assert isinstance(result, list)


def test_state_tracks_adopted_loops_for_shutdown() -> None:
    state = bg._BackgroundState()
    assert state.leader_loops == {}, "adopted loops need a home for draining"


@pytest.mark.asyncio
async def test_stop_all_drains_adopted_loops() -> None:
    """Shutdown must cancel them — a leaked task keeps holding leader
    locks after the process means to be done with them."""
    state = bg._BackgroundState()
    state.started = True

    never = asyncio.Event()

    async def _loop():
        await never.wait()

    task = asyncio.create_task(_loop())
    await asyncio.sleep(0)
    state.leader_loops["maintenance"] = task

    workers = bg.BackgroundWorkers()
    await workers._stop_all(state)

    assert task.cancelled() or task.done(), "adopted loop was not drained"
    assert state.leader_loops == {}
