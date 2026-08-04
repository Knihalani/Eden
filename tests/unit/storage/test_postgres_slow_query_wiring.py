"""PostgresClient wrappers feed the slow-query ring buffer (F83 / K44).

``eden.observability.slow_query`` had no production producers — only its
own unit tests called ``record_slow_query``. The wiring under test here
times every ``PostgresClient`` wrapper (``execute`` / ``executemany`` /
``fetch`` / ``fetchrow`` / ``fetchval``) with ``time.monotonic`` and,
past the ``EDEN_SLOW_QUERY_MS`` threshold, records the query into the
REAL ring buffer with the org id of the request-pinned RLS lease.
``fetchiter`` is intentionally uninstrumented (a wall-clock diff around
a streamed cursor would mostly measure caller time between yields).

No real Postgres: a ``RequestConnLease`` subclass hands back a stub
connection, and ``time`` inside ``eden.storage.postgres`` is replaced
with a controllable clock (the same trick as the pool-wiring tests'
``get_settings`` patching — the module binds names at import time).
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import pytest

from eden.observability import slow_query as slow_query_mod
from eden.storage.postgres import (
    PostgresClient,
    RequestConnLease,
    bind_request_pg_conn,
    reset_request_pg_conn,
)

ORG = "org_slow_wiring_test"


# ─── stubs ──────────────────────────────────────────────────────────────────


class _StubConn:
    """Minimal asyncpg-Connection stand-in for the wrapper methods."""

    async def execute(self, query, *args):
        return "UPDATE 1"

    async def executemany(self, query, args_iter):
        return "INSERT 0 2"

    async def fetch(self, query, *args):
        return []

    async def fetchrow(self, query, *args):
        return None

    async def fetchval(self, query, *args):
        return 42


class _StubLease(RequestConnLease):
    """A pre-redeemed lease: no pool, no BEGIN, but a real ``org_id``.

    Subclassing (rather than a duck-typed fake) matters — the wiring
    discovers the org via ``isinstance(bound, RequestConnLease)``.
    The parent declares ``__slots__``; this subclass does not, so the
    extra ``_stub`` attribute lands in the subclass ``__dict__``.
    """

    def __init__(self, org_id: str, conn: _StubConn) -> None:
        super().__init__(org_id, client=None)
        self._stub = conn

    async def ensure(self):
        return self._stub

    @asynccontextmanager
    async def use(self):
        yield


class _FakeClock:
    """Deterministic ``time`` replacement: each ``monotonic()`` call
    advances by ``step`` seconds. Every wrapper call reads the clock
    exactly twice (start + helper), so step directly sets duration."""

    def __init__(self, step: float) -> None:
        self.step = step
        self._now = 0.0

    def monotonic(self) -> float:
        self._now += self.step
        return self._now


# ─── fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_ring_buffer():
    slow_query_mod.reset_for_tests()
    yield
    slow_query_mod.reset_for_tests()


@pytest.fixture(autouse=True)
def _pinned_threshold(monkeypatch):
    """Pin the cached threshold to the 500 ms default regardless of any
    ``EDEN_SLOW_QUERY_MS`` in the developer's environment."""
    monkeypatch.setattr(
        "eden.storage.postgres._slow_query_threshold_ms_cached", 500.0,
    )


@pytest.fixture
def bound_lease():
    lease = _StubLease(ORG, _StubConn())
    token = bind_request_pg_conn(lease)
    try:
        yield lease
    finally:
        reset_request_pg_conn(token)


def _client_with_clock(monkeypatch, step_seconds: float) -> PostgresClient:
    monkeypatch.setattr(
        "eden.storage.postgres.time", _FakeClock(step_seconds),
    )
    return PostgresClient()


# ─── slow queries land in the ring buffer ───────────────────────────────────


@pytest.mark.asyncio
async def test_slow_fetch_lands_in_ring_buffer(monkeypatch, bound_lease):
    client = _client_with_clock(monkeypatch, step_seconds=2.0)  # 2000 ms
    await client.fetch("SELECT *   FROM jobs\n WHERE org_id = $1", ORG)

    events = slow_query_mod.list_slow_queries(ORG)
    assert len(events) == 1
    event = events[0]
    assert event["org_id"] == ORG
    # Whitespace-collapsed query text; bind args never recorded.
    assert event["fingerprint"] == "SELECT * FROM jobs WHERE org_id = $1"
    assert event["duration_ms"] == pytest.approx(2000.0)
    assert event["source"] == "postgres.fetch"


@pytest.mark.asyncio
async def test_every_instrumented_wrapper_records(monkeypatch, bound_lease):
    client = _client_with_clock(monkeypatch, step_seconds=1.0)
    await client.execute("UPDATE jobs SET status = $1", "done")
    await client.executemany("INSERT INTO t VALUES ($1)", [(1,), (2,)])
    await client.fetch("SELECT 1")
    await client.fetchrow("SELECT 2")
    await client.fetchval("SELECT 3")

    sources = {e["source"] for e in slow_query_mod.list_slow_queries(ORG)}
    assert sources == {
        "postgres.execute",
        "postgres.executemany",
        "postgres.fetch",
        "postgres.fetchrow",
        "postgres.fetchval",
    }


@pytest.mark.asyncio
async def test_slow_query_recorded_even_when_query_raises(
    monkeypatch, bound_lease,
):
    class _BoomConn(_StubConn):
        async def fetchval(self, query, *args):
            raise RuntimeError("boom")

    bound_lease._stub = _BoomConn()
    client = _client_with_clock(monkeypatch, step_seconds=2.0)
    with pytest.raises(RuntimeError, match="boom"):
        await client.fetchval("SELECT pg_sleep(10)")

    events = slow_query_mod.list_slow_queries(ORG)
    assert len(events) == 1
    assert events[0]["source"] == "postgres.fetchval"


# ─── fast queries stay out ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fast_query_does_not_record(monkeypatch, bound_lease):
    client = _client_with_clock(monkeypatch, step_seconds=0.010)  # 10 ms
    await client.fetch("SELECT * FROM jobs WHERE org_id = $1", ORG)
    assert slow_query_mod.list_slow_queries(ORG) == []
    assert slow_query_mod.slow_query_count(ORG) == 0


@pytest.mark.asyncio
async def test_slow_query_without_org_context_is_dropped(monkeypatch):
    """No bound lease → no org id → the tenant-scoped recorder drops it.

    A bare bound connection (not a lease) carries no org either.
    """
    conn = _StubConn()
    token = bind_request_pg_conn(conn)
    try:
        client = _client_with_clock(monkeypatch, step_seconds=2.0)
        await client.fetch("SELECT 1")
    finally:
        reset_request_pg_conn(token)
    assert slow_query_mod.list_slow_queries(ORG) == []


# ─── recording is best-effort ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recorder_failure_never_reaches_the_query_path(
    monkeypatch, bound_lease,
):
    def _explode(**kwargs):
        raise RuntimeError("ring buffer on fire")

    monkeypatch.setattr("eden.storage.postgres.record_slow_query", _explode)
    client = _client_with_clock(monkeypatch, step_seconds=2.0)
    assert await client.fetchval("SELECT 1") == 42  # no raise


# ─── threshold env parsing ──────────────────────────────────────────────────


def test_threshold_reads_env_and_caches(monkeypatch):
    from eden.storage.postgres import _slow_query_threshold_ms

    monkeypatch.setattr(
        "eden.storage.postgres._slow_query_threshold_ms_cached", None,
    )
    monkeypatch.setenv("EDEN_SLOW_QUERY_MS", "125")
    assert _slow_query_threshold_ms() == 125.0
    # Cached: a later env change is not observed until process restart.
    monkeypatch.setenv("EDEN_SLOW_QUERY_MS", "9999")
    assert _slow_query_threshold_ms() == 125.0


def test_threshold_defaults_to_500_on_garbage(monkeypatch):
    from eden.storage.postgres import _slow_query_threshold_ms

    monkeypatch.setattr(
        "eden.storage.postgres._slow_query_threshold_ms_cached", None,
    )
    monkeypatch.setenv("EDEN_SLOW_QUERY_MS", "not-a-number")
    assert _slow_query_threshold_ms() == 500.0
