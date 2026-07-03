"""Regression test for the invitation_service._as_utc helper.

asyncpg returns TIMESTAMPTZ columns as naive ``datetime`` objects
when the server's ``TimeZone`` setting is ``UTC`` — even though the
column carries timezone info on the wire. Comparing those naive
values against ``datetime.now(UTC)`` raises ``TypeError: can't
compare offset-naive and offset-aware datetimes`` and 500s the
request. The invitation accept / decline / fetch paths all hit this
exact line, so the regression surfaced across three tests in one
test run (see ``tests/integration/test_orgs.py::TestAcceptInviteClerkSync``).
"""

from datetime import datetime, timedelta, UTC

from eden.services.invitation_service import _as_utc


class TestAsUtc:
    def test_naive_datetime_gets_utc_tz(self):
        naive = datetime(2026, 1, 1, 12, 0, 0)
        result = _as_utc(naive)
        assert result.tzinfo is UTC
        assert result.year == 2026 and result.month == 1 and result.day == 1

    def test_aware_datetime_passes_through_unchanged(self):
        aware = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
        result = _as_utc(aware)
        assert result is aware  # identity preserved

    def test_aware_non_utc_preserves_offset(self):
        # If a future migration changes the column timezone, _as_utc
        # should NOT silently strip the original offset. Identity
        # preservation is the contract.
        from datetime import timezone

        plus5 = timezone(timedelta(hours=5))
        aware = datetime(2026, 1, 1, 12, 0, 0, tzinfo=plus5)
        result = _as_utc(aware)
        assert result is aware
        assert result.utcoffset() == timedelta(hours=5)

    def test_comparable_to_datetime_now_utc(self):
        # The bug it fixes: a naive DB value used to crash when
        # compared against an aware datetime.now(UTC). After _as_utc,
        # the comparison must work in both directions without raising.
        naive_db_value = datetime(2026, 1, 1, 12, 0, 0)
        normalized = _as_utc(naive_db_value)
        now = datetime.now(UTC)
        # Should not raise TypeError.
        assert normalized < now or normalized >= now
