"""Unit tests for N23 schedule cron matching."""

from __future__ import annotations

from datetime import UTC, datetime

from eden.improvement.schedule import cron_matches, next_run_at


def test_weekly_sunday_3am_matches() -> None:
    when = datetime(2026, 7, 12, 3, 0, tzinfo=UTC)  # Sunday, minute 0
    assert cron_matches("0 3 * * 0", when)


def test_weekly_sunday_wrong_hour_no_match() -> None:
    when = datetime(2026, 7, 12, 4, 5, tzinfo=UTC)
    assert not cron_matches("0 3 * * 0", when)


def test_next_run_at_returns_future() -> None:
    after = datetime(2026, 7, 12, 4, 0, tzinfo=UTC)
    nxt = next_run_at("0 3 * * 0", after=after)
    assert nxt is not None
    assert nxt > after
