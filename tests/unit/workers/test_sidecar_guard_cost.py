"""The sidecar guard is held forever, so its renewal rate is a bill.

The guard is acquired once at startup and released at shutdown. Nothing
contends it, but the renewal task runs for the life of the process and
every renewal is a Lua ``EVAL`` — one Upstash command. At the original
TTL=60s / renew=20s that is 4,320 commands/day against a 10,000/day free
tier, spent on a lock with no contention.
"""

from __future__ import annotations

import contextlib

import pytest

from eden.workers import sidecars

_UPSTASH_FREE_DAILY_COMMANDS = 10_000
_SECONDS_PER_DAY = 86_400.0


def test_guard_renewal_stays_a_small_slice_of_the_daily_budget():
    ttl, renew = sidecars._guard_ttl_and_renew()
    commands_per_day = _SECONDS_PER_DAY / renew
    share = commands_per_day / _UPSTASH_FREE_DAILY_COMMANDS
    assert share < 0.10, (
        f"an uncontended guard would burn {commands_per_day:.0f} Redis "
        f"commands/day ({share:.0%} of the free tier)"
    )


def test_renew_interval_is_safely_below_the_ttl():
    """A slow tick must not be able to drop a held guard."""
    ttl, renew = sidecars._guard_ttl_and_renew()
    assert renew < ttl / 2, (
        "renew must be under TTL/2 so one missed/slow renewal cannot "
        "let the guard lapse and allow a second process to double-consume"
    )


def test_renew_is_clamped_even_when_misconfigured():
    """A bad setting must not produce a guard that outlives its renewal."""

    class _BadSettings:
        sidecar_guard_ttl_seconds = 100
        sidecar_guard_renew_seconds = 5000.0  # absurdly larger than the TTL

    import eden.config as config_module

    original = config_module.get_settings
    config_module.get_settings = lambda: _BadSettings()  # type: ignore[assignment]
    try:
        ttl, renew = sidecars._guard_ttl_and_renew()
    finally:
        config_module.get_settings = original  # type: ignore[assignment]

    assert ttl == 100
    assert renew <= ttl / 2


def test_settings_drive_the_guard_values():
    class _Settings:
        sidecar_guard_ttl_seconds = 1200
        sidecar_guard_renew_seconds = 300.0

    import eden.config as config_module

    original = config_module.get_settings
    config_module.get_settings = lambda: _Settings()  # type: ignore[assignment]
    try:
        ttl, renew = sidecars._guard_ttl_and_renew()
    finally:
        config_module.get_settings = original  # type: ignore[assignment]

    assert (ttl, renew) == (1200, 300.0)


# ── Guard retry after a lost start-up race ──────────────────────────────

@pytest.mark.asyncio
async def test_lost_guard_race_schedules_a_retry(monkeypatch):
    """Losing the guard at boot must not disable the bundle for the life
    of the process. With a 600s TTL, a hard-killed previous holder leaves
    a stale lock for ten minutes — which is what every crash and redeploy
    does — and the old code gave up after three attempts and never tried
    again, silently losing the quality pipeline, the trace_finalized
    consumer and the closed-loop consumer."""
    import asyncio as _asyncio

    from eden.workers import sidecars as sc

    monkeypatch.setattr(sc, "_guard_retry_task", None, raising=False)
    monkeypatch.setattr(sc, "_started", False, raising=False)
    monkeypatch.setattr(
        sc, "_acquire_guard", _AsyncReturn(False), raising=False
    )

    started = await sc.start_quality_and_closed_loop_sidecars("test")
    assert started is False
    try:
        assert sc._guard_retry_task is not None, (
            "no background retry scheduled — a stale guard would disable "
            "the sidecars permanently"
        )
        assert not sc._guard_retry_task.done()
    finally:
        sc._guard_retry_task.cancel()
        with contextlib.suppress(_asyncio.CancelledError, Exception):
            await sc._guard_retry_task
        sc._guard_retry_task = None


@pytest.mark.asyncio
async def test_retry_is_not_duplicated_on_repeated_calls(monkeypatch):
    import asyncio as _asyncio

    from eden.workers import sidecars as sc

    monkeypatch.setattr(sc, "_guard_retry_task", None, raising=False)
    monkeypatch.setattr(sc, "_started", False, raising=False)
    monkeypatch.setattr(
        sc, "_acquire_guard", _AsyncReturn(False), raising=False
    )

    await sc.start_quality_and_closed_loop_sidecars("test")
    first = sc._guard_retry_task
    await sc.start_quality_and_closed_loop_sidecars("test")
    try:
        assert sc._guard_retry_task is first, "spawned a second retry task"
    finally:
        sc._guard_retry_task.cancel()
        with contextlib.suppress(_asyncio.CancelledError, Exception):
            await sc._guard_retry_task
        sc._guard_retry_task = None


class _AsyncReturn:
    def __init__(self, value):
        self.value = value

    async def __call__(self, *a, **kw):
        return self.value
