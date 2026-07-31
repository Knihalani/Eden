"""A single "refused with no holder" reading must not elect a second leader.

The Postgres fallback exists because a Redis past its plan limit accepts the
``SET NX`` and discards it, so every replica reads "refused" and the whole
background fleet goes quiet -- for 7.4 days, in production. Detecting that by
asking "was the lock refused while nobody held it?" is right, but acting on one
sample is not:

    t=0.000  replica B: SET NX  -> refused (A holds the lock)
    t=0.001  replica A's key expires
    t=0.002  replica B: GET     -> no holder
    t=0.003  replica B elects via Postgres and starts work
             ...while A's work() call is still running, because A only learns
             it lost the lock at its next renewal.

Two live leaders, which is the one outcome this module exists to prevent.

The fix confirms a no-holder reading by retrying the Redis acquire, which
separates the two hypotheses inside a single tick:

* retry succeeds  -> the old holder had merely expired; lead via Redis
* retry refused and still unheld -> contention cannot explain it; Postgres

These tests pin all three branches, plus the probe gating that keeps a
follower from spending a Redis read on every tick of ordinary contention.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.workers import leader as leader_mod
from eden.workers.leader import (
    _acquire_with_fallback,
    leader_pg_fallback_elections,
    reset_leader_failure_counts,
)


@pytest.fixture(autouse=True)
def _clean() -> Any:
    reset_leader_failure_counts()
    yield
    reset_leader_failure_counts()


class _FakeLock:
    """Scripted Redis lock.

    ``acquire_results`` and ``holder_results`` are consumed in order; the last
    value repeats once exhausted so a test only scripts what it cares about.
    """

    def __init__(
        self,
        acquire_results: list[bool],
        holder_results: list[str | None],
        *,
        name: str = "lk",
    ) -> None:
        self.name = name
        self.ttl = 60
        self._acquire = list(acquire_results)
        self._holder = list(holder_results)
        self.acquire_calls = 0
        self.holder_calls = 0

    async def acquire(self, token: str | None = None) -> bool:
        self.acquire_calls += 1
        return self._acquire.pop(0) if len(self._acquire) > 1 else self._acquire[0]

    async def holder(self) -> str | None:
        self.holder_calls += 1
        return self._holder.pop(0) if len(self._holder) > 1 else self._holder[0]

    async def holder_state(self) -> str:
        """Three states: a failed read must not read as "nobody holds it"."""
        value = await self.holder()
        if value == "__unknown__":
            return "unknown"
        return "held" if value else "unheld"


@pytest.fixture
def pg_lease(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Stub the Postgres lease.

    ``_acquire_with_fallback`` does ``from eden.storage import pg_lease``
    inside the function, which resolves the *attribute* on the already-imported
    ``eden.storage`` package -- patching ``sys.modules`` alone does not
    intercept it. Patch ``pg_lease.acquire`` itself.
    """
    from eden.storage import pg_lease as real

    class _Lease:
        granted = True
        calls: list[tuple[str, str, int]] = []

    async def _acquire(name: str, identity: str, ttl: int) -> bool:
        _Lease.calls.append((name, identity, ttl))
        return _Lease.granted

    monkeypatch.setattr(real, "acquire", _acquire)
    return _Lease


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_redis_acquire_wins_without_probing(self) -> None:
        lock = _FakeLock([True], [None])
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (True, "redis")
        assert lock.holder_calls == 0, "no probe needed when we won"


class TestProbeGating:
    @pytest.mark.asyncio
    async def test_first_refusal_does_not_probe(self) -> None:
        """A read per tick of ordinary contention spends the quota we are short of."""
        lock = _FakeLock([False], ["someone-else"])
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (False, "none")
        assert lock.holder_calls == 0

    @pytest.mark.asyncio
    async def test_second_consecutive_refusal_probes(self) -> None:
        lock = _FakeLock([False], ["someone-else"])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        await _acquire_with_fallback(lock, "lk", "me", 60)
        assert lock.holder_calls == 1

    @pytest.mark.asyncio
    async def test_a_successful_acquire_resets_the_streak(self) -> None:
        lock = _FakeLock([False, True, False], ["someone-else"])
        await _acquire_with_fallback(lock, "lk", "me", 60)  # refused (1)
        await _acquire_with_fallback(lock, "lk", "me", 60)  # acquired -> reset
        await _acquire_with_fallback(lock, "lk", "me", 60)  # refused (1 again)
        assert lock.holder_calls == 0, "streak was not reset by the win"

    @pytest.mark.asyncio
    async def test_streaks_are_tracked_per_lock(self) -> None:
        a = _FakeLock([False], ["holder"], name="a")
        b = _FakeLock([False], ["holder"], name="b")
        await _acquire_with_fallback(a, "a", "me", 60)
        await _acquire_with_fallback(b, "b", "me", 60)
        assert a.holder_calls == 0 and b.holder_calls == 0, (
            "one lock's refusal advanced another lock's streak"
        )


class TestGenuineContention:
    @pytest.mark.asyncio
    async def test_a_visible_holder_keeps_us_a_follower(self, pg_lease: Any) -> None:
        lock = _FakeLock([False], ["replica-a"])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (False, "none")
        assert pg_lease.calls == [], "elected via Postgres against a live holder"


class TestSplitBrainWindow:
    """The regression: one no-holder sample must not elect."""

    @pytest.mark.asyncio
    async def test_expired_holder_is_retried_on_redis_not_escalated(
        self, pg_lease: Any
    ) -> None:
        """refused -> no holder -> retry succeeds. Ordinary failover."""
        lock = _FakeLock([False, False, True], [None])
        await _acquire_with_fallback(lock, "lk", "me", 60)  # arm the streak
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)

        assert (got, backend) == (True, "redis"), (
            "an expired holder should be reacquired on Redis, not escalated"
        )
        assert pg_lease.calls == [], "Postgres was used for ordinary failover"

    @pytest.mark.asyncio
    async def test_holder_appearing_between_attempts_blocks_the_fallback(
        self, pg_lease: Any
    ) -> None:
        """Another replica legitimately takes the lock mid-sequence."""
        # The first call never probes (it only arms the streak), so the two
        # scripted holder reads are the pre-retry and post-retry probes of the
        # second call: unheld, then taken by another replica.
        lock = _FakeLock([False], [None, "replica-c"])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (False, "none")
        assert pg_lease.calls == [], (
            "elected via Postgres while another replica held the Redis lock"
        )

    @pytest.mark.asyncio
    async def test_two_refusals_with_no_holder_elects_via_postgres(
        self, pg_lease: Any
    ) -> None:
        """The signature contention cannot explain -- this must still work."""
        lock = _FakeLock([False], [None])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)

        assert (got, backend) == (True, "postgres")
        assert pg_lease.calls == [("lk", "me", 60)]
        assert lock.acquire_calls >= 3, "the no-holder reading was not retried"
        assert lock.holder_calls >= 2, "the second holder check was skipped"

    @pytest.mark.asyncio
    async def test_postgres_refusal_leaves_us_a_follower(self, pg_lease: Any) -> None:
        pg_lease.granted = False
        lock = _FakeLock([False], [None])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (False, "none")


class TestObservability:
    @pytest.mark.asyncio
    async def test_confirmed_elections_are_counted(self, pg_lease: Any) -> None:
        """Nothing else reports a Redis that drops writes; from Redis's own
        point of view every command succeeded."""
        lock = _FakeLock([False], [None])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        await _acquire_with_fallback(lock, "lk", "me", 60)
        assert leader_pg_fallback_elections() == {"lk": 1}

    @pytest.mark.asyncio
    async def test_ordinary_contention_is_not_counted(self, pg_lease: Any) -> None:
        lock = _FakeLock([False], ["replica-a"])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        await _acquire_with_fallback(lock, "lk", "me", 60)
        assert leader_pg_fallback_elections() == {}

    @pytest.mark.asyncio
    async def test_reset_clears_the_new_counters(self, pg_lease: Any) -> None:
        lock = _FakeLock([False], [None])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        await _acquire_with_fallback(lock, "lk", "me", 60)
        assert leader_pg_fallback_elections()
        reset_leader_failure_counts()
        assert leader_pg_fallback_elections() == {}
        assert leader_mod._consecutive_refusals == {}


class TestFailuresDoNotEscalate:
    @pytest.mark.asyncio
    async def test_an_acquire_that_raises_is_treated_as_refused(
        self, pg_lease: Any
    ) -> None:
        class _Raising(_FakeLock):
            async def acquire(self, token: str | None = None) -> bool:
                self.acquire_calls += 1
                raise RuntimeError("connection reset")

        lock = _Raising([False], ["replica-a"])
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (False, "none")

    @pytest.mark.asyncio
    async def test_a_holder_probe_that_raises_does_not_escalate(
        self, pg_lease: Any
    ) -> None:
        """A failed read is "unknown", never "unheld".

        This test previously asserted the opposite -- that a raising probe read
        as no-holder and escalated to Postgres. That was the bug: a replica
        whose *own* Redis access is broken (bad URL, exhausted pool, DNS
        failure, one-sided partition) sees refused-and-no-holder for a purely
        local reason, and the acquire retry fails for that same reason, so it is
        not independent confirmation. Escalating there runs the loop on two
        replicas at once.
        """

        class _RaisingHolder(_FakeLock):
            async def holder_state(self) -> str:
                self.holder_calls += 1
                raise RuntimeError("timeout")

        lock = _RaisingHolder([False], [None])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (False, "none")
        assert pg_lease.calls == [], (
            "elected via Postgres on a probe that never actually read Redis"
        )

    @pytest.mark.asyncio
    async def test_unknown_holder_state_does_not_escalate(
        self, pg_lease: Any
    ) -> None:
        """The same thing via the explicit sentinel rather than an exception."""
        lock = _FakeLock([False], ["__unknown__"])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (False, "none")
        assert pg_lease.calls == []

    @pytest.mark.asyncio
    async def test_unknown_on_the_second_probe_also_blocks(
        self, pg_lease: Any
    ) -> None:
        """First probe clean, retry refused, second probe fails -> no escalation."""
        lock = _FakeLock([False], [None, "__unknown__"])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (False, "none")
        assert pg_lease.calls == []


class TestFallbackKeepsFullCadence:
    """Once on the fallback, lead on every tick — not alternate ticks.

    The refusal gate was consumed on the electing tick too, so the next tick
    took the ``refusals < 2`` early return and reported follower. The loop
    therefore ran at half its configured cadence for the whole outage: the
    3600s artifact-demotion loop would have run every two hours.
    """

    @pytest.mark.asyncio
    async def test_consecutive_ticks_both_elect(self, pg_lease: Any) -> None:
        lock = _FakeLock([False], [None])
        await _acquire_with_fallback(lock, "lk", "me", 60)  # arm
        first = await _acquire_with_fallback(lock, "lk", "me", 60)
        second = await _acquire_with_fallback(lock, "lk", "me", 60)
        third = await _acquire_with_fallback(lock, "lk", "me", 60)

        assert first == (True, "postgres")
        assert second == (True, "postgres"), (
            "the tick after electing came back a follower — the loop is running "
            "at half cadence for the duration of the outage"
        )
        assert third == (True, "postgres")

    @pytest.mark.asyncio
    async def test_redis_recovery_leaves_the_fallback(self, pg_lease: Any) -> None:
        lock = _FakeLock([False, False, False, False, True], [None])
        await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (await _acquire_with_fallback(lock, "lk", "me", 60))[1] == "postgres"
        got, backend = await _acquire_with_fallback(lock, "lk", "me", 60)
        assert (got, backend) == (True, "redis")
        assert "lk" not in leader_mod.leader_pg_fallback_locks()
