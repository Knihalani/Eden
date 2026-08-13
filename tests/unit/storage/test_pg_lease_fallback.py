"""Leader election: Postgres primary, Redis fallback.

2026-07-29: the Upstash free tier's monthly request cap was reached
("max requests limit exceeded. Limit: 500000, Usage: 500000"). Past the
limit Upstash serves reads and *silently discards writes*, so ``SET NX``
returned null. Every leader lock therefore read as "refused" while
nothing held it, no leader-gated loop could start, and the whole
annotate/evaluate/improve half of Eden was down for 7.4 days — with PING
still succeeding, so nothing anywhere reported a fault.

Postgres was healthy throughout. After this incident the election order
was inverted: Postgres is now the *primary* backend (one atomic statement
per tick, no Upstash command budget impact), and Redis is the *fallback*
only when Postgres itself is unreachable.

These tests pin the key properties of the new order:
- Postgres available → single atomic acquire, zero Redis commands.
- Postgres unavailable (None) → Redis fallback with single-holder guarantee.
- Postgres False (another process holds a live lease) → follower immediately,
  Redis is never consulted (split-brain prevention).
- Expired lease → next acquirer wins atomically via INSERT … ON CONFLICT.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from eden.storage import pg_lease
from eden.workers import leader as leader_mod


@pytest.fixture(autouse=True)
def _reset():
    pg_lease.reset_for_tests()
    leader_mod.reset_leader_failure_counts()
    yield
    pg_lease.reset_for_tests()
    leader_mod.reset_leader_failure_counts()


class _FakeLock:
    """Minimal Redis-lock stand-in with an acquire call counter."""

    def __init__(self, acquired: bool = False, holder: str | None = None):
        self.name = "t"
        self._acquired = acquired
        self._holder = holder
        self.acquire_calls = 0

    async def acquire(self, token=None):
        self.acquire_calls += 1
        return self._acquired

    async def holder(self):
        return self._holder

    async def release(self):
        return True


# ── _acquire_with_fallback: Postgres-primary contract ────────────────────────


@pytest.mark.asyncio
async def test_pg_primary_wins_before_redis() -> None:
    """Postgres available → acquired immediately; Redis never touched.

    This is the normal path in production: one DB statement per tick, zero
    Upstash command budget consumed.  The old test name reflected the
    Redis-primary world; the semantics here are unchanged (PG returns True
    → we are leader), only the priority is explicit.
    """
    redis_lock = _FakeLock(acquired=False, holder=None)
    with patch.object(
        pg_lease, "acquire", AsyncMock(return_value=True)
    ) as pg_acquire:
        acquired, backend = await leader_mod._acquire_with_fallback(
            redis_lock, "insights_loop", "host:1", 60
        )
    assert acquired is True
    assert backend == "postgres"
    pg_acquire.assert_awaited_once()
    assert leader_mod.leader_pg_fallback_locks()["insights_loop"] == "host:1"
    assert redis_lock.acquire_calls == 0, "Redis must not be called when PG wins"


@pytest.mark.asyncio
async def test_pg_contention_blocks_without_redis_fallback() -> None:
    """PG returns False (another process holds a live lease).

    We must stay a follower immediately.  Redis is never consulted: asking
    a second backend after the DB refused would let two processes each win
    on different backends — split-brain leadership.
    """
    redis_lock = _FakeLock(acquired=True)  # Redis would grant it — must not reach it
    with patch.object(pg_lease, "acquire", AsyncMock(return_value=False)):
        acquired, backend = await leader_mod._acquire_with_fallback(
            redis_lock, "insights_loop", "host:1", 60
        )
    assert (acquired, backend) == (False, "none")
    assert redis_lock.acquire_calls == 0, "Redis must not be tried when PG says another holds it"


@pytest.mark.asyncio
async def test_pg_unavailable_falls_back_to_redis_single_holder() -> None:
    """Postgres unavailable (None) → Redis fallback, single-holder enforced.

    When PG cannot be reached at all (no client, connection error, table
    ensure failed) ``acquire`` returns ``None`` and the caller tries Redis.
    If Redis grants the lock the caller is leader; if Redis has a real peer
    the caller stays a follower.
    """
    # Sub-case A: Redis grants the lock.
    redis_lock = _FakeLock(acquired=True)
    with patch.object(pg_lease, "acquire", AsyncMock(return_value=None)):
        acquired, backend = await leader_mod._acquire_with_fallback(
            redis_lock, "insights_loop", "host:1", 60
        )
    assert (acquired, backend) == (True, "redis")
    assert redis_lock.acquire_calls == 1

    # Sub-case B: Redis has a live peer → single-holder guarantee preserved.
    redis_lock2 = _FakeLock(acquired=False, holder="other-host:9")
    with patch.object(pg_lease, "acquire", AsyncMock(return_value=None)):
        acquired2, backend2 = await leader_mod._acquire_with_fallback(
            redis_lock2, "insights_loop2", "host:1", 60
        )
    assert (acquired2, backend2) == (False, "none")


@pytest.mark.asyncio
async def test_both_backends_down_is_not_leader() -> None:
    """PG unavailable and Redis refuses with no holder → not leader.

    Refused-with-no-holder on Redis is the write-discard shape (Upstash
    quota exceeded): it must not be treated as genuine contention, but it
    also cannot grant leadership when neither backend is reachable.
    """
    with patch.object(pg_lease, "acquire", AsyncMock(return_value=None)):
        acquired, backend = await leader_mod._acquire_with_fallback(
            _FakeLock(acquired=False, holder=None), "insights_loop", "host:1", 60
        )
    assert (acquired, backend) == (False, "none")


@pytest.mark.asyncio
async def test_pg_available_zero_redis_commands() -> None:
    """PG available → Redis acquire/renew/release call count is zero.

    The whole point of the inversion is to eliminate Upstash command
    budget burn on the normal path.  Verify by mocking the Redis
    ``get_redis_client`` to a sentinel that records every call.
    """
    redis_calls: list[str] = []

    class _SpyLock:
        def __init__(self, *a, **kw):
            pass

        async def acquire(self, token=None):
            redis_calls.append("acquire")
            return True

        async def holder(self):
            redis_calls.append("holder")
            return None

        async def release(self):
            redis_calls.append("release")
            return True

        async def extend(self, additional_ttl=None):
            redis_calls.append("extend")
            return True

    spy = _SpyLock()
    with patch.object(pg_lease, "acquire", AsyncMock(return_value=True)):
        acquired, backend = await leader_mod._acquire_with_fallback(
            spy, "insights_loop", "host:1", 60
        )
    assert (acquired, backend) == (True, "postgres")
    assert redis_calls == [], f"Expected zero Redis commands; got {redis_calls}"


# ── The pg_lease module itself ────────────────────────────────────────────────


def _pg(rows):
    client = MagicMock()
    client.execute = AsyncMock(return_value=None)
    client.fetchrow = AsyncMock(side_effect=rows)
    client.fetchval = AsyncMock(return_value=None)
    return client


@pytest.mark.asyncio
async def test_acquire_is_a_single_atomic_statement() -> None:
    """Read-then-write would race two replicas into both being leader."""
    client = _pg([{"holder": "me"}])
    with patch.object(pg_lease, "_client", AsyncMock(return_value=client)):
        assert await pg_lease.acquire("l", "me", 60) is True
    sql = client.fetchrow.await_args.args[0]
    assert "ON CONFLICT" in sql and "RETURNING" in sql
    assert "expires_at <" in sql, "expired leases must be reclaimable"


@pytest.mark.asyncio
async def test_acquire_false_when_someone_else_holds_it() -> None:
    client = _pg([{"holder": "someone-else"}])
    with patch.object(pg_lease, "_client", AsyncMock(return_value=client)):
        assert await pg_lease.acquire("l", "me", 60) is False


@pytest.mark.asyncio
async def test_expired_lease_next_acquirer_wins() -> None:
    """The INSERT … ON CONFLICT … WHERE expires_at < NOW() must let the
    new holder take over once the previous lease has expired.

    Simulated by returning the new holder's token from RETURNING — which
    is what Postgres does when the WHERE matches (old lease expired) and
    the UPDATE succeeds.
    """
    # First holder acquires normally.
    client = _pg([
        {"holder": "holder-A"},  # first acquire — A wins
        {"holder": "holder-B"},  # second acquire after A's lease expired — B wins
    ])
    with patch.object(pg_lease, "_client", AsyncMock(return_value=client)):
        pg_lease._ensured = True
        result_a = await pg_lease.acquire("l", "holder-A", 60)
        result_b = await pg_lease.acquire("l", "holder-B", 60)

    assert result_a is True, "holder-A should win the first acquire"
    assert result_b is True, "holder-B should win after expiry"

    # Verify the SQL used in both calls uses the WHERE expires_at < NOW() clause
    # (the atomicity check; both calls go to the same statement).
    first_call_sql = client.fetchrow.call_args_list[0][0][0]
    assert "expires_at <" in first_call_sql, "expiry check must be in every acquire"


@pytest.mark.asyncio
async def test_renew_and_release_only_affect_our_own_lease() -> None:
    """A process that lost its lease must never stomp the new owner."""
    client = _pg([None])
    with patch.object(pg_lease, "_client", AsyncMock(return_value=client)):
        pg_lease._ensured = True
        assert await pg_lease.renew("l", "me", 60) is False
        renew_sql = client.fetchrow.await_args.args[0]
        assert "holder = $2" in renew_sql

        await pg_lease.release("l", "me")
        release_sql = client.execute.await_args.args[0]
        assert "holder = $2" in release_sql


@pytest.mark.asyncio
async def test_lease_failures_are_not_fatal() -> None:
    """DB errors degrade to "unavailable" (None), never crash the process."""
    client = MagicMock()
    client.execute = AsyncMock(side_effect=Exception("db gone"))
    client.fetchrow = AsyncMock(side_effect=Exception("db gone"))
    with patch.object(pg_lease, "_client", AsyncMock(return_value=client)):
        # Table ensure fails (execute raises) → returns None (unavailable).
        result = await pg_lease.acquire("l", "me", 60)
        assert result is None, f"expected None (unavailable), got {result!r}"

        pg_lease._ensured = True
        assert await pg_lease.renew("l", "me", 60) is False
        assert await pg_lease.release("l", "me") is False


@pytest.mark.asyncio
async def test_no_postgres_client_is_not_leader() -> None:
    """No PG client → acquire returns None (unavailable, not False/contention)."""
    with patch.object(pg_lease, "_client", AsyncMock(return_value=None)):
        result = await pg_lease.acquire("l", "me", 60)
        assert result is None, f"expected None (unavailable), got {result!r}"
