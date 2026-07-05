"""Unit tests for Phase S — Dataset-as-spreadsheet.

What's covered:

  Filter helpers (6 tests)
  ──────────────────────
  * No filter → all rows
  * == operator
  * != operator
  * contains
  * starts_with
  * numeric comparison

  Sort helpers (4 tests)
  ────────────────────
  * No sort → original order
  * Single-column asc
  * Single-column desc
  * Multi-column

  AI column generation (4 tests)
  ────────────────────────────
  * Default handler returns stub
  * Custom handler invoked per row
  * Empty rows list returns empty dict
  * Custom prompt passed

  JSONL import / export (4 tests)
  ──────────────────────────────
  * rows_to_jsonl produces valid JSONL
  * jsonl_to_rows parses each line
  * Round-trip preserves data
  * Empty input returns empty list

  SpreadsheetService (8 tests)
  ──────────────────────────
  * add_column persists
  * list_columns returns in order
  * add_row persists with values
  * list_rows with filter
  * list_rows with sort
  * update_row changes values
  * get_row returns by id
  * export_rows returns JSONL

  SpreadsheetColumn / SpreadsheetRow (4 tests)
  ──────────────────────────────────────────
  * Column to_dict
  * Column defaults
  * Row to_dict
  * Row defaults
"""

from __future__ import annotations

import contextlib
import json
from typing import Any, Optional
from unittest.mock import AsyncMock

import pytest

from eden.datasets.spreadsheet import (
    SpreadsheetColumn,
    SpreadsheetRow,
    SpreadsheetService,
    apply_filter,
    apply_sort,
    default_ai_handler,
    generate_column,
    jsonl_to_rows,
    rows_to_jsonl,
)

# ─- Fake PG ──────────────────────────────────────────────────────


class FakePg:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []
        self._rows: list[dict[str, Any]] = []
        self._cols: list[dict[str, Any]] = []

    async def execute(self, query: str, *args: Any) -> str:
        self.calls.append((query.strip().lower(), args))
        sql = " ".join(query.strip().lower().split())
        if sql.startswith("insert into dataset_items"):
            row_id, dataset_id, input_, expected_output, payload = args
            if isinstance(payload, str):
                payload = json.loads(payload)
            self._rows.append({
                "id": row_id, "dataset_id": dataset_id,
                "input": input_, "expected_output": expected_output,
                "payload": payload or {},
                "created_at": "2026-06-17T12:00:00+00:00",
                "updated_at": "2026-06-17T12:00:00+00:00",
            })
            return "INSERT 0 1"
        if sql.startswith("insert into dataset_columns"):
            col_id, dataset_id, name, type_, source, description = args
            self._cols.append({
                "id": col_id, "dataset_id": dataset_id,
                "name": name, "type": type_, "source": source,
                "description": description,
                "created_at": "2026-06-17T12:00:00+00:00",
            })
            return "INSERT 0 1"
        if sql.startswith("update dataset_items"):
            row_id = args[-1]
            for r in self._rows:
                if r["id"] == row_id:
                    r["updated_at"] = "2026-06-17T12:00:00+00:00"
                    if len(args) >= 2:
                        payload = args[-2]
                        if isinstance(payload, str):
                            with contextlib.suppress(ValueError, TypeError):
                                payload = json.loads(payload)
                        if isinstance(payload, dict):
                            r["payload"] = payload
                    break
            return "UPDATE 1"
        if sql.startswith("delete from dataset_items"):
            row_id = args[0]
            self._rows = [r for r in self._rows if r["id"] != row_id]
            return "DELETE 1"
        return "OK"

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        sql = " ".join(query.strip().lower().split())
        if "from dataset_columns" in sql:
            dataset_id = args[0] if args else None
            return [c for c in self._cols if c["dataset_id"] == dataset_id]
        if "from dataset_items" in sql:
            # Different WHERE clauses:
            # - list_rows: WHERE dataset_id = $1, ORDER BY, LIMIT
            # - get_row: WHERE id = $1
            if "where id" in sql:
                row_id = args[0] if args else None
                return [r for r in self._rows if r["id"] == row_id]
            dataset_id = args[0] if args else None
            return [r for r in self._rows if r["dataset_id"] == dataset_id]
        return []

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        if "from dataset_items" in query.lower() and "where id" in query.lower():
            row_id = args[0]
            for r in self._rows:
                if r["id"] == row_id:
                    return r
        return None


def _row(input_: str, expected: str = "", values: dict | None = None) -> SpreadsheetRow:
    return SpreadsheetRow(
        id=str(id(values)) + "-" + input_[:3],
        dataset_id="d1",
        input=input_,
        expected_output=expected,
        values=values or {},
    )


# ─- Filter ───────────────────────────────────────────────────────


class TestApplyFilter:
    def test_no_filter_returns_all(self) -> None:
        rows = [_row("a"), _row("b"), _row("c")]
        assert apply_filter(rows, []) == rows

    def test_eq_operator(self) -> None:
        rows = [_row("a"), _row("b"), _row("a")]
        out = apply_filter(rows, [{"column": "input", "op": "==", "value": "a"}])
        assert len(out) == 2
        assert all(r.input == "a" for r in out)

    def test_neq_operator(self) -> None:
        rows = [_row("a"), _row("b"), _row("a")]
        out = apply_filter(rows, [{"column": "input", "op": "!=", "value": "a"}])
        assert len(out) == 1
        assert out[0].input == "b"

    def test_contains(self) -> None:
        rows = [_row("apple"), _row("banana"), _row("pineapple")]
        out = apply_filter(rows, [{"column": "input", "op": "contains", "value": "apple"}])
        assert len(out) == 2

    def test_starts_with(self) -> None:
        rows = [_row("apple"), _row("banana"), _row("pineapple")]
        out = apply_filter(rows, [{"column": "input", "op": "starts_with", "value": "a"}])
        assert len(out) == 1
        assert out[0].input == "apple"

    def test_numeric_gt(self) -> None:
        rows = [_row("5"), _row("10"), _row("15")]
        out = apply_filter(rows, [{"column": "input", "op": ">", "value": "7"}])
        assert len(out) == 2
        assert {r.input for r in out} == {"10", "15"}


# ─- Sort ────────────────────────────────────────────────────────


class TestApplySort:
    def test_no_sort_preserves_order(self) -> None:
        rows = [_row("c"), _row("a"), _row("b")]
        assert apply_sort(rows, []) == rows

    def test_single_asc(self) -> None:
        rows = [_row("c"), _row("a"), _row("b")]
        out = apply_sort(rows, [{"column": "input", "direction": "asc"}])
        assert [r.input for r in out] == ["a", "b", "c"]

    def test_single_desc(self) -> None:
        rows = [_row("a"), _row("c"), _row("b")]
        out = apply_sort(rows, [{"column": "input", "direction": "desc"}])
        assert [r.input for r in out] == ["c", "b", "a"]

    def test_multi_column(self) -> None:
        rows = [
            _row("a", "1"),
            _row("a", "2"),
            _row("b", "1"),
            _row("b", "2"),
        ]
        out = apply_sort(rows, [
            {"column": "input", "direction": "asc"},
            {"column": "expected_output", "direction": "desc"},
        ])
        # Within "a", expected desc → 2, 1. Within "b", expected desc → 2, 1.
        assert [r.expected_output for r in out] == ["2", "1", "2", "1"]


# ─- AI column generation ────────────────────────────────────


class TestGenerateColumn:
    @pytest.mark.asyncio
    async def test_default_handler_returns_stub(self) -> None:
        col = SpreadsheetColumn(
            id="c1", name="sentiment", type="text", source="ai",
            description="positive or negative?",
        )
        rows = [_row("I love this!"), _row("I hate this!")]
        out = await generate_column(col, rows)
        assert "I love this!" in out or any(
            "stub:positive" in v for v in out.values()
        )

    @pytest.mark.asyncio
    async def test_custom_handler_invoked_per_row(self) -> None:
        col = SpreadsheetColumn(
            id="c1", name="summary", type="text", source="ai",
            description="summarize",
        )
        rows = [_row("a"), _row("b"), _row("c")]
        seen: list[dict] = []
        async def handler(prompt, row):
            seen.append(row)
            return f"summary-{row['input']}"
        out = await generate_column(col, rows, handler=handler)
        assert len(seen) == 3
        assert out[rows[0].id] == "summary-a"
        assert out[rows[1].id] == "summary-b"

    @pytest.mark.asyncio
    async def test_empty_rows_returns_empty(self) -> None:
        col = SpreadsheetColumn(
            id="c1", name="x", type="text", source="ai",
        )
        out = await generate_column(col, [])
        assert out == {}

    @pytest.mark.asyncio
    async def test_custom_prompt_passed(self) -> None:
        col = SpreadsheetColumn(
            id="c1", name="x", type="text", source="ai",
            description="my custom prompt",
        )
        seen_prompts: list[str] = []
        async def handler(prompt, row):
            seen_prompts.append(prompt)
            return "x"
        await generate_column(col, [_row("a")], handler=handler)
        assert seen_prompts[0] == "my custom prompt"


# ─- JSONL ───────────────────────────────────────────────────────


class TestJsonl:
    def test_rows_to_jsonl(self) -> None:
        rows = [_row("a", "b"), _row("c", "d")]
        out = rows_to_jsonl(rows)
        lines = out.split("\n")
        assert len(lines) == 2
        for line in lines:
            json.loads(line)  # valid JSON

    def test_jsonl_to_rows(self) -> None:
        text = '{"id": "r1", "input": "a", "expected_output": "b", "values": {}}\n{"id": "r2", "input": "c", "expected_output": "d", "values": {}}'
        rows = jsonl_to_rows(text, "d1")
        assert len(rows) == 2
        assert rows[0].input == "a"
        assert rows[1].input == "c"

    def test_round_trip(self) -> None:
        rows = [_row("a", "b", {"c1": "v"}), _row("c", "d", {"c1": "w"})]
        text = rows_to_jsonl(rows)
        loaded = jsonl_to_rows(text, "d1")
        assert len(loaded) == 2
        assert loaded[0].values == {"c1": "v"}

    def test_empty_input(self) -> None:
        assert jsonl_to_rows("", "d1") == []
        assert jsonl_to_rows("\n\n", "d1") == []


# ─- SpreadsheetService ────────────────────────────────────


class TestSpreadsheetService:
    @pytest.mark.asyncio
    async def test_add_column_persists(self) -> None:
        pg = FakePg()
        svc = SpreadsheetService(pg)
        col = await svc.add_column(
            dataset_id="d1", name="sentiment", type="text",
            source="ai", description="positive or negative?",
        )
        assert col.id
        assert col.name == "sentiment"
        # Verify it was stored.
        assert any(
            c["name"] == "sentiment" for c in pg._cols
        )

    @pytest.mark.asyncio
    async def test_list_columns_returns_in_order(self) -> None:
        pg = FakePg()
        svc = SpreadsheetService(pg)
        await svc.add_column(dataset_id="d1", name="a")
        await svc.add_column(dataset_id="d1", name="b")
        cols = await svc.list_columns("d1")
        names = [c.name for c in cols]
        assert names == ["a", "b"]

    @pytest.mark.asyncio
    async def test_add_row_persists_with_values(self) -> None:
        pg = FakePg()
        svc = SpreadsheetService(pg)
        row = await svc.add_row(
            dataset_id="d1", input="hello", expected_output="world",
            values={"c1": "v1"},
        )
        assert row.values == {"c1": "v1"}
        # Verify it was stored.
        assert any(r["input"] == "hello" for r in pg._rows)

    @pytest.mark.asyncio
    async def test_list_rows_with_filter(self) -> None:
        pg = FakePg()
        svc = SpreadsheetService(pg)
        await svc.add_row(dataset_id="d1", input="apple")
        await svc.add_row(dataset_id="d1", input="banana")
        rows = await svc.list_rows(
            "d1", filter_spec=[{"column": "input", "op": "==", "value": "apple"}],
        )
        assert len(rows) == 1
        assert rows[0].input == "apple"

    @pytest.mark.asyncio
    async def test_list_rows_with_sort(self) -> None:
        pg = FakePg()
        svc = SpreadsheetService(pg)
        await svc.add_row(dataset_id="d1", input="c")
        await svc.add_row(dataset_id="d1", input="a")
        await svc.add_row(dataset_id="d1", input="b")
        rows = await svc.list_rows(
            "d1", sort_spec=[{"column": "input", "direction": "asc"}],
        )
        assert [r.input for r in rows] == ["a", "b", "c"]

    @pytest.mark.asyncio
    async def test_update_row_changes_values(self) -> None:
        pg = FakePg()
        svc = SpreadsheetService(pg)
        row = await svc.add_row(dataset_id="d1", input="a")
        await svc.update_row(row_id=row.id, values={"c1": "new"})
        fetched = await svc.get_row(row.id)
        assert fetched.values == {"c1": "new"}

    @pytest.mark.asyncio
    async def test_get_row_returns_by_id(self) -> None:
        pg = FakePg()
        svc = SpreadsheetService(pg)
        row = await svc.add_row(dataset_id="d1", input="hello")
        fetched = await svc.get_row(row.id)
        assert fetched is not None
        assert fetched.input == "hello"

    @pytest.mark.asyncio
    async def test_export_rows_returns_jsonl(self) -> None:
        pg = FakePg()
        svc = SpreadsheetService(pg)
        await svc.add_row(dataset_id="d1", input="a")
        await svc.add_row(dataset_id="d1", input="b")
        out = await svc.export_rows("d1")
        lines = out.split("\n")
        assert len(lines) == 2


# ─- Dataclass ───────────────────────────────────────────────────


class TestDataclass:
    def test_column_to_dict(self) -> None:
        c = SpreadsheetColumn(
            id="c", name="x", type="text", source="user",
            description="d",
        )
        d = c.to_dict()
        assert d["id"] == "c"
        assert d["name"] == "x"

    def test_column_defaults(self) -> None:
        c = SpreadsheetColumn(id="c", name="x", type="text", source="user")
        assert c.description == ""
        assert c.created_at == ""

    def test_row_to_dict(self) -> None:
        r = SpreadsheetRow(
            id="r", dataset_id="d", input="i",
            expected_output="o", values={"c1": "v"},
        )
        d = r.to_dict()
        assert d["id"] == "r"
        assert d["values"] == {"c1": "v"}

    def test_row_defaults(self) -> None:
        r = SpreadsheetRow(
            id="r", dataset_id="d", input="i", expected_output="o",
        )
        assert r.values == {}
        assert r.created_at == ""
