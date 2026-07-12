"""Due-check matrix for the recurring optimization schedule."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from eden.code_change.schedule_due import (
    is_optimization_due,
    schedule_interval_days,
)


def _dt(
    *,
    year: int = 2026,
    month: int = 7,
    day: int = 13,  # Monday
    hour: int = 9,
    minute: int = 0,
) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


def _policy(**overrides: object) -> dict:
    base: dict = {
        "optimization_schedule": "weekly",
        "optimization_weekday": 0,
        "optimization_hour_utc": 9,
        "optimization_day_of_month": 1,
        "last_optimization_run_at": None,
    }
    base.update(overrides)
    return base


class TestScheduleIntervalDays:
    def test_known(self):
        assert schedule_interval_days("daily") == 1
        assert schedule_interval_days("weekly") == 7
        assert schedule_interval_days("biweekly") == 14
        assert schedule_interval_days("monthly") == 28

    def test_off_unknown(self):
        assert schedule_interval_days("off") is None
        assert schedule_interval_days("bogus") is None


class TestIsOptimizationDueOff:
    def test_off_never(self):
        assert (
            is_optimization_due(_policy(optimization_schedule="off"), now=_dt())
            is False
        )

    def test_unknown_schedule_never(self):
        assert (
            is_optimization_due(
                _policy(optimization_schedule="yearly"), now=_dt()
            )
            is False
        )


class TestHourAndMinuteWindow:
    def test_wrong_hour(self):
        assert (
            is_optimization_due(
                _policy(optimization_schedule="daily"),
                now=_dt(hour=10),
            )
            is False
        )

    def test_minute_outside_window(self):
        assert (
            is_optimization_due(
                _policy(optimization_schedule="daily"),
                now=_dt(minute=15),
            )
            is False
        )

    def test_minute_inside_window(self):
        assert (
            is_optimization_due(
                _policy(optimization_schedule="daily"),
                now=_dt(minute=5),
            )
            is True
        )


class TestDaily:
    def test_due_when_no_last_run(self):
        assert is_optimization_due(
            _policy(optimization_schedule="daily"), now=_dt()
        )

    def test_not_due_within_interval(self):
        now = _dt()
        last = now - timedelta(hours=12)
        assert (
            is_optimization_due(
                _policy(optimization_schedule="daily"),
                now=now,
                last_run_at=last,
            )
            is False
        )

    def test_due_after_interval(self):
        now = _dt()
        last = now - timedelta(hours=25)
        assert is_optimization_due(
            _policy(optimization_schedule="daily"),
            now=now,
            last_run_at=last,
        )


class TestWeekly:
    def test_wrong_weekday(self):
        # 2026-07-14 is Tuesday
        assert (
            is_optimization_due(
                _policy(optimization_schedule="weekly", optimization_weekday=0),
                now=_dt(day=14),
            )
            is False
        )

    def test_due_monday_no_last_run(self):
        assert is_optimization_due(
            _policy(optimization_schedule="weekly", optimization_weekday=0),
            now=_dt(day=13),  # Monday
        )

    def test_not_due_three_days_later(self):
        now = _dt(day=13)
        last = now - timedelta(days=3)
        assert (
            is_optimization_due(
                _policy(optimization_schedule="weekly"),
                now=now,
                last_run_at=last,
            )
            is False
        )

    def test_due_after_seven_days(self):
        now = _dt(day=13)
        last = now - timedelta(days=8)
        assert is_optimization_due(
            _policy(optimization_schedule="weekly"),
            now=now,
            last_run_at=last,
        )

    def test_policy_last_run_stamp(self):
        now = _dt(day=13)
        last = (now - timedelta(days=8)).isoformat()
        assert is_optimization_due(
            _policy(
                optimization_schedule="weekly",
                last_optimization_run_at=last,
            ),
            now=now,
        )


class TestBiweekly:
    def test_not_due_at_ten_days(self):
        now = _dt(day=13)
        last = now - timedelta(days=10)
        assert (
            is_optimization_due(
                _policy(optimization_schedule="biweekly"),
                now=now,
                last_run_at=last,
            )
            is False
        )

    def test_due_at_fifteen_days(self):
        now = _dt(day=13)
        last = now - timedelta(days=15)
        assert is_optimization_due(
            _policy(optimization_schedule="biweekly"),
            now=now,
            last_run_at=last,
        )


class TestMonthly:
    def test_wrong_day(self):
        assert (
            is_optimization_due(
                _policy(
                    optimization_schedule="monthly",
                    optimization_day_of_month=1,
                ),
                now=_dt(day=13),
            )
            is False
        )

    def test_due_on_day_no_last_run(self):
        assert is_optimization_due(
            _policy(
                optimization_schedule="monthly",
                optimization_day_of_month=1,
            ),
            now=_dt(day=1),
        )

    def test_not_due_within_twenty_days(self):
        now = _dt(day=1)
        last = now - timedelta(days=20)
        assert (
            is_optimization_due(
                _policy(optimization_schedule="monthly"),
                now=now,
                last_run_at=last,
            )
            is False
        )

    def test_due_after_twenty_eight_days(self):
        now = _dt(day=1)
        last = now - timedelta(days=35)
        assert is_optimization_due(
            _policy(optimization_schedule="monthly"),
            now=now,
            last_run_at=last,
        )


@pytest.mark.parametrize(
    "schedule,last_days,expected",
    [
        ("daily", None, True),
        ("daily", 0, False),
        ("daily", 2, True),
        ("weekly", None, True),
        ("weekly", 3, False),
        ("weekly", 8, True),
        ("biweekly", 10, False),
        ("biweekly", 15, True),
        ("monthly", 20, False),
        ("monthly", 35, True),
        ("off", None, False),
    ],
)
def test_due_matrix_parametrized(
    schedule: str, last_days: int | None, expected: bool
) -> None:
    # Anchor: Monday 2026-07-13 09:00 for weekly/biweekly;
    # day 1 for monthly.
    if schedule == "monthly":
        now = _dt(day=1)
    else:
        now = _dt(day=13)
    last = None if last_days is None else now - timedelta(days=last_days)
    assert (
        is_optimization_due(
            _policy(optimization_schedule=schedule),
            now=now,
            last_run_at=last,
        )
        is expected
    )
