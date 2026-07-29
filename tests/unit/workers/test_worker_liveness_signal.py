"""The worker must report liveness without needing to be the leader.

Root cause of the July 2026 seven-day silent outage:

``Lock.acquire`` fails closed on any Redis error — it logs a warning and
returns ``False`` (``storage/redis.py``). Every background loop is
leader-gated through that lock, so when Redis is unreachable or a provider
command quota is exhausted, all six loops spin quietly forever while the
container still reports RUNNING.

The self-obs heartbeat could not surface this, because that heartbeat is
itself written by a leader-gated loop. So "worker process is dead" and
"worker process is alive but cannot acquire leadership" produced byte-identical
evidence: nothing at all.

``_worker_liveness_loop`` writes an unconditional ``worker_process``
heartbeat that never touches Redis, carrying the leader-acquire failure
count. These tests pin that it stays lock-free.
"""

from __future__ import annotations

import asyncio
import inspect
from unittest.mock import AsyncMock, patch

import pytest

from eden.workers import leader as leader_mod
from eden.workers import main as worker_main


@pytest.fixture(autouse=True)
def _reset_counts():
    leader_mod.reset_leader_failure_counts()
    yield
    leader_mod.reset_leader_failure_counts()


def test_liveness_loop_is_registered_unconditionally() -> None:
    """It must be created in ``_run_forever`` with no flag guarding it —
    a liveness signal you can switch off is not a liveness signal."""
    src = inspect.getsource(worker_main._run_forever)
    assert "_worker_liveness_loop" in src
    assert "worker_liveness" in src


def test_liveness_loop_never_takes_the_leader_lock() -> None:
    """The whole point: this path must not depend on Redis."""
    src = inspect.getsource(worker_main._worker_liveness_loop)
    assert "run_if_leader" not in src, (
        "liveness heartbeat became leader-gated — it can no longer report "
        "the exact failure it exists to report"
    )
    assert "record_heartbeat" in src
    assert "worker_process" in src


@pytest.mark.asyncio
async def test_liveness_writes_a_heartbeat_and_stops_on_signal() -> None:
    recorded: list[tuple] = []

    async def _fake_record(component, *, org_id=None, status=None, meta=None):
        recorded.append((component, status, meta))

    stop = asyncio.Event()
    with patch("eden.self_obs.heartbeats.record_heartbeat", _fake_record), patch.object(
        worker_main, "_grid_interval", return_value=0.05
    ):
        task = asyncio.create_task(worker_main._worker_liveness_loop(stop))
        await asyncio.sleep(0.15)
        stop.set()
        await asyncio.wait_for(task, timeout=2.0)

    assert recorded, "liveness loop wrote no heartbeat"
    component, status, meta = recorded[0]
    assert component == "worker_process"
    assert status == "healthy"
    assert meta["leader_acquire_failures"] == 0


@pytest.mark.asyncio
async def test_liveness_reports_degraded_when_leadership_is_unobtainable() -> None:
    """Alive-but-not-leading has to look different from healthy."""
    recorded: list[tuple] = []

    async def _fake_record(component, *, org_id=None, status=None, meta=None):
        recorded.append((component, status, meta))

    leader_mod._acquire_failures["insights_loop"] = 7

    stop = asyncio.Event()
    with patch("eden.self_obs.heartbeats.record_heartbeat", _fake_record), patch.object(
        worker_main, "_grid_interval", return_value=0.05
    ):
        task = asyncio.create_task(worker_main._worker_liveness_loop(stop))
        await asyncio.sleep(0.12)
        stop.set()
        await asyncio.wait_for(task, timeout=2.0)

    _, status, meta = recorded[0]
    assert status == "degraded"
    assert meta["leader_acquire_failures"] == 7


@pytest.mark.asyncio
async def test_liveness_survives_a_failing_heartbeat_write() -> None:
    """A broken heartbeat table must not kill the loop — otherwise the
    signal disappears exactly when something is already wrong."""
    calls = {"n": 0}

    async def _boom(*a, **kw):
        calls["n"] += 1
        raise RuntimeError("relation does not exist")

    stop = asyncio.Event()
    with patch("eden.self_obs.heartbeats.record_heartbeat", _boom), patch.object(
        worker_main, "_grid_interval", return_value=0.05
    ):
        task = asyncio.create_task(worker_main._worker_liveness_loop(stop))
        await asyncio.sleep(0.15)
        stop.set()
        await asyncio.wait_for(task, timeout=2.0)

    assert calls["n"] >= 2, "loop died on the first heartbeat failure"


@pytest.mark.asyncio
async def test_failed_acquisition_is_counted_and_cleared() -> None:
    from eden.workers.leader import run_if_leader

    assert leader_mod.leader_acquire_failure_count() == 0

    stop = asyncio.Event()

    class _NeverAcquires:
        """Mirrors the real Lock surface: acquire(token=…) and holder().

        ``holder`` reports a peer, so this is genuine contention rather
        than the broken-write-path case that elects through Postgres.
        """

        def __init__(self, *a, **kw):
            self.name = "t"

        async def acquire(self, token=None):
            stop.set()
            return False

        async def holder(self):
            return "another-replica:1"

    with patch.object(leader_mod, "Lock", _NeverAcquires):
        await asyncio.wait_for(
            run_if_leader("t", AsyncMock(), interval=0.01, stop=stop), timeout=3.0
        )

    assert leader_mod.leader_acquire_failure_count("t") >= 1
    assert leader_mod.leader_acquire_failure_count() >= 1


@pytest.mark.asyncio
async def test_alive_loops_report_where_they_are_suspended() -> None:
    """A loop wedged on an await that never returns is indistinguishable
    from a healthy one unless the signal says *where* it is parked."""
    recorded: list[tuple] = []

    async def _fake_record(component, *, org_id=None, status=None, meta=None):
        recorded.append((component, status, meta))

    never = asyncio.Event()

    async def _wedged():
        await never.wait()

    wedged_task = asyncio.create_task(_wedged())
    await asyncio.sleep(0)

    worker_main._loop_tasks.clear()
    worker_main._loop_tasks["insights_loop"] = wedged_task
    try:
        stop = asyncio.Event()
        with patch(
            "eden.self_obs.heartbeats.record_heartbeat", _fake_record
        ), patch.object(worker_main, "_grid_interval", return_value=0.05):
            task = asyncio.create_task(worker_main._worker_liveness_loop(stop))
            await asyncio.sleep(0.12)
            stop.set()
            await asyncio.wait_for(task, timeout=2.0)
    finally:
        wedged_task.cancel()
        worker_main._loop_tasks.clear()

    state = recorded[0][2]["loops"]["insights_loop"]
    assert state.startswith("alive@"), state
    assert "wedged" in state or ":" in state, (
        f"suspended frame not reported: {state}"
    )


@pytest.mark.asyncio
async def test_work_failure_is_recorded_and_surfaced() -> None:
    """Acquisition succeeding and the work then throwing looks identical
    from outside to never acquiring: no heartbeat, no progress, zero
    acquire failures. Only the recorded exception separates them."""
    from eden.workers.leader import run_if_leader

    stop = asyncio.Event()

    class _AlwaysAcquires:
        def __init__(self, *a, **kw):
            self.name = "t"

        async def acquire(self, token=None):
            return True

        async def holder(self):
            return None

        async def extend(self, *a, **kw):
            return True

        async def release(self):
            return True

    async def _boom():
        stop.set()
        raise RuntimeError("probe blew up")

    with patch.object(leader_mod, "Lock", _AlwaysAcquires):
        await asyncio.wait_for(
            run_if_leader("self_obs_probes", _boom, interval=0.01, stop=stop),
            timeout=5.0,
        )

    failures = leader_mod.leader_work_failures()
    assert "self_obs_probes" in failures
    assert "RuntimeError" in failures["self_obs_probes"]
    # And it must not be mistaken for an acquisition problem.
    assert leader_mod.leader_acquire_failure_count() == 0


@pytest.mark.asyncio
async def test_hung_acquire_is_bounded_and_retried() -> None:
    """A lock acquisition that never returns must not park the loop
    forever. This is the exact production failure: every leader loop
    entered run_if_leader once, called acquire, and never came back —
    no True, no False, no exception — so the whole background fleet went
    silent for seven days with a zero failure count."""
    from eden.workers import leader as lm
    from eden.workers.leader import run_if_leader

    stop = asyncio.Event()
    attempts = {"n": 0}

    class _HangsForever:
        def __init__(self, *a, **kw):
            self.name = "t"

        async def acquire(self, token=None):
            attempts["n"] += 1
            if attempts["n"] >= 2:
                stop.set()
            await asyncio.Event().wait()  # never returns

        async def holder(self):
            return "another-replica:1"

        async def release(self):
            return True

    with patch.object(lm, "Lock", _HangsForever), patch.object(
        lm, "_ACQUIRE_TIMEOUT_SECONDS", 0.05
    ):
        await asyncio.wait_for(
            run_if_leader("t", AsyncMock(), interval=0.01, stop=stop),
            timeout=5.0,
        )

    assert attempts["n"] >= 2, "loop did not retry after a hung acquire"
    assert lm.leader_acquire_failure_count("t") >= 1, (
        "a hung acquire must be counted as a failure, not silently ignored"
    )
