"""Idle-cost hardening: every periodic loop shares one wall-clock grid.

The design constraint lives in ``eden.storage.empty_cooldown``: because the
grid is shared, a loop only helps Neon reach autosuspend if its period is a
*multiple* of the base grid period. A loop on 900s against a 600s grid
drifts across the boundaries and re-fragments the DB-quiet window even
though 900s on its own looks generous.

These tests pin that property for the loops the idle-cost audit moved onto
the grid, so a future interval tweak that takes one back off-grid fails
here instead of silently costing a Neon bill.
"""

from __future__ import annotations

import pytest

from eden.config import get_settings
from eden.storage.empty_cooldown import aligned_deadline, next_grid_delay

# Wall-clock instants spread across a grid period, including exact
# boundaries and points either side of one.
_SAMPLE_WALL_TIMES = [
    1_800_000_000.0,
    1_800_000_000.0 + 1.0,
    1_800_000_000.0 + 137.4,
    1_800_000_000.0 + 599.9,
    1_800_000_000.0 + 600.0,
    1_800_000_000.0 + 601.0,
    1_800_000_000.0 + 1199.5,
]


def _grid_period() -> float:
    return float(get_settings().idle_poll_period_seconds)


def _configured_loop_intervals() -> dict[str, float]:
    """The periodic-loop intervals that must sit on the shared grid."""
    s = get_settings()
    return {
        "idle_poll_period (maintenance)": float(s.idle_poll_period_seconds),
        "insights_loop": float(s.insights_loop_interval_seconds),
        "eql_watchdog": float(s.eql_watchdog_interval_seconds),
        "artifact_demotion": float(s.artifact_demotion_interval_seconds),
        "webhook_drain": float(s.webhook_drain_interval_seconds),
        "verify_loop": float(s.verify_loop_interval_seconds),
        "anomaly_loop": float(s.anomaly_loop_interval_seconds),
        "self_obs_probe": float(s.self_obs_probe_interval_seconds),
    }


def test_every_loop_interval_is_a_multiple_of_the_grid_period():
    period = _grid_period()
    offenders = {
        name: interval
        for name, interval in _configured_loop_intervals().items()
        if interval % period != 0
    }
    assert offenders == {}, (
        f"these intervals are not multiples of the {period}s idle grid, so "
        f"they will drift across the shared boundaries: {offenders}"
    )


@pytest.mark.parametrize("now_wall", _SAMPLE_WALL_TIMES)
def test_all_loops_wake_on_the_same_boundaries(now_wall: float):
    """Every loop's next wake must land on a base-grid boundary.

    This is the property that actually matters: not that the loops share
    an interval, but that whatever instant each one wakes at is also a
    grid point the others use, so the quiet window is the period minus
    the work rather than period/N.
    """
    period = _grid_period()
    for name, interval in _configured_loop_intervals().items():
        delay = next_grid_delay(interval, now_wall=now_wall)
        wake_at = now_wall + delay
        remainder = wake_at % period
        assert remainder == pytest.approx(0.0, abs=1e-6), (
            f"{name} (interval={interval}s) wakes at {wake_at} which is "
            f"{remainder}s off the {period}s grid"
        )


@pytest.mark.parametrize("now_wall", _SAMPLE_WALL_TIMES)
def test_empty_cooldown_deadlines_also_land_on_the_grid(now_wall: float):
    """``aligned_deadline`` (back-off path) shares the same boundaries."""
    period = _grid_period()
    now_mono = 10_000.0
    for name, interval in _configured_loop_intervals().items():
        deadline = aligned_deadline(
            interval, now_wall=now_wall, now_mono=now_mono
        )
        wake_at = now_wall + (deadline - now_mono)
        assert wake_at % period == pytest.approx(0.0, abs=1e-6), (
            f"{name} cooldown deadline is off-grid"
        )


@pytest.mark.parametrize("now_wall", _SAMPLE_WALL_TIMES)
def test_next_grid_delay_never_returns_a_busy_wait(now_wall: float):
    """A tick finishing just before a boundary must not re-fire instantly."""
    for interval in _configured_loop_intervals().values():
        delay = next_grid_delay(interval, now_wall=now_wall)
        assert delay >= interval * 0.25
        assert delay <= interval * 2.0


def test_grid_interval_helper_snaps_off_grid_overrides_back_on():
    """An ops override of, say, 900s must not silently go off-grid."""
    from eden.workers.main import _grid_interval

    period = _grid_period()
    # Unknown attribute -> falls back to the requested multiple.
    assert _grid_interval("nonexistent_setting_xyz", multiple=2.0) == period * 2

    class _FakeSettings:
        off_grid_interval = 900.0

    import eden.config as config_module

    original = config_module.get_settings
    config_module.get_settings = lambda: _FakeSettings()  # type: ignore[assignment]
    try:
        snapped = _grid_interval("off_grid_interval", multiple=2.0)
    finally:
        config_module.get_settings = original  # type: ignore[assignment]

    assert snapped % period == 0, "override was not snapped back onto the grid"
    # 900 / 600 = 1.5 -> rounds to 2 periods.
    assert snapped == period * 2
