"""A9 — bounded_create_task + quality pipeline concurrency + manifest guards."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from eden.async_tasks import (
    bounded_create_task,
    bounded_gather,
    reset_bounded_task_semaphores,
)
from eden.observability.quality_pipeline.worker import SidecarWorker

REPO_ROOT = Path(__file__).resolve().parents[2]
NORTHFLANK = REPO_ROOT / "northflank.yml"


@pytest.fixture(autouse=True)
def _clear_semaphores():
    reset_bounded_task_semaphores()
    yield
    reset_bounded_task_semaphores()


@pytest.mark.asyncio
async def test_bounded_create_task_caps_concurrency():
    """At most ``limit`` coroutines run concurrently."""
    limit = 3
    in_flight = 0
    peak = 0
    lock = asyncio.Lock()

    async def _work() -> None:
        nonlocal in_flight, peak
        async with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        await asyncio.sleep(0.05)
        async with lock:
            in_flight -= 1

    tasks = [
        bounded_create_task(_work(), name=f"t-{i}", limit=limit)
        for i in range(12)
    ]
    await asyncio.gather(*tasks)
    assert peak <= limit
    assert peak >= 1


@pytest.mark.asyncio
async def test_bounded_create_task_drops_when_queue_full():
    """Excess submissions beyond max_waiting are dropped, not queued forever."""
    started = 0
    lock = asyncio.Lock()
    gate = asyncio.Event()

    async def _work() -> str:
        nonlocal started
        async with lock:
            started += 1
        await gate.wait()
        return "ok"

    # limit=1, max_waiting=2 → at most 2 outstanding runners; rest dropped.
    tasks = [
        bounded_create_task(
            _work(), name=f"q-{i}", limit=1, max_waiting=2
        )
        for i in range(6)
    ]
    await asyncio.sleep(0.05)
    assert started <= 2
    gate.set()
    results = await asyncio.gather(*tasks)
    # Dropped tasks return None; admitted ones return "ok".
    assert results.count("ok") <= 2
    assert results.count(None) >= 4


@pytest.mark.asyncio
async def test_bounded_gather_caps_fanout():
    """bounded_gather must not run more than ``limit`` awaitables at once."""
    limit = 2
    in_flight = 0
    peak = 0
    lock = asyncio.Lock()

    async def _work(i: int) -> int:
        nonlocal in_flight, peak
        async with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        await asyncio.sleep(0.04)
        async with lock:
            in_flight -= 1
        return i

    results = await bounded_gather(
        *(_work(i) for i in range(6)),
        limit=limit,
        return_exceptions=False,
    )
    assert results == list(range(6))
    assert peak <= limit


@pytest.mark.asyncio
async def test_quality_pipeline_processes_with_semaphore_ge_8():
    """SidecarWorker processes ready traces concurrently with cap ≥8."""
    worker = SidecarWorker(concurrency=8, max_retries=1)
    seen: list[str] = []
    peak = 0
    in_flight = 0
    lock = asyncio.Lock()

    async def _fake_process(tid: str, trace_id: str, evs: list) -> None:
        nonlocal in_flight, peak
        async with lock:
            in_flight += 1
            peak = max(peak, in_flight)
            seen.append(trace_id)
        await asyncio.sleep(0.02)
        async with lock:
            in_flight -= 1

    events = []
    for i in range(16):
        tid = "org-1"
        trace = f"trace-{i}"
        events.append(
            {
                "id": f"e-{i}-a",
                "tenant_id": tid,
                "trace_id": trace,
                "event_type": "span.start",
            }
        )
        events.append(
            {
                "id": f"e-{i}-b",
                "tenant_id": tid,
                "trace_id": trace,
                "event_type": "span.end",
            }
        )

    stop = asyncio.Event()
    polled = False

    async def _poll(_since):
        nonlocal polled
        if polled:
            stop.set()
            return []
        polled = True
        return events

    with (
        patch.object(worker, "_poll_events", side_effect=_poll),
        patch.object(worker, "_process_one", side_effect=_fake_process),
        patch(
            "eden.observability.quality_pipeline.worker.load_watermark",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "eden.observability.quality_pipeline.worker.save_watermark",
            new=AsyncMock(),
        ),
    ):
        run_task = asyncio.create_task(worker.run(stop))
        # Wait until all traces processed, then stop.
        for _ in range(50):
            if len(seen) >= 16:
                break
            await asyncio.sleep(0.05)
        stop.set()
        await asyncio.wait_for(run_task, timeout=2.0)

    assert len(seen) == 16
    assert worker.concurrency >= 8
    assert peak >= 2
    assert peak <= max(8, worker.concurrency)


def test_northflank_background_fleet_is_hosted_by_the_api_service():
    """The API service hosts the background fleet.

    This is inverted from what it used to pin ("API off, worker job on"),
    and the reason matters. ``eden.workers.main`` is a daemon deployed as
    a Northflank *Job*, and jobs are for finite work: the container was
    reaped and restarted every 96-270s, so no loop ever completed a tick.
    Webhooks went undelivered, scheduled EQL alerts never fired, retention
    never ran, and nothing wrote a self-obs heartbeat for 7.4 days — while
    the job reported RUNNING and /health reported healthy.

    Flipping this back without first moving the worker to a Service (not a
    Job) silently restores that outage, so it is guarded.
    """
    text = NORTHFLANK.read_text(encoding="utf-8")
    api_part, _, _rest = text.partition("kind: Job")

    assert "name: EDEN_RUN_BACKGROUND_WORKERS" in api_part
    api_match = re.search(
        r"name:\s*EDEN_RUN_BACKGROUND_WORKERS\s*\n\s*value:\s*\"([^\"]+)\"",
        api_part,
    )
    assert api_match is not None
    assert api_match.group(1) in {"1", "true", "True"}, (
        "the API service must host the background fleet — a Job container "
        "is reaped every few minutes and never finishes a tick"
    )


def test_background_bundle_adopts_the_worker_only_loops():
    """Six loops had no home except the job. Losing them is invisible.

    ``improvement_sweep`` joined the bundle with the Wave 1 autonomy fix —
    the recurring sweep had no hosted home (the autonomous-improvement job
    was reaped like every other Job), so its presence here is pinned.
    """
    from eden.workers.background import _leader_loops_from_worker_main

    names = {name for name, _ in _leader_loops_from_worker_main()}
    assert names == {
        "webhook_drain",
        "eql_alert_watchdog",
        "artifact_demotion",
        "maintenance",
        "self_obs_probes",
        "improvement_sweep",
    }, f"background bundle stopped hosting: {names}"


def test_config_defaults_workers_off_quality_ge_8():
    from eden.config import get_settings

    get_settings.cache_clear()
    s = get_settings()
    assert s.run_background_workers is False
    assert int(s.quality_pipeline_workers) >= 8
    assert int(s.background_task_concurrency) > 0
