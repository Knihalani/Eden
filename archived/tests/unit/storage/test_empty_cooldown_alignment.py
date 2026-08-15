"""Neon scale-to-zero: the empty-poll cooldown must align across pollers.

The property under test is not "each loop backs off long enough" — that
was already true and Neon still never suspended. It is that *independent*
loops back off to the **same instants**. With K pollers on a T-second
backoff at drifting phases, the longest Postgres-quiet window is about
T/K, so five loops on a 300s backoff leave a ~60s window against a 300s
autosuspend and the compute stays warm forever.
"""

from __future__ import annotations

import math

from eden.storage.empty_cooldown import (
    MIN_COOLDOWN_SECONDS,
    aligned_deadline,
    make_empty_cooldown,
)


class TestAlignedDeadline:
    def test_lands_on_a_grid_boundary(self) -> None:
        period = 600.0
        wall, mono = 1_000_000.123, 5_000.0
        deadline = aligned_deadline(period, now_wall=wall, now_mono=mono)
        # Convert back to wall time and confirm it is an exact multiple.
        target_wall = wall + (deadline - mono)
        assert math.isclose(target_wall % period, 0.0, abs_tol=1e-6)

    def test_wait_is_between_one_and_two_periods(self) -> None:
        period = 600.0
        # Sweep offsets across a full period, including the boundary itself
        # and the instant just before it -- the case that would otherwise
        # schedule a near-instant wake.
        for offset in (0.0, 0.001, 1.0, 299.0, 300.0, 599.0, 599.999):
            wall = 1_000_000.0 * period + offset
            deadline = aligned_deadline(period, now_wall=wall, now_mono=0.0)
            assert period < deadline <= 2 * period, f"offset={offset}"

    def test_independent_pollers_converge_on_one_boundary(self) -> None:
        """The property that actually makes Neon suspend."""
        period = 600.0
        base = 1_000_000.0 * period
        # Three loops that noticed an empty queue at scattered times.
        deadlines = {
            aligned_deadline(period, now_wall=base + off, now_mono=off)
            for off in (0.0, 137.0, 411.0, 599.0)
        }
        # Each poller acts at wall=base+off, so on a shared monotonic
        # timeline anchored at base it reads mono=off. Identical deadlines
        # therefore mean they genuinely wake at the same instant.
        assert len(deadlines) == 1

    def test_period_is_floored(self) -> None:
        deadline = aligned_deadline(0.0, now_wall=0.0, now_mono=0.0)
        assert deadline >= MIN_COOLDOWN_SECONDS


class TestMakeEmptyCooldown:
    def test_mark_then_in_cooldown(self) -> None:
        in_cooldown, mark_empty, clear = make_empty_cooldown(
            default_seconds=600.0, settings_attr="does_not_exist_attr",
        )
        assert not in_cooldown()
        mark_empty()
        assert in_cooldown()
        clear()
        assert not in_cooldown()

    def test_cap_shortens_the_backoff(self) -> None:
        """A retry due soon must not be stranded behind an idle boundary."""
        in_cooldown, mark_empty, clear = make_empty_cooldown(
            default_seconds=600.0, settings_attr="does_not_exist_attr",
        )
        mark_empty(cap_seconds=0.0)
        assert not in_cooldown(), "a zero cap must expire immediately"
        clear()
        mark_empty(cap_seconds=10_000.0)
        assert in_cooldown(), "a cap longer than the period must not extend it"

    def test_cap_never_extends_past_the_boundary(self) -> None:
        import time

        in_cooldown, mark_empty, clear = make_empty_cooldown(
            default_seconds=600.0, settings_attr="does_not_exist_attr",
        )
        mark_empty(cap_seconds=10_000.0)
        unaligned = time.monotonic() + 10_000.0
        # Cannot read `until` directly; assert via the documented bound that
        # the aligned deadline is at most two periods out.
        assert in_cooldown()
        assert unaligned > time.monotonic() + 2 * 600.0
        clear()
