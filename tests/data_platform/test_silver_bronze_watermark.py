"""A failed Silver write must not mark the Bronze rows as done.

``run_from_bronze`` fetched up to ``limit`` (10,000) unprocessed Bronze events,
ran the batch, and then did:

    event_ids = [e["id"] for e in events]
    if event_ids:
        await self._mark_bronze_processed(event_ids)

unconditionally. But ``run_batch`` *catches* a failed ``_write_silver``, logs it,
and returns a report — so on a Postgres blip the rows were marked processed
without ever reaching Silver. They are then never re-fetched, because the
``silver_processed`` watermark has moved past them.

That is the one failure mode in this pipeline that is genuinely unrecoverable:
not deferred, not duplicated, gone. The only trace was a single ERROR line that
said the write failed and said nothing about the rows now being unreachable.

Retrying the whole batch is safe. ``silver_event_id`` is a uuid5 derived from the
Bronze id, so a re-run produces identical keys and the insert is idempotent;
deduped and quarantined events simply reach the same terminal outcome again.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.data_platform.silver_etl import ETLReport, SilverETLPipeline


class _FakeConn:
    """A pooled connection. ``_mark_bronze_processed`` goes through ``acquire``."""

    def __init__(self, log: list[str]) -> None:
        self._log = log

    async def execute(self, query: str, *args: Any) -> str:
        self._log.append(" ".join(query.split()))
        return "OK"

    async def executemany(self, query: str, args: Any) -> str:
        self._log.append(" ".join(query.split()))
        return "OK"


class _Acquire:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _FakeConn:
        return self._conn

    async def __aexit__(self, *_exc: Any) -> None:
        return None


class _FakePg:
    """Returns Bronze rows and records every statement, pooled or direct.

    ``acquire()`` matters: ``_mark_bronze_processed`` writes through a pooled
    connection, so a fake without it makes the "was it marked?" assertion pass
    for the wrong reason — the mark would raise ``AttributeError`` rather than
    being correctly skipped. (Caught exactly that way.)
    """

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows if rows is not None else []
        self.statements: list[str] = []

    def acquire(self) -> _Acquire:
        return _Acquire(_FakeConn(self.statements))

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.statements.append(" ".join(query.split()))
        return list(self.rows)

    async def execute(self, query: str, *args: Any) -> str:
        self.statements.append(" ".join(query.split()))
        return "OK"

    async def executemany(self, query: str, args: Any) -> str:
        self.statements.append(" ".join(query.split()))
        return "OK"


def _bronze_row(idx: int) -> dict[str, Any]:
    return {
        "id": f"bronze-{idx}",
        "org_id": "org-1",
        "event_type": "llm_call",
        "resource": "tokens",
        "quantity": 10,
        "unit": "tokens",
        "cost_usd": 0.01,
        "metadata": {},
        "correlation_id": f"corr-{idx}",
        "created_at": "2026-07-30T00:00:00+00:00",
    }


def _pipeline_that_reaches_the_write(pg: "_FakePg") -> SilverETLPipeline:
    """A pipeline whose events reach step 7.

    ``_validate_contracts`` (step 2) quarantines anything that does not match the
    Bronze contract, and a quarantined batch leaves ``normalized`` empty — so
    ``_write_silver`` is never called and a test about *write failure* silently
    exercises nothing. Found that way: the first version of these tests reported
    ``quarantined=2, silver_inserted=0`` and asserted against a path it had not
    entered. Contract validation is stubbed to pass everything; quality
    enforcement is off for the same reason.
    """
    pipeline = SilverETLPipeline(enforce_quality=False)

    async def _get_pg() -> "_FakePg":
        return pg

    pipeline._get_postgres = _get_pg  # type: ignore[method-assign]
    pipeline._validate_contracts = lambda events: (list(events), [])  # type: ignore[method-assign]
    return pipeline


def _marked(pg: _FakePg) -> bool:
    return any("silver_processed" in s and "UPDATE" in s.upper() for s in pg.statements)


class TestFailedWriteLeavesBronzeUnprocessed:
    @pytest.mark.asyncio
    async def test_bronze_is_not_marked_when_the_silver_write_fails(self) -> None:
        """The regression: this is unrecoverable loss, not a delay."""
        pg = _FakePg(rows=[_bronze_row(0), _bronze_row(1)])
        pipeline = _pipeline_that_reaches_the_write(pg)
        called: list[int] = []

        async def _boom(events: list[dict[str, Any]]) -> int:
            called.append(len(events))
            raise RuntimeError("pg connection reset")

        pipeline._write_silver = _boom  # type: ignore[method-assign]

        report = await pipeline.run_from_bronze(push_to_clickhouse=False)

        assert called, "the Silver write was never attempted — test proves nothing"
        assert report.silver_write_failed is True
        assert not _marked(pg), (
            "Bronze rows were marked processed after a failed Silver write — "
            "they will never be re-fetched and are lost permanently"
        )

    @pytest.mark.asyncio
    async def test_bronze_is_marked_when_the_write_succeeds(self) -> None:
        pg = _FakePg(rows=[_bronze_row(0)])
        pipeline = _pipeline_that_reaches_the_write(pg)
        called: list[int] = []

        async def _ok(events: list[dict[str, Any]]) -> int:
            called.append(len(events))
            return len(events)

        pipeline._write_silver = _ok  # type: ignore[method-assign]

        report = await pipeline.run_from_bronze(push_to_clickhouse=False)

        assert called, "the Silver write was never attempted"
        assert report.silver_write_failed is False
        assert _marked(pg), "a successful batch must advance the watermark"

    @pytest.mark.asyncio
    async def test_the_report_names_the_failure_explicitly(self) -> None:
        """A caller must be able to branch without string-matching errors."""
        assert "silver_write_failed" in ETLReport.__dataclass_fields__

    @pytest.mark.asyncio
    async def test_no_rows_is_not_a_failure(self) -> None:
        pg = _FakePg(rows=[])
        pipeline = _pipeline_that_reaches_the_write(pg)
        report = await pipeline.run_from_bronze(push_to_clickhouse=False)

        assert report.processed == 0
        assert report.silver_write_failed is False
        assert not _marked(pg)


class TestRetrySafety:
    def test_silver_ids_are_derived_not_random(self) -> None:
        """The retry argument depends on this: same input, same key.

        If ``silver_event_id`` were a uuid4, re-running the batch would insert
        duplicate rows rather than colliding, and leaving Bronze unprocessed
        would trade one bug for another.
        """
        from eden.data_platform.silver_etl import _silver_event_id

        a = _silver_event_id("bronze-1")
        b = _silver_event_id("bronze-1")
        c = _silver_event_id("bronze-2")
        assert a == b, "silver ids are not deterministic — retry would duplicate"
        assert a != c
