"""The judge-score cursor must not step over rows it never read.

``_process_tenant`` paginated ``judge_scores`` with

    WHERE tenant_id = $1 AND judge_run_id > $2
    ORDER BY scored_at ASC
    LIMIT $3

and then advanced the cursor to ``max(judge_run_id)`` in the batch.

``judge_run_id`` is a UUID (migration 018). It has no time ordering, so the
filter column and the sort column were unrelated: the query returned the
oldest-scored rows whose random id happened to exceed a random cursor, and the
cursor then jumped to the largest random id seen. Every unread row whose id
sorted below that value became permanently invisible — about half the stream
after the first tick, approaching all of it as the cursor climbed toward
``ffff…``. The loop went quiet instead of failing, so nothing reported it.

The fix filters and sorts on the same tuple, ``(scored_at, judge_run_id)``, and
advances to the *last row of the batch in that order*. These tests pin both
halves: the cursor's shape, and the property that matters — full coverage with
no duplicates across successive batches.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from eden.insights.detector_loop import InsightsDetectorLoop


def _rows(n: int, *, seed: int = 0) -> list[dict[str, Any]]:
    """Rows whose UUID order deliberately disagrees with their time order."""
    rng = uuid.UUID(int=0)
    base = datetime(2026, 7, 1, tzinfo=UTC)
    out = []
    for i in range(n):
        # Force the id ordering to be the *reverse* of the time ordering, the
        # worst case for the old cursor.
        out.append(
            {
                "judge_run_id": uuid.UUID(int=(n - i) * 1_000_003 + seed),
                "scored_at": base + timedelta(minutes=i),
                "tenant_id": "t-1",
            }
        )
    del rng
    return out


class TestBatchCursor:
    def test_uses_the_last_row_not_the_max_id(self) -> None:
        """``max(judge_run_id)`` is the bug; the batch tail is the fix."""
        rows = _rows(5)
        cursor = InsightsDetectorLoop._batch_cursor(rows)
        assert cursor is not None
        scored_at, run_id = cursor
        assert scored_at == rows[-1]["scored_at"]
        assert run_id == str(rows[-1]["judge_run_id"])

        # And it is emphatically *not* the max id, because the ids here run
        # opposite to time.
        max_id = max(str(r["judge_run_id"]) for r in rows)
        assert run_id != max_id, "fixture failed to create the disagreement"

    def test_empty_batch_has_no_cursor(self) -> None:
        assert InsightsDetectorLoop._batch_cursor([]) is None

    def test_cursor_is_a_scored_at_uuid_pair(self) -> None:
        cursor = InsightsDetectorLoop._batch_cursor(_rows(1))
        assert cursor is not None
        assert isinstance(cursor[0], datetime)
        uuid.UUID(cursor[1])


class TestKeysetCoversEveryRow:
    """Simulate the pagination both ways and compare coverage."""

    @staticmethod
    def _paginate_keyset(rows: list[dict[str, Any]], size: int) -> list[Any]:
        """What the fixed loop does: filter and sort on the same tuple."""
        ordered = sorted(rows, key=lambda r: (r["scored_at"], str(r["judge_run_id"])))
        seen: list[Any] = []
        cursor: tuple[Any, str] | None = None
        while True:
            if cursor is None:
                page = ordered[:size]
            else:
                page = [
                    r
                    for r in ordered
                    if (r["scored_at"], str(r["judge_run_id"])) > cursor
                ][:size]
            if not page:
                break
            seen.extend(page)
            cursor = InsightsDetectorLoop._batch_cursor(page)
        return seen

    @staticmethod
    def _paginate_old(rows: list[dict[str, Any]], size: int) -> list[Any]:
        """What the old loop did: filter on id, sort on time, advance to max id."""
        seen: list[Any] = []
        cursor: str | None = None
        for _ in range(50):  # bounded; the old scheme can stall
            candidates = [
                r for r in rows if cursor is None or str(r["judge_run_id"]) > cursor
            ]
            page = sorted(candidates, key=lambda r: r["scored_at"])[:size]
            if not page:
                break
            seen.extend(page)
            cursor = max(str(r["judge_run_id"]) for r in page)
        return seen

    def test_keyset_reads_every_row_exactly_once(self) -> None:
        rows = _rows(50)
        seen = self._paginate_keyset(rows, size=7)
        ids = [str(r["judge_run_id"]) for r in seen]
        assert len(ids) == len(set(ids)), "a row was read twice"
        assert set(ids) == {str(r["judge_run_id"]) for r in rows}, "a row was skipped"

    def test_the_old_scheme_demonstrably_skipped_rows(self) -> None:
        """Guards the premise: if this ever passes, the bug was imaginary."""
        rows = _rows(50)
        old = {str(r["judge_run_id"]) for r in self._paginate_old(rows, size=7)}
        every = {str(r["judge_run_id"]) for r in rows}
        assert old != every, (
            "the id-filter/time-sort scheme covered everything in this "
            "fixture — the fixture no longer reproduces the bug"
        )
        assert len(every - old) > 0

    @pytest.mark.parametrize("size", [1, 2, 7, 49, 50, 51])
    def test_coverage_holds_at_every_batch_size(self, size: int) -> None:
        rows = _rows(50)
        seen = self._paginate_keyset(rows, size=size)
        assert {str(r["judge_run_id"]) for r in seen} == {
            str(r["judge_run_id"]) for r in rows
        }

    def test_ties_on_scored_at_are_still_totally_ordered(self) -> None:
        """Identical timestamps must not cause a skip or an infinite loop."""
        same = datetime(2026, 7, 1, tzinfo=UTC)
        rows = [
            {"judge_run_id": uuid.UUID(int=i), "scored_at": same, "tenant_id": "t-1"}
            for i in range(1, 11)
        ]
        seen = self._paginate_keyset(rows, size=3)
        ids = [str(r["judge_run_id"]) for r in seen]
        assert len(ids) == 10 and len(set(ids)) == 10


class TestWatermarkPersistence:
    @pytest.mark.asyncio
    async def test_upsert_writes_both_halves(self) -> None:
        """A UUID without its timestamp cannot seed a composite keyset."""
        calls: list[tuple[str, tuple[Any, ...]]] = []

        class _Client:
            async def execute(self, sql: str, *args: Any) -> str:
                calls.append((sql, args))
                return "INSERT 0 1"

        scored_at = datetime(2026, 7, 1, tzinfo=UTC)
        run_id = str(uuid.UUID(int=7))
        await InsightsDetectorLoop._upsert_watermark(
            _Client(), "t-1", (scored_at, run_id)
        )

        assert calls, "no statement was issued"
        sql, args = calls[0]
        assert "last_processed_scored_at" in sql
        assert args[0] == "t-1"
        assert args[1] == uuid.UUID(run_id)
        assert args[2] == scored_at

    @pytest.mark.asyncio
    async def test_none_cursor_writes_nulls(self) -> None:
        calls: list[tuple[Any, ...]] = []

        class _Client:
            async def execute(self, sql: str, *args: Any) -> str:
                calls.append(args)
                return "INSERT 0 1"

        await InsightsDetectorLoop._upsert_watermark(_Client(), "t-1", None)
        assert calls[0][1] is None and calls[0][2] is None

    @pytest.mark.asyncio
    async def test_half_populated_row_reads_as_no_cursor(self) -> None:
        """Migration 122 nulls the old cursors; a partial row must restart."""

        class _Client:
            def __init__(self, row: dict[str, Any] | None) -> None:
                self._row = row

            async def fetchrow(self, _sql: str, *_args: Any) -> dict[str, Any] | None:
                return self._row

        # Old-style row: id present, timestamp missing.
        client = _Client(
            {
                "last_processed_judge_score_id": uuid.UUID(int=7),
                "last_processed_scored_at": None,
            }
        )
        assert await InsightsDetectorLoop._read_watermark(client, "t-1") is None

        # Fully reset row.
        client = _Client(
            {
                "last_processed_judge_score_id": None,
                "last_processed_scored_at": None,
            }
        )
        assert await InsightsDetectorLoop._read_watermark(client, "t-1") is None

    @pytest.mark.asyncio
    async def test_complete_row_reads_as_a_pair(self) -> None:
        scored_at = datetime(2026, 7, 1, tzinfo=UTC)

        class _Client:
            async def fetchrow(self, _sql: str, *_args: Any) -> dict[str, Any]:
                return {
                    "last_processed_judge_score_id": uuid.UUID(int=7),
                    "last_processed_scored_at": scored_at,
                }

        got = await InsightsDetectorLoop._read_watermark(_Client(), "t-1")
        assert got == (scored_at, str(uuid.UUID(int=7)))


class TestTenantSelectionUsesTheSameKeyset:
    """The per-tenant page and the tenant-selection gate must agree.

    Found in review: ``_process_tenant`` was converted to the composite keyset
    and migration 122 supplied the column and index, but
    ``_list_tenants_with_new_scores`` still asked
    ``j.judge_run_id > w.last_processed_judge_score_id``. That gate decides
    which tenants ``_process_tenant`` is called for at all, so a tenant whose
    newest run id happened to sort below its stored watermark UUID was never
    selected -- and the composite fix only worked for the single tick after
    122's reset, after which the random-UUID skipping came straight back.
    """

    @staticmethod
    def _selection_sql() -> str:
        import inspect

        from eden.insights.detector_loop import InsightsDetectorLoop

        src = inspect.getsource(InsightsDetectorLoop._list_tenants_with_new_scores)
        return " ".join(src.split())

    def test_selection_compares_the_composite_tuple(self) -> None:
        sql = self._selection_sql()
        assert "(j.scored_at, j.judge_run_id)" in sql, (
            "the tenant-selection gate does not use the composite keyset"
        )

    def test_selection_no_longer_compares_run_id_alone(self) -> None:
        sql = self._selection_sql()
        assert "OR j.judge_run_id > w.last_processed_judge_score_id" not in sql, (
            "the bare UUID comparison is back in the tenant-selection gate"
        )

    def test_selection_treats_either_missing_half_as_no_cursor(self) -> None:
        """Must match ``_read_watermark``, which returns None for a half row."""
        sql = self._selection_sql()
        assert "w.last_processed_scored_at IS NULL" in sql
        assert "w.last_processed_judge_score_id IS NULL" in sql
