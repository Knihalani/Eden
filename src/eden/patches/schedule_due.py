"""Cheap due-check for the recurring optimization schedule.

``cron_tick`` runs every 5 minutes; this module decides whether an org's
scheduled improvement agent should fire on *this* tick. The check is
pure (no I/O) so it is safe to call for every org on every tick.

Schedule values (from ``code_change_policy.optimization_schedule``):

* ``off`` — never
* ``daily`` — once per day at ``optimization_hour_utc``
* ``weekly`` — once per week on ``optimization_weekday`` (0=Mon) at hour
* ``biweekly`` — every 14 days on the configured weekday at hour
* ``monthly`` — on ``optimization_day_of_month`` at hour, ≥28d since last

The hour window matches ``cron_tick``'s existing daily/weekly jobs:
``minute < minute_window`` (default 10) so a ``*/5`` cron fires at most
twice in the target hour, and ``last_optimization_run_at`` suppresses the
second tick.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

_VALID_SCHEDULES = frozenset(
    {"off", "daily", "weekly", "biweekly", "monthly"}
)

# Minimum elapsed days before a schedule can re-fire.
_INTERVAL_DAYS: dict[str, int] = {
    "daily": 1,
    "weekly": 7,
    "biweekly": 14,
    "monthly": 28,
}


def _parse_dt(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def is_optimization_due(
    policy: dict[str, Any] | None,
    *,
    now: datetime | None = None,
    last_run_at: datetime | str | None = None,
    minute_window: int = 10,
) -> bool:
    """Return True when the org's scheduled optimization should run.

    Args:
        policy: Merged ``code_change_policy`` (defaults applied by caller).
        now: Clock override for tests (UTC).
        last_run_at: Explicit last-run stamp; falls back to
            ``policy['last_optimization_run_at']``.
        minute_window: Only fire when ``now.minute < minute_window``.
    """
    policy = policy or {}
    schedule = str(policy.get("optimization_schedule") or "weekly").lower()
    if schedule == "off" or schedule not in _VALID_SCHEDULES:
        return False

    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    else:
        now = now.astimezone(UTC)

    try:
        hour = int(policy.get("optimization_hour_utc", 9))
    except (TypeError, ValueError):
        hour = 9
    if now.hour != hour or now.minute >= int(minute_window):
        return False

    if schedule in ("weekly", "biweekly"):
        try:
            weekday = int(policy.get("optimization_weekday", 0))
        except (TypeError, ValueError):
            weekday = 0
        if now.weekday() != weekday:
            return False
    elif schedule == "monthly":
        try:
            day = int(policy.get("optimization_day_of_month", 1))
        except (TypeError, ValueError):
            day = 1
        # Clamp invalid day to 1 so a bad policy never permanently blocks.
        day = max(1, min(day, 28))
        if now.day != day:
            return False

    if last_run_at is None:
        last_run_at = policy.get("last_optimization_run_at")
    last = _parse_dt(last_run_at)
    if last is None:
        return True

    interval_days = _INTERVAL_DAYS[schedule]
    elapsed_s = (now - last).total_seconds()
    return elapsed_s >= interval_days * 86400


def schedule_interval_days(schedule: str) -> int | None:
    """Return the minimum interval in days, or None for ``off``/unknown."""
    return _INTERVAL_DAYS.get(str(schedule or "").lower())
