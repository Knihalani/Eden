"""The Silver ETL must be idempotent, and its writes must actually execute.

Four independent defects compounded into unbounded duplicate rows:

1. ``_mark_bronze_processed`` built placeholders starting at ``$2`` and passed
   a stray leading ``True`` for a ``$1`` the query never contained
   (``silver_processed = TRUE`` is a literal). asyncpg rejects a call with more
   arguments than placeholders, so Bronze events were **never** marked
   processed and every run re-read the same rows.

2. ``silver_event_id`` and ``quarantine_id`` were fresh ``uuid.uuid4()`` values.
   Both columns are primary keys and both INSERTs carry ``ON CONFLICT``, but a
   random key never conflicts — so re-processing appended a duplicate instead
   of updating. Combined with (1), each run appended a fresh copy of every
   event it had already processed.

3. ``_create_temp_table`` inserted ``rows[0]`` and then re-inserted it as part
   of the ``executemany`` batch, violating the temp table's primary key. The
   exception was swallowed by ``_validate_quality``, which logged "Quality
   validation failed" and reported zero violations — quality validation never
   ran for any batch larger than one event.

4. ``_push_clickhouse`` called ``sink.insert_silver_events(...)``, which does
   not exist; the only public entry point is ``insert(table, rows)``. Every
   ClickHouse push raised AttributeError.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.data_platform import silver_etl
from eden.data_platform.silver_etl import (
    SilverETLPipeline,
    _quarantine_id,
    _silver_event_id,
)


class TestDeterministicIds:
    def test_same_bronze_event_yields_the_same_silver_id(self) -> None:
        """This is what makes the existing ON CONFLICT clause reachable."""
        assert _silver_event_id("bronze-1") == _silver_event_id("bronze-1")

    def test_different_bronze_events_differ(self) -> None:
        assert _silver_event_id("bronze-1") != _silver_event_id("bronze-2")

    def test_silver_and_quarantine_ids_do_not_collide(self) -> None:
        """Both are primary keys in different tables; keep the spaces apart."""
        assert _silver_event_id("bronze-1") != _quarantine_id("bronze-1")

    def test_quarantine_id_is_also_stable(self) -> None:
        assert _quarantine_id("bronze-1") == _quarantine_id("bronze-1")

    @pytest.mark.parametrize("bronze", ["bronze-1", "x", "00000000-0000-0000-0000-000000000001"])
    def test_result_is_a_valid_uuid(self, bronze: str) -> None:
        uuid.UUID(_silver_event_id(bronze))
        uuid.UUID(_quarantine_id(bronze))

    @pytest.mark.parametrize("missing", [None, "", 0])
    def test_missing_bronze_id_falls_back_to_random(self, missing: Any) -> None:
        """Nothing to be idempotent about, and a NULL primary key cannot insert."""
        first, second = _silver_event_id(missing), _silver_event_id(missing)
        assert first != second
        uuid.UUID(first)

    def test_ids_are_stable_across_processes(self) -> None:
        """uuid5 is a digest, so this must not depend on process state."""
        import subprocess
        import sys
        from pathlib import Path

        repo = Path(__file__).resolve().parents[2]
        code = (
            "from eden.data_platform.silver_etl import _silver_event_id;"
            "print(_silver_event_id('bronze-1'))"
        )
        outs = {
            subprocess.run(
                [sys.executable, "-c", code],
                capture_output=True,
                text=True,
                cwd=repo,
                env={"PYTHONPATH": str(repo / "src"), "PATH": "/usr/bin:/bin"},
            ).stdout.strip()
            for _ in range(2)
        }
        assert len(outs) == 1 and outs != {""}, f"unstable across processes: {outs}"


class _FakeConn:
    def __init__(self) -> None:
        self.executemany_calls: list[tuple[str, list[Any]]] = []

    async def executemany(self, query: str, rows: list[Any]) -> None:
        self.executemany_calls.append((query, list(rows)))

    async def __aenter__(self) -> _FakeConn:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None


class _FakeClient:
    """Records statements and enforces the placeholder/argument contract."""

    def __init__(self) -> None:
        self.conn = _FakeConn()
        self.execute_calls: list[tuple[str, tuple[Any, ...]]] = []

    def acquire(self) -> _FakeConn:
        return self.conn

    async def execute(self, query: str, *args: Any) -> str:
        import re

        # Mirror asyncpg: passing more arguments than the statement has
        # placeholders is an error, not something silently ignored.
        placeholders = {int(m) for m in re.findall(r"\$(\d+)", query)}
        expected = max(placeholders) if placeholders else 0
        if len(args) != expected:
            raise ValueError(
                f"the server expects {expected} argument(s), {len(args)} were passed"
            )
        self.execute_calls.append((query, args))
        return "UPDATE 1"


class TestMarkBronzeProcessed:
    @pytest.mark.asyncio
    async def test_argument_count_matches_placeholders(self) -> None:
        """The stray leading ``True`` made asyncpg reject every call."""
        pipeline = SilverETLPipeline()
        client = _FakeClient()
        pipeline._get_postgres = AsyncMock(return_value=client)  # type: ignore[method-assign]

        await pipeline._mark_bronze_processed(["e1", "e2", "e3"])

        assert len(client.execute_calls) == 1
        query, args = client.execute_calls[0]
        assert args == ("e1", "e2", "e3")
        assert "$1" in query and "$4" not in query

    @pytest.mark.asyncio
    async def test_empty_list_is_a_noop(self) -> None:
        pipeline = SilverETLPipeline()
        client = _FakeClient()
        pipeline._get_postgres = AsyncMock(return_value=client)  # type: ignore[method-assign]
        await pipeline._mark_bronze_processed([])
        assert client.execute_calls == []

    @pytest.mark.asyncio
    async def test_chunks_larger_than_the_limit(self) -> None:
        pipeline = SilverETLPipeline()
        client = _FakeClient()
        pipeline._get_postgres = AsyncMock(return_value=client)  # type: ignore[method-assign]
        await pipeline._mark_bronze_processed([f"e{i}" for i in range(2500)])
        assert len(client.execute_calls) == 3
        assert sum(len(a) for _, a in client.execute_calls) == 2500


class TestTempTableInsert:
    @pytest.mark.asyncio
    async def test_first_row_is_not_inserted_twice(self) -> None:
        """The double-insert violated the temp table's primary key."""
        pipeline = SilverETLPipeline()
        client = _FakeClient()
        events = [{"silver_event_id": f"id-{i}"} for i in range(3)]

        await pipeline._create_temp_table(client, "_tmp", events)

        # Exactly one batch, containing each id exactly once.
        assert len(client.conn.executemany_calls) == 1
        _query, rows = client.conn.executemany_calls[0]
        assert rows == [("id-0",), ("id-1",), ("id-2",)]

    @pytest.mark.asyncio
    async def test_empty_event_list_inserts_nothing(self) -> None:
        pipeline = SilverETLPipeline()
        client = _FakeClient()
        await pipeline._create_temp_table(client, "_tmp", [])
        assert client.conn.executemany_calls == []


class TestClickHousePush:
    @pytest.mark.asyncio
    async def test_uses_the_sink_method_that_exists(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``insert_silver_events`` is not a method on the sink."""
        sink = MagicMock()
        sink.insert = AsyncMock()
        # A MagicMock would happily accept insert_silver_events; assert against
        # the real class instead so a rename is caught.
        from eden.data_platform import clickhouse_sink as cs

        assert not hasattr(cs.ClickHouseSink, "insert_silver_events")
        assert hasattr(cs.ClickHouseSink, "insert")

        monkeypatch.setattr(
            silver_etl, "get_clickhouse_sink", AsyncMock(return_value=sink)
        )
        pipeline = SilverETLPipeline()
        await pipeline._push_clickhouse([{"silver_event_id": "id-1"}])

        sink.insert.assert_awaited_once()
        table, rows = sink.insert.await_args.args
        assert table == "silver_events"
        assert len(rows) == 1

    @pytest.mark.asyncio
    async def test_absent_sink_is_tolerated(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            silver_etl, "get_clickhouse_sink", AsyncMock(return_value=None)
        )
        pipeline = SilverETLPipeline()
        await pipeline._push_clickhouse([{"silver_event_id": "id-1"}])
