"""``RequestConnLease`` — the RLS connection is acquired on first use.

``RLSOrgContextMiddleware`` used to acquire a pooled connection, open a
transaction and issue ``SET LOCAL app.current_org_id`` at middleware entry for
every request that resolved an org, then release it at ``http.response.start``.
Measured against a local Postgres 18 over a unix socket, that was 221.5 us of
setup per request (p50 209.4, p99 342.0) that a request touching no Postgres
never used -- and a pool slot held across every bit of pre-query work,
including non-Postgres latency like an upstream LLM call. At ``max_size=20``,
40 concurrent requests doing 200 ms of non-Postgres work each took 407 ms
(2.03x the 200 ms floor, serialised into two pool-sized waves) versus 204 ms
when the slot is not held.

What these tests pin, in rough order of how much damage the absence of each
would do:

* ``PostgresClient.acquire`` actually redeems the lease. This is the whole
  mechanism: if the wiring is wrong, queries silently run on unpinned pool
  connections with no GUC and RLS stops applying.
* A request that never queries never checks out a connection. This is the
  optimisation itself.
* Redemption happens exactly once, including under concurrency. Two coroutines
  racing on a request's first query must not each check one out -- one would
  be leaked and the GUC would be set on a connection nobody uses.
* ``close()`` shuts the window that lazy acquisition opens: the finalizer runs
  at ``http.response.start``, and without a barrier a task sharing the
  request's context could redeem the lease afterwards, checking out a
  connection inside an open transaction that nothing would ever return.
* Failure stays fail-soft and non-repeating: fall through to an unpinned
  connection, and do not re-attempt once per query against a pool that is
  down.
* ``copy_context_without_request_pg_conn`` strips an unredeemed lease, not
  just a materialized connection -- otherwise the detached-task cross-tenant
  bug class it exists to prevent reopens through a new door.
"""

from __future__ import annotations

import asyncio
import contextvars
from typing import Any

import pytest

from eden.storage.postgres import (
    PostgresClient,
    RequestConnLease,
    bind_request_pg_lease,
    copy_context_without_request_pg_conn,
    get_bound_request_pg_conn,
    get_bound_request_pg_lease,
    reset_request_pg_conn,
)

ORG = "11111111-1111-1111-1111-111111111111"


# --------------------------------------------------------------------------
# Fakes. Deliberately record call counts rather than just returning values --
# "did this touch the pool at all" is the assertion most of these tests make.
# --------------------------------------------------------------------------

class _FakeTx:
    def __init__(self, *, fail_begin: bool = False, fail_commit: bool = False):
        self.fail_begin = fail_begin
        self.fail_commit = fail_commit
        self.entered = False
        self.exited = False

    async def __aenter__(self) -> _FakeTx:
        if self.fail_begin:
            raise RuntimeError("BEGIN failed")
        self.entered = True
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.exited = True
        if self.fail_commit:
            raise RuntimeError("COMMIT failed")


class _FakeConn:
    def __init__(self, *, fail_begin: bool = False, fail_commit: bool = False):
        self.statements: list[tuple[str, tuple[Any, ...]]] = []
        self.closed = False
        self._tx = _FakeTx(fail_begin=fail_begin, fail_commit=fail_commit)

    def transaction(self) -> _FakeTx:
        return self._tx

    async def execute(self, query: str, *args: Any) -> str:
        self.statements.append((query, args))
        return "SET"

    async def close(self) -> None:
        self.closed = True


class _FakeConnCtx:
    def __init__(self, conn: _FakeConn, *, gate: asyncio.Event | None = None):
        self._con = conn
        self.gate = gate
        self.entered = 0
        self.exited = 0

    async def __aenter__(self) -> _FakeConn:
        self.entered += 1
        if self.gate is not None:
            await self.gate.wait()
        return self._con

    async def __aexit__(self, *exc: Any) -> None:
        self.exited += 1


class _FakePool:
    """Hands out a fresh ctx per ``acquire()`` and counts checkouts."""

    def __init__(self, conn: _FakeConn, *, gate: asyncio.Event | None = None):
        self.conn = conn
        self.gate = gate
        self.acquires = 0
        self.contexts: list[_FakeConnCtx] = []

    def acquire(self) -> _FakeConnCtx:
        self.acquires += 1
        ctx = _FakeConnCtx(self.conn, gate=self.gate)
        self.contexts.append(ctx)
        return ctx


class _FakeClient:
    def __init__(self, pool: _FakePool | None):
        self._pool = pool
        self.initialized = 0

    async def initialize(self) -> None:
        self.initialized += 1


@pytest.fixture
def conn() -> _FakeConn:
    return _FakeConn()


@pytest.fixture
def pool(conn: _FakeConn) -> _FakePool:
    return _FakePool(conn)


@pytest.fixture
def client(pool: _FakePool) -> _FakeClient:
    return _FakeClient(pool)


@pytest.fixture
def bound_lease(client: _FakeClient):
    """A lease bound to the ambient context, unbound on teardown."""
    lease = RequestConnLease(ORG, client)
    token = bind_request_pg_lease(lease)
    try:
        yield lease
    finally:
        reset_request_pg_conn(token)


# --------------------------------------------------------------------------
# The mechanism: acquire() redeems, and nothing else does.
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_construction_touches_no_postgres(
    client: _FakeClient, pool: _FakePool
) -> None:
    """The entire saving rests on this: building a lease is free."""
    lease = RequestConnLease(ORG, client)
    assert pool.acquires == 0
    assert client.initialized == 0
    assert lease.materialized is False
    assert lease.conn is None


@pytest.mark.asyncio
async def test_acquire_redeems_the_pinned_lease(
    bound_lease: RequestConnLease, pool: _FakePool, conn: _FakeConn
) -> None:
    """``PostgresClient.acquire`` is the only production redeemer.

    If this wiring breaks, every query quietly runs on an unpinned pool
    connection with no ``app.current_org_id`` -- which is not an error, just
    RLS silently not applying. Hence a direct test rather than trusting the
    middleware's own tests to cover it.
    """
    pg = PostgresClient()
    async with pg.acquire() as acquired:
        assert acquired is conn, (
            "acquire() did not yield the leased connection -- queries would "
            "run unpinned with no app.current_org_id set"
        )
    assert pool.acquires == 1
    assert bound_lease.materialized is True


@pytest.mark.asyncio
async def test_acquire_sets_the_guc_for_the_leases_org(
    bound_lease: RequestConnLease, conn: _FakeConn
) -> None:
    pg = PostgresClient()
    async with pg.acquire():
        pass
    assert len(conn.statements) == 1
    query, args = conn.statements[0]
    assert "set_config" in query
    assert "app.current_org_id" in query
    assert args == (ORG,), f"GUC set for {args!r}, expected {(ORG,)!r}"


@pytest.mark.asyncio
async def test_a_request_that_never_queries_never_checks_out(
    bound_lease: RequestConnLease, pool: _FakePool, client: _FakeClient
) -> None:
    """The optimisation. No query, no pool slot, no round trip."""
    assert pool.acquires == 0
    assert client.initialized == 0
    assert conn_statements(pool) == 0


def conn_statements(pool: _FakePool) -> int:
    return len(pool.conn.statements)


@pytest.mark.asyncio
async def test_acquire_does_not_release_the_leased_connection(
    bound_lease: RequestConnLease, pool: _FakePool
) -> None:
    """The middleware owns the lifetime; ``acquire`` must not hand it back.

    If ``acquire`` released it, the second query of a request would run on a
    different pooled connection -- one without the GUC -- and the finalizer
    would later release a connection already back in the pool.
    """
    pg = PostgresClient()
    async with pg.acquire():
        pass
    assert pool.contexts[0].exited == 0, (
        "acquire() released the leased connection; only the middleware's "
        "finalizer may do that"
    )


@pytest.mark.asyncio
async def test_repeated_queries_reuse_one_checkout(
    bound_lease: RequestConnLease, pool: _FakePool, conn: _FakeConn
) -> None:
    pg = PostgresClient()
    for _ in range(5):
        async with pg.acquire() as c:
            assert c is conn
    assert pool.acquires == 1, (
        f"{pool.acquires} checkouts for 5 queries; the lease must be redeemed "
        "once per request"
    )
    assert len(conn.statements) == 1, "set_config re-issued on a later query"


# --------------------------------------------------------------------------
# Concurrency: the asyncio.Lock.
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_concurrent_first_queries_check_out_exactly_one_connection(
    client: _FakeClient, conn: _FakeConn
) -> None:
    """Two coroutines racing on a request's first query.

    Without the lock both see ``_conn is None`` and both check out: one
    connection is leaked for the process lifetime (the finalizer only knows
    about the last one published) and the GUC is set twice.

    The gate makes the race deterministic: both tasks are parked inside
    ``__aenter__`` before either can publish.
    """
    gate = asyncio.Event()
    pool = _FakePool(conn, gate=gate)
    lease = RequestConnLease(ORG, _FakeClient(pool))
    token = bind_request_pg_lease(lease)
    try:
        pg = PostgresClient()

        async def query() -> Any:
            async with pg.acquire() as c:
                return c

        tasks = [asyncio.create_task(query()) for _ in range(8)]
        await asyncio.sleep(0)  # let them all reach the lock / the gate
        gate.set()
        results = await asyncio.gather(*tasks)
    finally:
        reset_request_pg_conn(token)

    assert pool.acquires == 1, (
        f"{pool.acquires} concurrent checkouts for one request; "
        "RequestConnLease.ensure must serialise on its lock"
    )
    assert all(r is conn for r in results)
    assert len(conn.statements) == 1, "set_config issued more than once"


# --------------------------------------------------------------------------
# use(): exclusive access to a connection several callers share.
# --------------------------------------------------------------------------

class _OneOpAtATimeConn(_FakeConn):
    """Enforces asyncpg's rule: one operation in flight per connection."""

    def __init__(self) -> None:
        super().__init__()
        self.busy = False
        self.collisions = 0
        self.max_concurrent = 0
        self._in_flight = 0
        # When set, a statement parks mid-flight until released -- lets a test
        # hold an operation open and observe whether a second one overlaps.
        self.hold: asyncio.Event | None = None
        self.parked = asyncio.Event()
        # Queries containing this substring raise. Selected by query text rather
        # than by monkeypatching ``execute``, because swapping the method races
        # with any other task that calls it in the meantime -- which silently
        # defused the first version of the owner-marker test below.
        self.fail_on: str | None = None

    async def execute(self, query: str, *args: Any) -> str:
        if self.fail_on is not None and self.fail_on in query:
            raise RuntimeError("statement failed")
        if self.busy:
            self.collisions += 1
            raise RuntimeError(
                "cannot perform operation: another operation is in progress"
            )
        self.busy = True
        self._in_flight += 1
        self.max_concurrent = max(self.max_concurrent, self._in_flight)
        try:
            if self.hold is not None:
                self.parked.set()
                await self.hold.wait()
            else:
                await asyncio.sleep(0)
            self.statements.append((query, args))
            return "OK"
        finally:
            self._in_flight -= 1
            self.busy = False


@pytest.mark.asyncio
async def test_concurrent_queries_do_not_collide_on_the_shared_connection() -> None:
    """The data-loss bug on the ingest path.

    ``ingest_batch`` gathers one ``_route`` per event and ``_route`` gathers
    six sinks, so a batch issues many concurrent statements from one task --
    all landing on the one connection the RLS middleware pinned. asyncpg
    permits one operation at a time, so nine of ten collided, and
    ``_route_postgres`` turns any exception into ``IngestionUnavailableError``,
    which 503s the whole batch.
    """
    conn = _OneOpAtATimeConn()
    pool = _FakePool(conn)
    lease = RequestConnLease(ORG, _FakeClient(pool))
    token = bind_request_pg_lease(lease)
    try:
        pg = PostgresClient()

        async def query(i: int) -> Any:
            return await pg.execute(f"SELECT {i}")

        results = await asyncio.gather(
            *(query(i) for i in range(12)), return_exceptions=True
        )
    finally:
        reset_request_pg_conn(token)

    failures = [r for r in results if isinstance(r, BaseException)]
    assert not failures, (
        f"{len(failures)}/12 concurrent statements collided on the pinned "
        f"connection ({conn.collisions} collisions): {failures[:1]}"
    )
    assert conn.max_concurrent == 1, (
        f"{conn.max_concurrent} statements were in flight at once on a "
        "connection that permits one"
    )


@pytest.mark.asyncio
async def test_use_is_reentrant_within_one_task(
    bound_lease: RequestConnLease, conn: _FakeConn
) -> None:
    """``transaction()`` and ``fetchiter`` hold the connection while the caller
    issues more queries on it, so a non-reentrant lock would deadlock against
    itself -- a hang, which is worse than the error it replaced."""
    pg = PostgresClient()
    async with pg.acquire() as outer:
        # A nested acquire in the same task, as a route inside
        # ``async with client.transaction()`` would do.
        async with asyncio.timeout(2):
            async with pg.acquire() as inner:
                assert inner is outer


@pytest.mark.asyncio
async def test_the_lock_is_released_when_a_query_raises(
    bound_lease: RequestConnLease, conn: _FakeConn
) -> None:
    """A failed statement must not strand the connection.

    If the lock leaked on the error path, one bad query would wedge every
    later query in the request behind it.
    """
    pg = PostgresClient()
    # Redeem the lease first: swapping ``execute`` before this would break the
    # lease's own set_config, and ensure() would fall through to the pool
    # instead of exercising the path under test.
    assert await bound_lease.ensure() is conn

    async def boom(query: str, *args: Any) -> str:
        raise RuntimeError("statement failed")

    conn.execute = boom  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        await pg.execute("SELECT 1")

    # The lock must be free again.
    async with asyncio.timeout(2):
        async with pg.acquire() as c:
            assert c is conn


@pytest.mark.asyncio
async def test_a_raising_query_does_not_strand_the_owner_marker() -> None:
    """The subtler half of the error path, and the one a lock alone misses.

    ``async with self._use_lock`` releases the lock on an exception by itself,
    so a leak there is invisible. What is *not* automatic is clearing
    ``_user``: if it still names a task that has already unwound, every later
    query from that task takes the reentrant fast path and skips the lock
    entirely -- so it can run concurrently with another task that legitimately
    holds it, and the collision is back.

    Getting this test right took three attempts, each corrected by the mutant
    surviving, and the reasoning is worth keeping because it is not obvious:

    1. The follow-up query must run in the *same task* as the failed one.
       ``asyncio.gather(coro, ...)`` wraps a bare coroutine in a **fresh** task,
       so the stale marker never matched.
    2. The stale owner must be the one **in flight** when another task arrives
       -- not the other way round. If some other task takes the lock first it
       overwrites ``_user`` with its own identity, and the stale value is gone
       before it can do harm. The damage happens when the stale owner skips the
       lock, leaving it free for a second task to take while the first is still
       mid-statement.
    3. The failure must be triggered by query text, not by monkeypatching
       ``execute``; swapping the method races with any other task calling it.
    """
    conn = _OneOpAtATimeConn()
    lease = RequestConnLease(ORG, _FakeClient(_FakePool(conn)))
    token = bind_request_pg_lease(lease)
    hold = asyncio.Event()
    results: list[Any] = []
    try:
        pg = PostgresClient()
        assert await lease.ensure() is conn
        conn.fail_on = "BOOM"

        async def failing_then_parking() -> Any:
            with pytest.raises(RuntimeError):
                await pg.execute("SELECT BOOM")
            # Marker is now stale under the mutant. Park mid-statement so the
            # lock's state (held, or wrongly free) becomes observable.
            conn.hold = hold
            return await pg.execute("SELECT after-failure")

        a = asyncio.create_task(failing_then_parking())
        await asyncio.wait_for(conn.parked.wait(), timeout=2)

        # A is mid-statement. Correct code holds the lock, so B must wait.
        # With the marker leaked, A skipped the lock, B walks straight in and
        # collides against A's in-flight statement.
        b = asyncio.create_task(pg.execute("SELECT second"))
        for _ in range(50):
            await asyncio.sleep(0)

        assert conn.collisions == 0, (
            "a second statement ran while one was still in flight. After the "
            "earlier query raised, the owner marker was left naming that task, "
            "so its next query took the reentrant path, skipped the lock, and "
            "left the lock free for another task to take concurrently"
        )
        assert not b.done(), (
            "the second statement completed while the first was still in "
            "flight -- it was never serialised behind it"
        )

        conn.hold = None
        hold.set()
        results = await asyncio.gather(a, b, return_exceptions=True)
    finally:
        conn.hold = None
        hold.set()
        reset_request_pg_conn(token)

    failures = [r for r in results if isinstance(r, BaseException)]
    assert not failures, f"unexpected failure: {failures[:1]}"
    assert conn.max_concurrent == 1
    assert lease._user is None, "the owner marker was not cleared"


# --------------------------------------------------------------------------
# close(): the window lazy acquisition opens.
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_close_prevents_a_later_redemption(
    bound_lease: RequestConnLease, pool: _FakePool
) -> None:
    """After the request finalizes, nothing may redeem the lease.

    A fire-and-forget task sharing the request's context can reach ``acquire``
    after ``http.response.start``. Redeeming then would check out a pooled
    connection, inside an open transaction, that the already-completed
    finalizer will never give back.
    """
    await bound_lease.close()

    # A distinct fallback pool, so "the closed lease was bypassed" is proved by
    # *which* connection comes back -- not merely by something raising.
    fallback = _FakeConn()
    pg = PostgresClient()
    pg._pool = _FakePool(fallback)  # type: ignore[assignment]

    async with pg.acquire() as c:
        assert c is fallback, (
            "a closed lease was still redeemed; that connection is checked "
            "out inside an open transaction and nothing is left to release it"
        )
    assert pool.acquires == 0, (
        "a closed lease was redeemed anyway -- that connection is leaked"
    )
    assert bound_lease.materialized is False


@pytest.mark.asyncio
async def test_close_waits_for_an_in_flight_materialize(
    client: _FakeClient, conn: _FakeConn
) -> None:
    """``close`` must not race a redemption that is already underway.

    If ``close`` returned while ``_materialize`` was still awaiting, the
    finalizer would read ``request.state`` (finding nothing), and the
    redemption would then publish a connection that nothing releases. Taking
    the same lock makes the two mutually exclusive: by the time ``close``
    returns, either the resources are published or they never will be.
    """
    gate = asyncio.Event()
    pool = _FakePool(conn, gate=gate)
    published: list[tuple[Any, ...]] = []
    lease = RequestConnLease(
        ORG,
        _FakeClient(pool),
        on_materialize=lambda *a: published.append(a),
    )
    task = asyncio.create_task(lease.ensure())
    await asyncio.sleep(0)  # park inside __aenter__, holding the lock

    closing = asyncio.create_task(lease.close())
    await asyncio.sleep(0)
    assert not closing.done(), "close() returned while a redemption was in flight"

    gate.set()
    await task
    await closing

    assert len(published) == 1, (
        "close() and the in-flight materialize interleaved: the finalizer "
        "would have found no resources to release"
    )
    assert lease.materialized is True


# --------------------------------------------------------------------------
# Failure: fail-soft, and not once per query.
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ensure_returns_none_when_there_is_no_pool(
    client: _FakeClient,
) -> None:
    lease = RequestConnLease(ORG, _FakeClient(None))
    assert await lease.ensure() is None
    assert lease.materialized is False


@pytest.mark.asyncio
async def test_a_failed_lease_falls_through_to_an_ordinary_checkout() -> None:
    """Fail-soft in the same direction the eager version failed.

    The eager acquire, on failure, bound nothing -- so queries fell through to
    a normal pool connection with no GUC. The RLS policies read
    ``current_setting(..., true)``, so an unset GUC compares NULL and filters
    rows out rather than in. Same behaviour here.
    """
    lease = RequestConnLease(ORG, _FakeClient(None))
    token = bind_request_pg_lease(lease)
    try:
        pg = PostgresClient()
        fallback = _FakeConn()
        pg._pool = _FakePool(fallback)  # type: ignore[assignment]
        async with pg.acquire() as c:
            assert c is fallback, (
                "a failed lease must fall through to an unpinned pool "
                "connection, not propagate the failure to the query"
            )
    finally:
        reset_request_pg_conn(token)


@pytest.mark.asyncio
async def test_a_failed_lease_is_not_retried_on_every_query() -> None:
    """A pool that is down must not be probed once per query.

    Without the sticky ``_failed`` flag, a 40-query request against a broken
    pool makes 40 failed acquisitions, each logging a warning -- turning one
    outage into a log flood and 40x the reconnect pressure.
    """
    client = _FakeClient(None)
    lease = RequestConnLease(ORG, client)
    for _ in range(5):
        assert await lease.ensure() is None
    assert client.initialized == 1, (
        f"initialize() attempted {client.initialized} times; the first "
        "failure must be remembered"
    )


@pytest.mark.asyncio
async def test_begin_failure_closes_the_connection_and_does_not_commit() -> None:
    """A tx whose BEGIN never completed must not be ``__aexit__``ed.

    Mirrors the contract of the middleware's ``_release_pg_resources``: a
    failed BEGIN means the connection is suspect, so close it explicitly
    rather than handing it back to the pool with no health check.
    """
    conn = _FakeConn(fail_begin=True)
    pool = _FakePool(conn)
    lease = RequestConnLease(ORG, _FakeClient(pool))
    assert await lease.ensure() is None
    assert conn._tx.exited is False, "committed a transaction that never began"
    assert conn.closed is True, (
        "a connection whose BEGIN failed was handed back to the pool "
        "without being closed"
    )
    assert pool.contexts[0].exited == 1, "the pool slot was not released"


@pytest.mark.asyncio
async def test_commit_failure_during_abandon_still_closes_the_connection() -> None:
    conn = _FakeConn(fail_commit=True)
    pool = _FakePool(conn)
    lease = RequestConnLease(ORG, _FakeClient(pool))
    # Make set_config fail so _materialize raises AFTER a successful BEGIN.
    async def _boom(query: str, *args: Any) -> str:
        raise RuntimeError("set_config failed")

    conn.execute = _boom  # type: ignore[method-assign]
    assert await lease.ensure() is None
    assert conn._tx.exited is True, "a begun transaction was not exited"
    assert conn.closed is True, (
        "the commit attempt failed, so the connection is suspect and must be "
        "closed rather than returned to the pool"
    )


# --------------------------------------------------------------------------
# The accessors, and the detached-task strip.
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_the_connection_is_not_published_until_the_guc_is_set() -> None:
    """Publishing early would hand out a connection with no GUC yet.

    ``ensure``'s fast path is a lockless attribute read, so the instant
    ``_conn`` is assigned any other coroutine can be handed that connection.
    If the assignment happens before ``set_config`` is awaited, a racing query
    runs either without ``app.current_org_id`` or concurrently with the
    ``set_config`` on the same connection -- and asyncpg refuses two
    operations at once on one connection.
    """
    gate = asyncio.Event()
    conn = _FakeConn()
    real_execute = conn.execute

    async def gated_execute(query: str, *args: Any) -> str:
        await gate.wait()
        return await real_execute(query, *args)

    conn.execute = gated_execute  # type: ignore[method-assign]
    lease = RequestConnLease(ORG, _FakeClient(_FakePool(conn)))

    task = asyncio.create_task(lease.ensure())
    await asyncio.sleep(0)
    await asyncio.sleep(0)  # parked inside set_config

    assert lease.conn is None, (
        "the connection was published before set_config completed; a racing "
        "query would get it with no app.current_org_id set"
    )
    assert lease.materialized is False

    gate.set()
    assert await task is conn
    assert lease.conn is conn


@pytest.mark.asyncio
async def test_a_failed_setup_after_checkout_still_closes_the_connection() -> None:
    """The handle must be recorded at checkout, not recovered afterwards.

    ``_conn`` is published only on full success, so a failure in between left
    nothing to close if the code tried to recover the handle from the pool's
    context manager. That recovery cannot work: asyncpg's
    ``PoolAcquireContext`` declares ``__slots__`` without any such attribute,
    so the lookup yields ``None`` and a suspect connection is released back
    into the pool unclosed.
    """
    conn = _FakeConn(fail_begin=True)
    pool = _FakePool(conn)
    lease = RequestConnLease(ORG, _FakeClient(pool))
    assert await lease.ensure() is None
    assert conn.closed is True, (
        "the connection was checked out and then abandoned without being "
        "closed -- it goes back to the pool in an unknown state"
    )


@pytest.mark.asyncio
async def test_get_bound_conn_is_none_until_redeemed(
    bound_lease: RequestConnLease, conn: _FakeConn
) -> None:
    """Reporting a connection that has not been acquired would be a lie
    callers act on -- ``get_request_pg_conn`` consumers branch on it."""
    assert get_bound_request_pg_conn() is None
    assert get_bound_request_pg_lease() is bound_lease
    await bound_lease.ensure()
    assert get_bound_request_pg_conn() is conn


@pytest.mark.asyncio
async def test_copy_context_strips_an_unredeemed_lease(
    bound_lease: RequestConnLease, pool: _FakePool
) -> None:
    """The detached-task guard must cover leases, not just connections.

    A task that inherited an unredeemed lease could *redeem* it after the
    request finalized -- checking out a connection nothing will release, and
    reopening the cross-tenant reuse class from a new direction.
    """
    stripped = copy_context_without_request_pg_conn()
    assert stripped.run(get_bound_request_pg_lease) is None
    assert stripped.run(get_bound_request_pg_conn) is None
    # And the caller's own binding is untouched.
    assert get_bound_request_pg_lease() is bound_lease


@pytest.mark.asyncio
async def test_copy_context_strips_a_redeemed_lease(
    bound_lease: RequestConnLease,
) -> None:
    await bound_lease.ensure()
    stripped = copy_context_without_request_pg_conn()
    assert stripped.run(get_bound_request_pg_conn) is None


@pytest.mark.asyncio
async def test_a_detached_task_cannot_redeem_an_inherited_lease(
    client: _FakeClient, conn: _FakeConn
) -> None:
    gate_free_pool = _FakePool(conn)
    lease = RequestConnLease(ORG, _FakeClient(gate_free_pool))
    token = bind_request_pg_lease(lease)
    try:
        ctx: contextvars.Context = copy_context_without_request_pg_conn()
    finally:
        reset_request_pg_conn(token)

    async def detached() -> Any:
        got = get_bound_request_pg_lease()
        if got is not None:
            await got.ensure()
        return got

    task = ctx.run(asyncio.create_task, detached())
    assert await task is None
    assert gate_free_pool.acquires == 0, (
        "a detached task redeemed a lease from the request it was spawned in"
    )


@pytest.mark.asyncio
async def test_a_bare_bound_connection_still_works(conn: _FakeConn) -> None:
    """Binding a ``Connection`` directly -- the pre-lease form -- is
    unchanged, so callers and tests that do so keep working."""
    from eden.storage.postgres import bind_request_pg_conn

    token = bind_request_pg_conn(conn)
    try:
        assert get_bound_request_pg_conn() is conn
        assert get_bound_request_pg_lease() is None
        pg = PostgresClient()
        async with pg.acquire() as c:
            assert c is conn
    finally:
        reset_request_pg_conn(token)
    assert not conn.statements, "a directly-bound connection must not be re-scoped"
