"""A batch ingest under a pinned RLS connection must not lose events.

``ingest_batch`` fans routing out with ``asyncio.gather``, and ``_route`` fans
the six sinks out the same way. So a batch of N issues N concurrent Postgres
INSERTs from one task.

``RLSOrgContextMiddleware`` pins one pooled connection per request, and
``PostgresClient.acquire`` hands that same connection to every caller in the
request's context. asyncpg allows exactly one operation in flight per
connection -- verified directly: 8 concurrent statements on one connection, 7
fail with ``InterfaceError: cannot perform operation: another operation is in
progress``.

Put together, a batch of 10 stored 1 row and lost 9. Not visibly: the gather
has ``return_exceptions=True``, so the failures were counted as
``queue/write_error``, logged at ERROR, and the response still reported
``accepted: 10``. The SDK acks on 2xx and discards its copy.

Reachable through the documented setup: ``POST
/orgs/{org_id}/telemetry/ingest/batch`` authenticates with ``X-Org-Api-Key`` +
``X-Org-Id``, and ``_has_verified_identity`` accepts that pair, so
``_resolve_org_id`` returns the header org and the lease binds. The TS SDK
sends ``X-Org-Id`` whenever ``orgId`` is configured (``client.ts:1067``).

The fake connection below enforces asyncpg's one-operation rule rather than
mocking it away -- a fake that tolerates concurrent statements would make this
whole file pass while the product lost rows.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.observability.drop_metrics import get_drop_metrics, reset_for_tests
from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent
from eden.storage.postgres import (
    PostgresClient,
    RequestConnLease,
    bind_request_pg_lease,
    reset_request_pg_conn,
)

BATCH = 10


@pytest.fixture(autouse=True)
def _reset_drops():
    reset_for_tests()
    yield
    reset_for_tests()


def _event(idx: int) -> TelemetryEvent:
    return TelemetryEvent(
        event_id=f"evt-{idx}",
        tenant_id="11111111-1111-1111-1111-111111111111",
        project_id="proj-1",
        trace_id=f"trace-{idx}",
        realm="production",
        event_type="llm.completion",
        timestamp=datetime.now(UTC).isoformat(),
    )


class _SingleOperationConn:
    """A connection that behaves like asyncpg: one operation at a time.

    Raises rather than queueing, and yields control mid-statement so
    concurrent callers genuinely overlap.
    """

    def __init__(self) -> None:
        self.busy = False
        self.executed: list[str] = []
        self.conflicts = 0
        self.rows = 0

    async def _op(self, query: str) -> None:
        if self.busy:
            self.conflicts += 1
            raise RuntimeError(
                "cannot perform operation: another operation is in progress"
            )
        self.busy = True
        try:
            await asyncio.sleep(0)  # a real statement awaits the socket
            self.executed.append(query)
        finally:
            self.busy = False

    @staticmethod
    def _is_telemetry_insert(query: str) -> bool:
        return "INSERT INTO telemetry_events" in query

    async def execute(self, query: str, *args: Any) -> str:
        await self._op(query)
        # Count only telemetry rows. Counting every statement made the row
        # total 11 for a 10-event batch, because the lease's own
        # ``set_config`` comes through here too.
        if self._is_telemetry_insert(query):
            self.rows += 1
        return "INSERT 0 1"

    async def executemany(self, query: str, args: Any) -> None:
        """One statement, N rows -- what the batch write now issues."""
        batch = list(args)
        await self._op(query)
        if self._is_telemetry_insert(query):
            self.rows += len(batch)

    async def fetch(self, query: str, *args: Any) -> list[Any]:
        await self._op(query)
        return []

    async def fetchrow(self, query: str, *args: Any) -> Any:
        await self._op(query)
        return None

    async def fetchval(self, query: str, *args: Any) -> Any:
        await self._op(query)
        return None

    def transaction(self) -> Any:
        return _NullCtx()

    async def close(self) -> None:
        return None

    def inserts(self) -> int:
        """Rows written, not statements issued.

        Counting statements would have made this test start passing for the
        wrong reason once the write became a single ``executemany``: one
        statement, whether it carried 10 rows or 1.
        """
        return self.rows

    def insert_statements(self) -> int:
        return sum(1 for q in self.executed if "INSERT INTO telemetry_events" in q)


class _NullCtx:
    async def __aenter__(self) -> Any:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _Pool:
    def __init__(self, conn: _SingleOperationConn) -> None:
        self.conn = conn
        self.acquires = 0

    def acquire(self) -> Any:
        self.acquires += 1
        return _ConnCtx(self.conn)


class _ConnCtx:
    def __init__(self, conn: _SingleOperationConn) -> None:
        self.connection = conn

    async def __aenter__(self) -> _SingleOperationConn:
        return self.connection

    async def __aexit__(self, *exc: Any) -> None:
        return None


@pytest.fixture
def pinned():
    """Bind a lease over a single-operation connection, as a request would."""
    conn = _SingleOperationConn()
    pool = _Pool(conn)

    class _Client:
        _pool = pool

        async def initialize(self) -> None:
            return None

    lease = RequestConnLease(
        "11111111-1111-1111-1111-111111111111", _Client()
    )
    token = bind_request_pg_lease(lease)
    try:
        yield conn, pool, lease
    finally:
        reset_request_pg_conn(token)


@pytest.fixture
def collector_pg_only(monkeypatch: pytest.MonkeyPatch) -> TelemetryCollector:
    """A collector whose only live sink is Postgres.

    The other five are stubbed so a failure is unambiguously the Postgres
    write, and so this test does not depend on Redis/ClickHouse/Typesense
    being reachable.
    """
    collector = TelemetryCollector()
    for sink in (
        "_route_redis",
        "_route_clickhouse",
        "_route_websocket",
        "_route_otel_dual_emit",
        "_route_typesense",
    ):
        monkeypatch.setattr(collector, sink, AsyncMock(return_value=None))
    monkeypatch.setattr(collector, "_spawn_bg", lambda coro: coro.close())
    return collector


@pytest.mark.asyncio
async def test_every_event_in_a_batch_lands_on_a_pinned_connection(
    collector_pg_only: TelemetryCollector,
    pinned: tuple[_SingleOperationConn, _Pool, RequestConnLease],
) -> None:
    """The regression: 10 events in, 10 INSERTs out.

    Pre-fix this stored 1 and lost 9, while returning ``accepted: 10``.
    """
    conn, _pool, _lease = pinned
    events = [_event(i) for i in range(BATCH)]

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=PostgresClient()),
    ):
        result = await collector_pg_only.ingest_batch(events)

    assert conn.inserts() == BATCH, (
        f"only {conn.inserts()}/{BATCH} events reached Postgres; "
        f"{conn.conflicts} statement(s) collided on the pinned connection. "
        "Concurrent INSERTs share one connection under RLS and asyncpg "
        "permits one operation at a time."
    )
    assert result["accepted"] == BATCH
    assert conn.conflicts == 0, (
        f"{conn.conflicts} statement(s) still collided on the pinned connection"
    )
    assert conn.insert_statements() == 1, (
        f"{conn.insert_statements()} INSERT statements for {BATCH} events; the "
        "batch must be written with a single executemany (measured 2.56-3.42x "
        "faster than N separate INSERTs, and more over the production DSN)"
    )


@pytest.mark.asyncio
async def test_no_write_error_drops_are_recorded_for_a_healthy_batch(
    collector_pg_only: TelemetryCollector,
    pinned: tuple[_SingleOperationConn, _Pool, RequestConnLease],
) -> None:
    """The drop counter is how this bug was *supposed* to be visible.

    It fired -- ``queue/write_error`` -- but nothing alerted on it, and the
    response stayed 2xx. Assert it stays at zero so a regression shows up as a
    failing test rather than as a metric nobody is watching.
    """
    events = [_event(i) for i in range(BATCH)]
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=PostgresClient()),
    ):
        await collector_pg_only.ingest_batch(events)

    dropped = get_drop_metrics().get(("queue", "write_error"), 0)
    assert dropped == 0, (
        f"{dropped} event(s) counted as write_error on a batch that should "
        "have fully succeeded"
    )


@pytest.mark.asyncio
async def test_the_reproduction_would_fail_without_the_fix(
    pinned: tuple[_SingleOperationConn, _Pool, RequestConnLease],
) -> None:
    """Prove the fake really does enforce asyncpg's constraint.

    Without this, the tests above could pass because the fake tolerates
    overlap -- which is exactly the mistake that would let the real bug back
    in. Here the statements are issued straight at the connection, bypassing
    whatever serialisation ``acquire`` provides.
    """
    conn, _pool, _lease = pinned
    results = await asyncio.gather(
        *(conn.execute(f"SELECT {i}") for i in range(BATCH)),
        return_exceptions=True,
    )
    failures = [r for r in results if isinstance(r, BaseException)]
    assert len(failures) == BATCH - 1, (
        "the fake connection is not enforcing one-operation-at-a-time, so the "
        f"tests above prove nothing ({len(failures)} of {BATCH} failed)"
    )
