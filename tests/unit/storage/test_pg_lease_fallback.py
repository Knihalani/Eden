"""Leader election must survive losing Redis.

2026-07-29: the Upstash free tier's monthly request cap was reached
("max requests limit exceeded. Limit: 500000, Usage: 500000"). Past the
limit Upstash serves reads and *silently discards writes*, so ``SET NX``
returned null. Every leader lock therefore read as "refused" while
nothing held it, no leader-gated loop could start, and the whole
annotate/evaluate/improve half of Eden was down for 7.4 days — with PING
still succeeding, so nothing anywhere reported a fault.

Postgres was healthy throughout. These tests pin the two properties that
make that survivable: refused-with-no-holder is recognised as a broken
write path rather than contention, and election falls through to a
Postgres lease with the same mutual-exclusion guarantees.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

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
    """Redis lock that refuses and reports no holder — the outage shape."""

    def __init__(self, acquired: bool = False, holder: str | None = None):
        self.name = "t"
        self._acquired = acquired
        self._holder = holder

    async def acquire(self, token=None):
        return self._acquired

    async def holder(self):
        return self._holder

    async def release(self):
        return True


@pytest.mark.asyncio
async def test_refused_with_no_holder_falls_back_to_postgres() -> None:
    """SET NX cannot fail on a key that does not exist. Refused + unheld
    means the write was discarded, and that must not read as contention."""
    with patch.object(
        pg_lease, "acquire", AsyncMock(return_value=True)
    ) as pg_acquire:
        acquired, backend = await leader_mod._acquire_with_fallback(
            _FakeLock(acquired=False, holder=None), "insights_loop", "host:1", 60
        )
    assert acquired is True
    assert backend == "postgres"
    pg_acquire.assert_awaited_once()
    assert leader_mod.leader_pg_fallback_locks()["insights_loop"] == "host:1"


@pytest.mark.asyncio
async def test_genuine_contention_does_not_fall_back() -> None:
    """A real peer holding the lock must keep us a follower — falling back
    there would run the loop twice."""
    with patch.object(pg_lease, "acquire", AsyncMock(return_value=True)) as pg:
        acquired, backend = await leader_mod._acquire_with_fallback(
            _FakeLock(acquired=False, holder="other-host:9"),
            "insights_loop",
            "host:1",
            60,
        )
    assert acquired is False
    assert backend == "none"
    pg.assert_not_awaited(), "fell back while a real peer was leader"


@pytest.mark.asyncio
async def test_redis_success_does_not_touch_postgres() -> None:
    """Redis stays primary; the fallback must cost nothing when healthy."""
    with patch.object(pg_lease, "acquire", AsyncMock(return_value=True)) as pg:
        acquired, backend = await leader_mod._acquire_with_fallback(
            _FakeLock(acquired=True), "insights_loop", "host:1", 60
        )
    assert (acquired, backend) == (True, "redis")
    pg.assert_not_awaited()


@pytest.mark.asyncio
async def test_both_backends_down_is_not_leader() -> None:
    with patch.object(pg_lease, "acquire", AsyncMock(return_value=False)):
        acquired, backend = await leader_mod._acquire_with_fallback(
            _FakeLock(acquired=False, holder=None), "insights_loop", "host:1", 60
        )
    assert (acquired, backend) == (False, "none")


# ── The lease itself ────────────────────────────────────────────────────


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
    """The fallback must degrade to "not leader", never take the app down."""
    client = MagicMock()
    client.execute = AsyncMock(side_effect=Exception("db gone"))
    client.fetchrow = AsyncMock(side_effect=Exception("db gone"))
    with patch.object(pg_lease, "_client", AsyncMock(return_value=client)):
        assert await pg_lease.acquire("l", "me", 60) is False
        pg_lease._ensured = True
        assert await pg_lease.renew("l", "me", 60) is False
        assert await pg_lease.release("l", "me") is False


@pytest.mark.asyncio
async def test_no_postgres_client_is_not_leader() -> None:
    with patch.object(pg_lease, "_client", AsyncMock(return_value=None)):
        assert await pg_lease.acquire("l", "me", 60) is False
