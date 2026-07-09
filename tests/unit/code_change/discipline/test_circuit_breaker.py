"""Tests for the CircuitBreaker."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.code_change.discipline.circuit_breaker import (
    DEFAULT_BREAKER_POLICY,
    CircuitBreaker,
    Record,
)


class TestCircuitBreakerClosed:
    """A fresh breaker is closed and allows PRs."""

    @pytest.mark.asyncio
    async def test_fresh_allows(self):
        breaker = CircuitBreaker(breaker_name="test_breaker")
        # No DB connection in tests — the breaker fails
        # open (returns True). We assert that the
        # default-state allow path works.
        allowed = await breaker.should_allow("org_test")
        assert allowed is True


class TestCircuitBreakerPolicy:
    """Per-org policy overrides are echoed in :meth:`status`."""

    def test_default_policy_echoed(self):
        breaker = CircuitBreaker(breaker_name="x")
        assert breaker.policy["failure_threshold"] == 5
        assert breaker.policy["window_seconds"] == 3600

    def test_custom_policy_overrides(self):
        breaker = CircuitBreaker(
            breaker_name="x",
            policy={
                "failure_threshold": 2,
                "cooldown_seconds": 60,
            },
        )
        assert breaker.policy["failure_threshold"] == 2
        assert breaker.policy["cooldown_seconds"] == 60
        # Untouched fields fall back to defaults.
        assert breaker.policy["window_seconds"] == 3600


class TestRecordDataclass:
    """The :class:`Record` dataclass carries the persisted state."""

    def test_default_state(self):
        record = Record()
        assert record.state == "closed"
        assert record.failure_count == 0
        assert record.rejection_count == 0

    def test_state_assignment(self):
        record = Record(state="open", failure_count=5)
        assert record.state == "open"
        assert record.failure_count == 5


class TestCooldownMath:
    """Internal cooldown math is correct without DB access."""

    def test_cooldown_elapsed_no_opened_at(self):
        breaker = CircuitBreaker(breaker_name="x")
        record = Record(state="open")
        assert breaker._cooldown_elapsed(record) is True

    def test_cooldown_elapsed_state_not_open(self):
        breaker = CircuitBreaker(breaker_name="x")
        record = Record(state="closed")
        assert breaker._cooldown_elapsed(record) is True


class TestWindowExpiry:
    """Internal window-expiry math is correct without DB access."""

    def test_window_expires_empty_started_at(self):
        breaker = CircuitBreaker(breaker_name="x")
        record = Record()
        out = breaker._maybe_expire_window(record)
        assert out.state == "closed"

    def test_window_expires_old_started_at(self):
        from datetime import UTC, datetime, timedelta
        breaker = CircuitBreaker(
            breaker_name="x",
            policy={"window_seconds": 60},
        )
        record = Record(
            state="closed",
            failure_count=4,
            window_started_at=(
                datetime.now(UTC) - timedelta(seconds=120)
            ).isoformat(),
        )
        out = breaker._maybe_expire_window(record)
        # Failure count was reset because the window expired.
        assert out.failure_count == 0


def test_default_policy_keys():
    """The default policy covers the four required knobs."""
    assert "failure_threshold" in DEFAULT_BREAKER_POLICY
    assert "window_seconds" in DEFAULT_BREAKER_POLICY
    assert "cooldown_seconds" in DEFAULT_BREAKER_POLICY
    assert "min_rejections_to_trip" in DEFAULT_BREAKER_POLICY


class TestF45CircuitBreakerAtomicRecordOutcome:
    """F45 regression tests for ``record_outcome`` TOCTOU race.

    Pre-fix, ``record_outcome`` did:

        record = await self._read(org_id)
        record.failure_count += 1   # Python-side mutation
        await self._write(org_id, record)  # unconditional UPDATE

    N concurrent ``record_outcome("failure")`` calls would all
    read the same ``failure_count=K`` row, all bump to K+1, and
    the last ``ON CONFLICT DO UPDATE`` would write K+1 — the
    other N-1 increments were silently lost. With 5 concurrent
    failures and a ``failure_threshold=5`` policy, the breaker
    would never trip because the final stored value is 1
    instead of 5.

    The fix wraps the read+mutate+write in a single
    transaction with ``SELECT ... FOR UPDATE`` so concurrent
    callers serialize on the row.
    """

    @pytest.mark.asyncio
    async def test_record_outcome_uses_for_update(self):
        """The transactional read+write must use
        ``SELECT ... FOR UPDATE`` to serialize concurrent
        callers.

        Locks in the SQL contract — a future refactor can't
        silently drop the FOR UPDATE clause and reintroduce
        the race.
        """
        from eden.code_change.discipline.circuit_breaker import (
            CircuitBreaker,
        )

        breaker = CircuitBreaker(breaker_name="test_breaker")

        captured_sqls: list[str] = []

        class _Conn:
            def transaction(self):
                cm = MagicMock()
                cm.__aenter__ = AsyncMock(return_value=self)
                cm.__aexit__ = AsyncMock(return_value=None)
                return cm

            async def fetchrow(self, sql, *args):
                captured_sqls.append(sql)
                return None  # no row yet

            async def execute(self, sql, *args):
                captured_sqls.append(sql)

        class _Client:
            def acquire(self):
                cm = MagicMock()
                cm.__aenter__ = AsyncMock(return_value=_Conn())
                cm.__aexit__ = AsyncMock(return_value=None)
                return cm

        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=_Client()),
        ):
            await breaker.record_outcome(
                "org_test", outcome="failure",
            )

        # Find the SELECT.
        selects = [s for s in captured_sqls if "SELECT" in s]
        assert len(selects) >= 1, (
            f"Expected at least one SELECT, got: {captured_sqls}"
        )
        # The transactional read must use FOR UPDATE.
        assert any(
            "FOR UPDATE" in s for s in selects
        ), (
            f"record_outcome's SELECT must use FOR UPDATE to "
            f"serialize concurrent callers; got: {selects}"
        )

