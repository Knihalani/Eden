"""Wave 8.1 — worker main loops, leader lock, insights watermark.

Focused unit tests for crash supervision, silent-failure logging,
leader lock fail-closed behaviour, and webhook drain singleton use.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest


# ── Leader lock / run_if_leader ─────────────────────────────────────


@pytest.mark.asyncio
async def test_lock_acquire_fail_closed_on_redis_set_error() -> None:
    """Redis SET raising must not crash the worker — refuse lock."""
    from eden.storage.redis import Lock

    client = AsyncMock()
    client.set = AsyncMock(side_effect=ConnectionError("redis down"))

    with patch(
        "eden.storage.redis.get_redis_client",
        new=AsyncMock(return_value=client),
    ):
        lock = Lock("w8-acquire", ttl=30)
        assert await lock.acquire() is False
        assert lock._token is None


@pytest.mark.asyncio
async def test_run_if_leader_survives_acquire_exception() -> None:
    """Acquire raising must not kill the leader loop permanently."""
    from eden.workers.leader import run_if_leader

    stop = asyncio.Event()
    ticks = 0

    async def _work() -> None:
        nonlocal ticks
        ticks += 1
        stop.set()

    acquire_calls = 0

    async def _flaky_acquire(self: Any, token: str | None = None) -> bool:
        nonlocal acquire_calls
        acquire_calls += 1
        if acquire_calls == 1:
            raise RuntimeError("redis blip")
        # Second attempt: grant lock so work runs and stop is set.
        self._token = "tok"
        return True

    with patch("eden.workers.leader.Lock.acquire", _flaky_acquire), patch(
        "eden.workers.leader.Lock.release", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.extend", new=AsyncMock(return_value=True)
    ):
        await asyncio.wait_for(
            run_if_leader("w8-flaky", _work, interval=0.01, stop=stop),
            timeout=2.0,
        )

    assert acquire_calls >= 2
    assert ticks == 1


@pytest.mark.asyncio
async def test_run_if_leader_cancels_inflight_work_on_lost_lock() -> None:
    """Losing the lock mid-tick must cancel work(), not just stop renewal.

    Regression for split-brain: previously only the renewal task
    stopped once ``extend`` failed/returned False; the in-flight
    ``work()`` call kept running to completion, so a second replica
    that legitimately re-acquired the now-expired lock could run the
    same tick concurrently with the still-running first replica.
    """
    from eden.workers import leader as leader_module

    stop = asyncio.Event()
    state = {"started": False, "cancelled": False}

    async def _work() -> None:
        state["started"] = True
        try:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            state["cancelled"] = True
            stop.set()
            raise

    # Renewal cadence is a fixed module constant, decoupled from the
    # tick ``interval`` — shrink it so the test doesn't wait 20s.
    with patch.object(
        leader_module, "_DEFAULT_LOCK_RENEW_SECONDS", 0.01
    ), patch(
        "eden.workers.leader.Lock.acquire", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.release", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.extend", new=AsyncMock(return_value=False)
    ):
        await asyncio.wait_for(
            leader_module.run_if_leader(
                "w-split-brain", _work, interval=10.0, stop=stop
            ),
            timeout=2.0,
        )

    assert state["started"] is True
    assert state["cancelled"] is True


@pytest.mark.asyncio
async def test_run_if_leader_ttl_decoupled_from_large_interval() -> None:
    """Lock TTL must stay small/fixed even for a multi-hour tick interval.

    Regression: TTL used to be ``max(30, interval * 3)`` — for the
    3600s artifact-demotion loop that meant a 3-hour failover window
    after a hard leader crash (SIGKILL, no release path).
    """
    from eden.storage.redis import Lock as RealLock
    from eden.workers import leader as leader_module

    captured_ttls: list[int] = []
    orig_init = RealLock.__init__

    def _spy_init(self: Any, name: str, ttl: int = 30, prefix: str = "eden:lock") -> None:
        captured_ttls.append(ttl)
        orig_init(self, name, ttl=ttl, prefix=prefix)

    stop = asyncio.Event()

    async def _work() -> None:
        stop.set()

    with patch.object(RealLock, "__init__", _spy_init), patch(
        "eden.workers.leader.Lock.acquire", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.release", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.extend", new=AsyncMock(return_value=True)
    ):
        await asyncio.wait_for(
            leader_module.run_if_leader(
                "w-ttl-large", _work, interval=3600.0, stop=stop
            ),
            timeout=2.0,
        )

    assert captured_ttls, "Lock should have been constructed"
    assert captured_ttls[0] == leader_module._DEFAULT_LOCK_TTL_SECONDS
    assert captured_ttls[0] < 3600 * 3


@pytest.mark.asyncio
async def test_run_if_leader_logs_work_failure_and_continues() -> None:
    """Work exceptions are logged; the loop keeps ticking."""
    from eden.workers.leader import run_if_leader

    stop = asyncio.Event()
    calls = 0

    async def _work() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ValueError("tick boom")
        stop.set()

    with patch(
        "eden.workers.leader.Lock.acquire", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.release", new=AsyncMock(return_value=True)
    ), patch(
        "eden.workers.leader.Lock.extend", new=AsyncMock(return_value=True)
    ):
        await asyncio.wait_for(
            run_if_leader("w8-work-fail", _work, interval=0.01, stop=stop),
            timeout=2.0,
        )

    assert calls == 2


# ── Supervised restart ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_supervise_restarts_after_crash() -> None:
    """Unhandled factory crash → ERROR log + restart after backoff."""
    from eden.workers import main as worker_main

    stop = asyncio.Event()
    attempts = 0

    async def _factory(stop_event: asyncio.Event) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("boom")
        stop_event.set()

    await asyncio.wait_for(
        worker_main._supervise(
            "test-loop", _factory, stop, backoff=0.01
        ),
        timeout=2.0,
    )
    assert attempts == 2
    assert stop.is_set()


# ── Quality / evolution sidecars on eden-worker ─────────────────────


@pytest.mark.asyncio
async def test_run_forever_starts_and_stops_sidecars() -> None:
    """eden-worker must host quality (+ evolution) — API leaves them off."""
    from eden.workers import main as worker_main

    started: list[str] = []
    stopped: list[str] = []
    stop_holder: list[asyncio.Event] = []

    async def _fake_start() -> None:
        started.append("sidecars")

    async def _fake_stop() -> None:
        stopped.append("sidecars")

    async def _noop_supervise(
        name: str,
        factory: Any,
        stop: asyncio.Event,
        *,
        backoff: float = 5.0,
    ) -> None:
        await stop.wait()

    def _capture_handlers(stop: asyncio.Event) -> None:
        stop_holder.append(stop)

    with patch.object(
        worker_main, "_start_sidecar_workers", _fake_start
    ), patch.object(
        worker_main, "_stop_sidecar_workers", _fake_stop
    ), patch.object(
        worker_main, "_supervise", _noop_supervise
    ), patch.object(
        worker_main, "_install_signal_handlers", _capture_handlers
    ):
        task = asyncio.create_task(worker_main._run_forever())
        for _ in range(50):
            if stop_holder:
                break
            await asyncio.sleep(0.01)
        assert started == ["sidecars"]
        assert stop_holder, "signal handlers should capture stop event"
        stop_holder[0].set()
        await asyncio.wait_for(task, timeout=2.0)

    assert started == ["sidecars"]
    assert stopped == ["sidecars"]


@pytest.mark.asyncio
async def test_start_sidecar_workers_calls_quality_and_evolution() -> None:
    from eden.workers import main as worker_main
    from eden.workers import sidecars as sidecars_module

    sidecars_module._reset_state_for_tests()
    try:
        with patch(
            "eden.observability.quality_pipeline.worker.start_worker",
            new_callable=AsyncMock,
        ) as start_q, patch(
            "eden.agents.evolution.loop.start_evolution_loop",
            new_callable=AsyncMock,
        ) as start_e, patch(
            "eden.workers.sidecars._acquire_guard",
            new=AsyncMock(return_value=True),
        ):
            await worker_main._start_sidecar_workers()

        start_q.assert_awaited_once()
        start_e.assert_awaited_once()
    finally:
        sidecars_module._reset_state_for_tests()


# ── Self-observability scheduled probe loop (F84 scheduling gap) ───


@pytest.mark.asyncio
async def test_leader_self_obs_probes_registered_via_run_if_leader() -> None:
    """The self_obs_probes loop must be wired through run_if_leader,
    following the exact pattern of the other leader-gated loops
    (EQL watchdog, maintenance, ...), and must call
    ``run_scheduled_probes`` — previously nothing scheduled the probes
    at all.
    """
    from eden.workers import main as worker_main

    stop = asyncio.Event()
    calls: list[tuple[str, float]] = []

    async def _fake_run_if_leader(lock_name, work, *, interval, stop=None, ttl=None):
        calls.append((lock_name, interval))
        await work()

    with patch(
        "eden.workers.leader.run_if_leader", _fake_run_if_leader
    ), patch(
        "eden.self_obs.scheduler.run_scheduled_probes",
        new=AsyncMock(return_value={"orgs_scanned": 0, "degraded_orgs": []}),
    ) as fake_probes:
        await worker_main._leader_self_obs_probes(stop)

    assert calls == [("self_obs_probes", 600.0)]
    fake_probes.assert_awaited_once()


@pytest.mark.asyncio
async def test_run_forever_hosts_self_obs_probes_loop() -> None:
    """``_run_forever`` must create + supervise the self_obs_probes loop."""
    from eden.workers import main as worker_main

    stop_holder: list[asyncio.Event] = []
    supervised_names: list[str] = []

    async def _noop_supervise(name, factory, stop, *, backoff: float = 5.0) -> None:
        supervised_names.append(name)
        await stop.wait()

    def _capture_handlers(stop: asyncio.Event) -> None:
        stop_holder.append(stop)

    with patch.object(
        worker_main, "_start_sidecar_workers", new=AsyncMock()
    ), patch.object(
        worker_main, "_stop_sidecar_workers", new=AsyncMock()
    ), patch.object(
        worker_main, "_supervise", _noop_supervise
    ), patch.object(
        worker_main, "_install_signal_handlers", _capture_handlers
    ):
        task = asyncio.create_task(worker_main._run_forever())
        for _ in range(50):
            if stop_holder:
                break
            await asyncio.sleep(0.01)
        assert "self_obs_probes" in supervised_names
        stop_holder[0].set()
        await asyncio.wait_for(task, timeout=2.0)


def test_worker_webhook_drain_uses_singleton() -> None:
    """Per-tick ``WebhookDeliveryService()`` orphans in-flight tasks."""
    from eden.workers import main as worker_main

    src = inspect.getsource(worker_main)
    assert "get_webhook_delivery_service" in src
    # Leader path must not construct a throwaway instance each tick.
    leader_src = inspect.getsource(worker_main._leader_webhook_drain_loop)
    assert "get_webhook_delivery_service" in leader_src
    assert "WebhookDeliveryService()" not in leader_src


# ── worker_loops_running: real liveness signal (F84 self-obs fix) ──


def test_worker_loops_running_none_when_never_hosted() -> None:
    """Empty ``_loop_tasks`` (e.g. this is the API process, which never
    calls ``_run_forever``) must report ``None`` — "unknown", not
    "not running" — so callers know to fall back to another signal."""
    from eden.workers import main as worker_main

    worker_main._loop_tasks.clear()
    try:
        assert worker_main.worker_loops_running() is None
    finally:
        worker_main._loop_tasks.clear()


@pytest.mark.asyncio
async def test_worker_loops_running_true_while_all_tasks_alive() -> None:
    from eden.workers import main as worker_main

    stop = asyncio.Event()

    async def _never_ending() -> None:
        await stop.wait()

    task_a = asyncio.create_task(_never_ending())
    task_b = asyncio.create_task(_never_ending())
    worker_main._loop_tasks.clear()
    worker_main._loop_tasks["loop_a"] = task_a
    worker_main._loop_tasks["loop_b"] = task_b
    try:
        assert worker_main.worker_loops_running() is True
    finally:
        stop.set()
        await asyncio.gather(task_a, task_b)
        worker_main._loop_tasks.clear()


@pytest.mark.asyncio
async def test_worker_loops_running_false_when_one_task_has_died() -> None:
    """One hosted loop's task completing (crash escaping the supervisor,
    or a stop) while others are still alive must flip this False — this
    is the real signal that replaces the always-False API flag."""
    from eden.workers import main as worker_main

    stop = asyncio.Event()

    async def _never_ending() -> None:
        await stop.wait()

    alive_task = asyncio.create_task(_never_ending())
    dead_task = asyncio.create_task(asyncio.sleep(0))
    await asyncio.sleep(0.01)
    assert dead_task.done()

    worker_main._loop_tasks.clear()
    worker_main._loop_tasks["alive"] = alive_task
    worker_main._loop_tasks["dead"] = dead_task
    try:
        assert worker_main.worker_loops_running() is False
    finally:
        stop.set()
        await alive_task
        worker_main._loop_tasks.clear()


@pytest.mark.asyncio
async def test_run_forever_populates_and_clears_loop_tasks() -> None:
    """``_run_forever`` must expose its hosted tasks to
    ``worker_loops_running()`` while running, and clear them on a clean
    drain (reverting to "never hosted" rather than a stale False)."""
    from eden.workers import main as worker_main

    stop_holder: list[asyncio.Event] = []

    async def _fake_start() -> None:
        return None

    async def _fake_stop() -> None:
        return None

    async def _noop_supervise(
        name: str,
        factory: Any,
        stop: asyncio.Event,
        *,
        backoff: float = 5.0,
    ) -> None:
        await stop.wait()

    def _capture_handlers(stop: asyncio.Event) -> None:
        stop_holder.append(stop)

    worker_main._loop_tasks.clear()
    with patch.object(
        worker_main, "_start_sidecar_workers", _fake_start
    ), patch.object(
        worker_main, "_stop_sidecar_workers", _fake_stop
    ), patch.object(
        worker_main, "_supervise", _noop_supervise
    ), patch.object(
        worker_main, "_install_signal_handlers", _capture_handlers
    ):
        task = asyncio.create_task(worker_main._run_forever())
        for _ in range(50):
            if stop_holder:
                break
            await asyncio.sleep(0.01)

        assert worker_main.worker_loops_running() is True

        stop_holder[0].set()
        await asyncio.wait_for(task, timeout=2.0)

    assert worker_main.worker_loops_running() is None


# ── Insights watermark hold on persist failure ──────────────────────


@pytest.mark.asyncio
async def test_insights_holds_watermark_when_persist_fails() -> None:
    """Failed persists must not advance the watermark (retry next tick)."""
    from eden.insights import detector_loop as loop_module

    tenant = "org-w8"
    run_id = uuid4()
    row = {
        "judge_run_id": run_id,
        "judge_name": "hallucination",
        "judge_version": "1",
        "trace_id": "tr_1",
        "span_id": "sp_1",
        "score": 0.1,
        "rationale": "bad",
        "model": "m",
        "scored_at": None,
        "latency_ms": 1,
        "tenant_id": tenant,
    }

    mock_pg = AsyncMock()

    async def _fetch(query: str, *args: Any) -> list[Any]:
        if "DISTINCT j.tenant_id" in query:
            return [{"tenant_id": tenant}]
        return [row]

    mock_pg.fetch = AsyncMock(side_effect=_fetch)
    mock_pg.fetchrow = AsyncMock(return_value=None)
    mock_pg.execute = AsyncMock(return_value="OK")

    service = MagicMock()
    service.persist_insight_to_postgres = AsyncMock(
        side_effect=RuntimeError("db write failed")
    )

    with patch(
        "eden.insights.detector_loop.get_postgres_client",
        AsyncMock(return_value=mock_pg),
    ), patch(
        "eden.insights.insights_service.InsightsService",
        return_value=service,
    ):
        loop = loop_module.InsightsDetectorLoop(batch_size=10)
        result = await loop.tick_once()

    assert result == {tenant: 0}
    watermark_writes = [
        c
        for c in mock_pg.execute.await_args_list
        if "judge_scores_processed" in str(c.args[0])
    ]
    assert watermark_writes == []
