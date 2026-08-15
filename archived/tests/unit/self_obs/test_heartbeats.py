"""Regression tests — ``probe_and_record_workers`` liveness signal.

``eden.self_obs.scheduler``'s scheduled tick (the only production
caller) runs inside ``eden.workers.main`` — the dedicated
``eden-worker`` process — not the API. That process never calls
``eden.workers.background.start_background_workers()`` (called only
from the API's lifespan, gated by ``settings.run_background_workers``),
so ``background_workers_running()`` is structurally always ``False``
there. Reading that flag in the eden-worker scheduled context used to
guarantee a false "degraded" transition on the very first scheduled
tick of every deploy, one that could never resolve back to healthy —
these tests guard against that regression.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_probe_and_record_workers_healthy_via_worker_loop_liveness_even_when_api_flag_false():
    """The eden-worker scheduled context must not read the API-only flag.

    ``background_workers_running()`` is pinned to the structurally-
    always-False value it has in every real eden-worker process; the
    heartbeat must still report healthy because the real worker-loop
    liveness signal says the hosted loops are up.
    """
    from eden.self_obs import heartbeats

    with patch(
        "eden.workers.main.worker_loops_running", return_value=True
    ), patch(
        "eden.workers.background.background_workers_running",
        return_value=False,
    ), patch(
        "eden.workers.background.background_evolution_loop_running",
        return_value=False,
    ), patch(
        "eden.self_obs.heartbeats.record_heartbeat", new=AsyncMock()
    ):
        result = await heartbeats.probe_and_record_workers("org-1")

    assert result["status"] == "healthy"
    assert result["meta"]["background_workers_running"] is True
    assert result["meta"]["signal_source"] == "eden_worker_loops"


@pytest.mark.asyncio
async def test_probe_and_record_workers_degraded_when_worker_loops_actually_down():
    """A real crash must still page — the API flag must not mask it."""
    from eden.self_obs import heartbeats

    with patch(
        "eden.workers.main.worker_loops_running", return_value=False
    ), patch(
        "eden.workers.background.background_workers_running",
        return_value=True,
    ), patch(
        "eden.workers.background.background_evolution_loop_running",
        return_value=False,
    ), patch(
        "eden.self_obs.heartbeats.record_heartbeat", new=AsyncMock()
    ):
        result = await heartbeats.probe_and_record_workers("org-1")

    assert result["status"] == "degraded"
    assert result["meta"]["signal_source"] == "eden_worker_loops"


@pytest.mark.asyncio
async def test_probe_and_record_workers_falls_back_to_api_flag_outside_worker_process():
    """Outside the eden-worker process (e.g. the admin-status route on
    the API), ``worker_loops_running()`` returns ``None`` (never hosted
    here) and prior behaviour — reading the API-lifespan flag — must be
    preserved."""
    from eden.self_obs import heartbeats

    with patch(
        "eden.workers.main.worker_loops_running", return_value=None
    ), patch(
        "eden.workers.background.background_workers_running",
        return_value=True,
    ), patch(
        "eden.workers.background.background_evolution_loop_running",
        return_value=False,
    ), patch(
        "eden.self_obs.heartbeats.record_heartbeat", new=AsyncMock()
    ):
        result = await heartbeats.probe_and_record_workers("org-1")

    assert result["status"] == "healthy"
    assert result["meta"]["signal_source"] == "api_background_workers_flag"
