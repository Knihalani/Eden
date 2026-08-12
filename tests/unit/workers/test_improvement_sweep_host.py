"""F-I (Wave 1) — the N23 recurring improvement sweep has a host.

Before this fix, ``run_due_sweeps`` (the per-org weekly-cron machinery)
had zero hosts in production: ``cron_tick`` omitted it, ``main.py`` kept
it off, and northflank pinned ``IMPROVEMENT_SCHEDULE_ENABLED=false``
("keep false until a worker Service hosts run_due_sweeps for real").

These tests pin that ``_leader_improvement_sweep`` in ``workers.main``
now hosts it: it short-circuits when the global
``improvement_schedule_enabled`` switch is off, and calls
``run_due_sweeps`` when it is on. The per-org gating (schedule cron +
watermark + agent flag) stays inside ``run_due_sweeps``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.workers import main as worker_main


@pytest.mark.asyncio
async def test_leader_improvement_sweep_skips_when_flag_off() -> None:
    """With improvement_schedule_enabled=False the tick is a no-op and
    run_due_sweeps is never called."""

    class _Settings:
        improvement_schedule_enabled = False

    captured: dict = {}

    async def _capture(name, tick, **kwargs):
        captured["tick"] = tick
        return None

    run_due = AsyncMock(return_value={"tick_at": "x", "orgs": []})

    with patch("eden.workers.leader.run_if_leader", new=_capture):
        with patch("eden.config.get_settings", return_value=_Settings()):
            await worker_main._leader_improvement_sweep(AsyncMock())
            assert "tick" in captured
            # The settings patch must stay live while the tick runs — the
            # closure reads get_settings on every invocation.
            with patch(
                "eden.improvement.schedule.run_due_sweeps", new=run_due
            ):
                await captured["tick"]()

    run_due.assert_not_awaited()


@pytest.mark.asyncio
async def test_leader_improvement_sweep_calls_run_due_sweeps_when_on() -> None:
    """With improvement_schedule_enabled=True the tick calls
    run_due_sweeps with dry_run=False."""

    class _Settings:
        improvement_schedule_enabled = True

    captured: dict = {}

    async def _capture(name, tick, **kwargs):
        captured["tick"] = tick
        return None

    run_due = AsyncMock(return_value={"tick_at": "x", "orgs": []})

    with patch("eden.workers.leader.run_if_leader", new=_capture):
        with patch("eden.config.get_settings", return_value=_Settings()):
            await worker_main._leader_improvement_sweep(AsyncMock())
    assert "tick" in captured

    with patch("eden.improvement.schedule.run_due_sweeps", new=run_due):
        await captured["tick"]()

    run_due.assert_awaited_once_with(dry_run=False)


@pytest.mark.asyncio
async def test_leader_improvement_sweep_logs_errors_and_reraises() -> None:
    """A run_due_sweeps failure is logged and re-raised so the supervisor
    retries on the next interval (mirrors the other leader loops)."""

    class _Settings:
        improvement_schedule_enabled = True

    captured: dict = {}

    async def _capture(name, tick, **kwargs):
        captured["tick"] = tick
        return None

    with patch("eden.workers.leader.run_if_leader", new=_capture):
        with patch("eden.config.get_settings", return_value=_Settings()):
            await worker_main._leader_improvement_sweep(AsyncMock())

    with patch(
        "eden.improvement.schedule.run_due_sweeps",
        new=AsyncMock(side_effect=RuntimeError("boom")),
    ):
        with patch.object(worker_main.logger, "error") as log_err:
            with pytest.raises(RuntimeError):
                await captured["tick"]()
    log_err.assert_called()
