"""Shared empty-poll cooldown helpers for Neon scale-to-zero.

Worker loops that poll Postgres on a fixed cadence (verify, insights,
EQL, webhooks) must skip PG after an empty claim so the fleet can
clear Neon's ``suspend_timeout`` (~300s). Callers set a cooldown after
zero-row results and clear it when they enqueue new work.

Two properties matter, and only the first is obvious.

**The cooldown must exceed the suspend window.** A 180s backoff against
a 300s autosuspend can never let the compute idle.

**Every poller must observe it at the same instants.** This is the part
that silently defeats the first. Independent pollers each backing off
for T seconds still reach Postgres at staggered times, because each one
starts its own timer whenever *it* happens to find an empty queue. With
K pollers on a T-second backoff at drifting phases, the longest
DB-quiet window collapses to roughly T/K — which is how a fleet of
300s backoffs pins a 300s autosuspend awake indefinitely. Quantising
every deadline onto one shared wall-clock grid makes the pollers wake
together, so the quiet window is T minus the work, not T/K. The grid is
wall-clock derived, so it holds across processes and replicas with no
coordination between them.

Because the grid is shared, raising any single loop's interval no longer
helps on its own — set the intervals to a common period so they land on
the same boundaries.
"""

from __future__ import annotations

import math
import time
from typing import Callable

# Floor for any cooldown period. Also the floor for the alignment grid,
# so a misconfigured near-zero setting cannot produce a busy loop.
MIN_COOLDOWN_SECONDS = 30.0


def aligned_deadline(
    period_s: float,
    *,
    now_wall: float | None = None,
    now_mono: float | None = None,
) -> float:
    """Monotonic deadline quantised to a shared wall-clock grid.

    Returns a ``time.monotonic()``-comparable deadline landing on the next
    ``period_s`` boundary that is at least one full period away, so the
    wait is always in ``(period, 2 * period]``. Every caller using the
    same period converges on the same boundaries regardless of when each
    one started backing off.

    The deadline is returned in monotonic time so the comparison is immune
    to wall-clock jumps (NTP, DST); only the *grid* is wall-clock derived,
    and a jump there costs at most one extra poll.
    """
    period = max(MIN_COOLDOWN_SECONDS, float(period_s))
    wall = time.time() if now_wall is None else now_wall
    mono = time.monotonic() if now_mono is None else now_mono
    # floor(wall/period) is the grid point at or before now; +2 guarantees a
    # target strictly more than one full period out, so we never schedule a
    # near-instant wake when marking empty just before a boundary.
    target_wall = (math.floor(wall / period) + 2.0) * period
    return mono + (target_wall - wall)


def next_grid_delay(
    period_s: float,
    *,
    min_fraction: float = 0.25,
    now_wall: float | None = None,
) -> float:
    """Seconds until the next shared grid boundary, for *periodic* loops.

    :func:`aligned_deadline` is for back-off after an empty poll and always
    waits at least a full period. A loop that runs on a fixed cadence wants
    the *next* boundary instead, so its average cadence stays near the
    configured interval while still only ever firing on grid points.

    ``min_fraction`` skips a boundary that is imminent, so a tick finishing
    just before one does not immediately fire again.
    """
    period = max(MIN_COOLDOWN_SECONDS, float(period_s))
    wall = time.time() if now_wall is None else now_wall
    delay = period - (wall % period)
    if delay < period * min_fraction:
        delay += period
    return delay


def make_empty_cooldown(
    *,
    default_seconds: float,
    settings_attr: str,
) -> tuple[Callable[..., bool], Callable[..., None], Callable[..., None]]:
    """Return ``(in_cooldown, mark_empty, clear)`` closures sharing state."""

    until = 0.0

    def _cooldown_s() -> float:
        try:
            from eden.config import get_settings

            return float(getattr(get_settings(), settings_attr, default_seconds) or default_seconds)
        except Exception:
            return default_seconds

    def in_cooldown() -> bool:
        return time.monotonic() < until

    def mark_empty(cap_seconds: float | None = None) -> None:
        """Back off to the next shared boundary, or to ``cap_seconds``.

        ``cap_seconds`` is for queues that are empty *now* but have known
        future work — a retry scheduled 25s out, say. Without it the poller
        would sleep past the due time to the next boundary and stall the
        retry. Capping keeps scheduled work punctual while still letting a
        genuinely idle queue reach the aligned boundary.
        """
        nonlocal until
        deadline = aligned_deadline(_cooldown_s())
        if cap_seconds is not None:
            deadline = min(deadline, time.monotonic() + max(0.0, float(cap_seconds)))
        until = deadline

    def clear() -> None:
        nonlocal until
        until = 0.0

    return in_cooldown, mark_empty, clear
