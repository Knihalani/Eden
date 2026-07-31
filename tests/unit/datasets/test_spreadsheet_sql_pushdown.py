"""Filter and sort must be applied before LIMIT, not after it.

``SpreadsheetService.list_rows`` used to run

    SELECT ... FROM dataset_items
    WHERE dataset_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3

and *then* call ``apply_filter`` / ``apply_sort`` on the returned page. So:

* **A filter only ever saw the newest ``limit`` rows.** Filtering a
  50,000-row dataset returned whatever matched inside the newest 200 and
  presented that as the complete answer.
* **A sort only ordered that same window.** "Lowest score first" showed the
  lowest score among the newest 200, not in the dataset.
* **Paging a filtered view was incoherent**, because ``OFFSET`` skipped
  *unfiltered* rows before the filter ran.
* **``total_count`` was ``len(rows)``**, so it could never exceed ``limit``.

Nothing raised. The endpoint returned a short, plausible, wrong list.

The tests below cover the SQL builders directly (no database needed) and the
service's use of them against a recording fake. A real-Postgres parity test
against the reference Python implementation lives at the bottom behind the
``realdb`` marker -- until that runs, agreement between the SQL and Python
semantics is argued, not proven, and the builder tests below are what actually
holds the line.
"""

from __future__ import annotations

import re
from typing import Any

import pytest

from eden.datasets.spreadsheet import (
    SpreadsheetService,
    apply_filter,
    apply_sort,
    build_filter_sql,
    build_sort_sql,
)


class _RecordingPg:
    """Captures the SQL and params instead of executing them."""

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows if rows is not None else []
        self.sql: str = ""
        self.params: tuple[Any, ...] = ()
        # ``list_rows_page`` can issue a second (fallback COUNT) query, which
        # would otherwise overwrite ``sql`` and make an assertion about the
        # paged query silently inspect the wrong statement.
        self.queries: list[str] = []

    async def fetch(self, sql: str, *params: Any) -> list[dict[str, Any]]:
        self.sql = sql
        self.params = params
        self.queries.append(sql)
        return self.rows

    async def execute(self, sql: str, *params: Any) -> str:
        self.sql = sql
        self.params = params
        return "OK"


def _norm(sql: str) -> str:
    return " ".join(sql.split())


# ── The core regression ──────────────────────────────────────────────


class TestPredicatesReachTheDatabase:
    @pytest.mark.asyncio
    async def test_filter_is_in_the_where_clause(self) -> None:
        pg = _RecordingPg()
        svc = SpreadsheetService(pg)
        await svc.list_rows(
            "ds-1", filter_spec=[{"column": "score", "op": "==", "value": "9"}]
        )
        sql = _norm(pg.sql)
        where = sql.split("WHERE", 1)[1].split("ORDER BY", 1)[0]
        assert "payload->>" in where, (
            f"the filter did not reach the WHERE clause: {where!r}"
        )

    @pytest.mark.asyncio
    async def test_sort_is_in_the_order_by_clause(self) -> None:
        pg = _RecordingPg()
        svc = SpreadsheetService(pg)
        await svc.list_rows(
            "ds-1", sort_spec=[{"column": "score", "direction": "desc"}]
        )
        sql = _norm(pg.sql)
        order = sql.split("ORDER BY", 1)[1].split("LIMIT", 1)[0]
        assert "payload->>" in order, (
            f"the sort did not reach the ORDER BY clause: {order!r}"
        )

    @pytest.mark.asyncio
    async def test_where_precedes_limit(self) -> None:
        """The whole bug in one assertion."""
        pg = _RecordingPg()
        svc = SpreadsheetService(pg)
        await svc.list_rows(
            "ds-1",
            filter_spec=[{"column": "score", "op": ">", "value": "5"}],
            sort_spec=[{"column": "score", "direction": "asc"}],
            limit=10,
        )
        sql = _norm(pg.sql)
        assert sql.index("WHERE") < sql.index("LIMIT")
        assert sql.index("ORDER BY") < sql.index("LIMIT")

    @pytest.mark.asyncio
    async def test_params_are_bound_positionally_and_completely(self) -> None:
        """asyncpg errors when the arg count and placeholder count disagree."""
        pg = _RecordingPg()
        svc = SpreadsheetService(pg)
        await svc.list_rows(
            "ds-1",
            filter_spec=[
                {"column": "score", "op": ">", "value": "5"},
                {"column": "label", "op": "==", "value": "ok"},
            ],
            sort_spec=[{"column": "score", "direction": "desc"}],
            limit=7,
            offset=14,
        )
        placeholders = {int(m) for m in re.findall(r"\$(\d+)", pg.sql)}
        assert placeholders == set(range(1, len(pg.params) + 1)), (
            f"placeholders {sorted(placeholders)} do not cover "
            f"{len(pg.params)} params"
        )
        assert pg.params[0] == "ds-1"
        assert pg.params[-2:] == (7, 14), "limit/offset must bind last"

    @pytest.mark.asyncio
    async def test_column_names_are_bound_never_interpolated(self) -> None:
        """A column name arrives from a query string; it is user input."""
        pg = _RecordingPg()
        svc = SpreadsheetService(pg)
        evil = "x'); DROP TABLE dataset_items; --"
        await svc.list_rows(
            "ds-1", filter_spec=[{"column": evil, "op": "==", "value": "1"}]
        )
        assert "DROP TABLE" not in pg.sql
        assert evil in pg.params

    @pytest.mark.asyncio
    async def test_filter_values_are_bound_never_interpolated(self) -> None:
        pg = _RecordingPg()
        svc = SpreadsheetService(pg)
        evil = "'; DELETE FROM dataset_items WHERE 't'='t"
        await svc.list_rows(
            "ds-1", filter_spec=[{"column": "label", "op": "==", "value": evil}]
        )
        assert "DELETE FROM" not in pg.sql
        assert evil in pg.params


class TestTotalCount:
    @pytest.mark.asyncio
    async def test_total_comes_from_the_window_count(self) -> None:
        pg = _RecordingPg(
            rows=[
                {
                    "id": "r-1",
                    "dataset_id": "ds-1",
                    "input": "a",
                    "expected_output": "b",
                    "payload": {},
                    "created_at": "t",
                    "updated_at": "t",
                    "total_matching": 4321,
                }
            ]
        )
        svc = SpreadsheetService(pg)
        rows, total = await svc.list_rows_page("ds-1", limit=1)
        assert len(rows) == 1
        assert total == 4321, "total must be the match count, not the page size"
        assert "COUNT(*) OVER ()" in _norm(pg.sql)

    @pytest.mark.asyncio
    async def test_empty_page_reports_zero(self) -> None:
        svc = SpreadsheetService(_RecordingPg(rows=[]))
        rows, total = await svc.list_rows_page("ds-1")
        assert rows == [] and total == 0

    @pytest.mark.asyncio
    async def test_list_rows_still_returns_a_plain_list(self) -> None:
        """Five existing call sites depend on the original signature."""
        svc = SpreadsheetService(_RecordingPg(rows=[]))
        got = await svc.list_rows("ds-1")
        assert isinstance(got, list)


# ── Builder semantics ────────────────────────────────────────────────


class TestFilterSqlSemantics:
    @pytest.mark.parametrize(
        ("op", "fragment"),
        [
            ("==", "="),
            ("!=", "<>"),
            ("contains", "POSITION("),
            ("starts_with", "STARTS_WITH("),
        ],
    )
    def test_operator_mapping(self, op: str, fragment: str) -> None:
        params: list[Any] = []
        sql = build_filter_sql([{"column": "c", "op": op, "value": "v"}], params)
        assert fragment in sql

    def test_contains_is_a_literal_substring_not_a_like_pattern(self) -> None:
        """``LIKE`` would treat % and _ in the value as wildcards."""
        params: list[Any] = []
        sql = build_filter_sql(
            [{"column": "c", "op": "contains", "value": "100%_x"}], params
        )
        assert "LIKE" not in sql.upper()
        assert "POSITION(" in sql
        assert "100%_x" in params

    def test_missing_key_reads_as_empty_string(self) -> None:
        """Matches the Python path, which defaulted a missing column to ``""``."""
        params: list[Any] = []
        sql = build_filter_sql([{"column": "c", "op": "==", "value": ""}], params)
        assert "COALESCE(payload->>" in sql

    def test_direct_columns_are_not_read_from_payload(self) -> None:
        for col in ("input", "expected_output"):
            params: list[Any] = []
            sql = build_filter_sql(
                [{"column": col, "op": "==", "value": "x"}], params
            )
            assert "payload" not in sql
            assert col in sql

    def test_empty_spec_is_true_not_a_syntax_error(self) -> None:
        assert build_filter_sql([], []) == "TRUE"

    def test_unknown_operator_excludes_everything(self) -> None:
        """``_match`` fell through to ``return False`` for an unknown op."""
        params: list[Any] = []
        sql = build_filter_sql(
            [{"column": "c", "op": "=~", "value": "x"}], params
        )
        assert sql == "(FALSE)"
        assert params == []

    def test_multiple_predicates_are_conjunctive(self) -> None:
        params: list[Any] = []
        sql = build_filter_sql(
            [
                {"column": "a", "op": "==", "value": "1"},
                {"column": "b", "op": "==", "value": "2"},
            ],
            params,
        )
        assert " AND " in sql
        assert sql.count("COALESCE(payload->>") == 2


class TestNumericComparisons:
    @pytest.mark.parametrize("op", [">", ">=", "<", "<="])
    def test_ordered_ops_guard_the_cast_with_case(self, op: str) -> None:
        """An unguarded ``::numeric`` aborts the query on the first bad cell.

        ``AND`` does not guarantee evaluation order in Postgres; ``CASE`` does.
        """
        params: list[Any] = []
        sql = build_filter_sql([{"column": "c", "op": op, "value": "5"}], params)
        assert sql.startswith("(CASE WHEN ")
        assert "::numeric" in sql
        assert f"::numeric {op} " in sql

    @pytest.mark.parametrize("target", ["abc", "", "1,5", "twelve"])
    def test_non_numeric_target_matches_nothing(self, target: str) -> None:
        """``_match`` returned False when the target would not parse."""
        params: list[Any] = []
        sql = build_filter_sql(
            [{"column": "c", "op": ">", "value": target}], params
        )
        assert sql == "(FALSE)"

    @pytest.mark.parametrize("target", ["5", "-5", "+5", "5.5", ".5", "1e3", " 7 "])
    def test_numeric_targets_are_accepted(self, target: str) -> None:
        params: list[Any] = []
        sql = build_filter_sql(
            [{"column": "c", "op": ">", "value": target}], params
        )
        assert sql != "(FALSE)", f"{target!r} should be treated as numeric"
        assert target in params

    @pytest.mark.parametrize("target", ["inf", "-inf", "nan", "1_000", "Infinity"])
    def test_documented_narrowing_vs_python_float(self, target: str) -> None:
        """Python's ``float()`` accepts these; Postgres ``numeric`` does not.

        This is a deliberate, documented divergence from ``_match`` rather than
        an oversight -- pinned here so a future change to the regex has to
        decide about it consciously.
        """
        assert isinstance(float(target), float), "premise: Python parses it"
        params: list[Any] = []
        sql = build_filter_sql(
            [{"column": "c", "op": ">", "value": target}], params
        )
        assert sql == "(FALSE)"


class TestSortSqlSemantics:
    def test_numeric_columns_sort_numerically_not_lexically(self) -> None:
        """A plain text sort puts "10" before "9"; the Python path did not."""
        params: list[Any] = []
        sql = build_sort_sql([{"column": "score", "direction": "asc"}], params)
        assert "::numeric" in sql

    def test_direction_is_honoured(self) -> None:
        """The two *value* terms carry the direction; the rank term never does.

        An earlier version of this test asserted no ``ASC`` appeared anywhere in
        a descending sort. That encoded a bug: the numeric/non-numeric rank must
        stay ascending in both directions, or a descending sort hoists the rows
        whose cell is not a number. See TestDescendingSortPutsNumbersFirst.
        """
        tiebreak = ", created_at DESC, id ASC"
        asc = build_sort_sql([{"column": "c", "direction": "asc"}], [])
        desc = build_sort_sql([{"column": "c", "direction": "desc"}], [])
        assert asc.endswith(tiebreak) and desc.endswith(tiebreak)

        asc_terms = asc[: -len(tiebreak)]
        desc_terms = desc[: -len(tiebreak)]
        # Rank term: ascending in both.
        assert asc_terms.count("THEN 0 ELSE 1 END) ASC") == 1
        assert desc_terms.count("THEN 0 ELSE 1 END) ASC") == 1
        # Value terms: two of them, both carrying the requested direction.
        assert asc_terms.count(" ASC") == 3, asc_terms
        assert desc_terms.count(" DESC") == 2, desc_terms

    def test_unknown_direction_defaults_to_asc(self) -> None:
        sql = build_sort_sql([{"column": "c", "direction": "sideways"}], [])
        # Only the created_at tiebreak may be DESC.
        assert sql.replace("created_at DESC", "").count("DESC") == 0

    def test_a_total_order_tiebreak_is_always_appended(self) -> None:
        """Without it, OFFSET paging duplicates one tied row and skips another."""
        sql = build_sort_sql([{"column": "c", "direction": "asc"}], [])
        assert sql.rstrip().endswith("created_at DESC, id ASC")

    def test_multi_key_sort_preserves_left_to_right_precedence(self) -> None:
        params: list[Any] = []
        sql = build_sort_sql(
            [
                {"column": "a", "direction": "asc"},
                {"column": "b", "direction": "desc"},
            ],
            params,
        )
        assert params[0] == "a" and params[1] == "b"
        assert sql.index("$1") < sql.index("$2")


# ── Parity with the reference implementation ─────────────────────────


class TestReferenceImplementationIsStillExported:
    """``apply_filter`` / ``apply_sort`` remain public API and the spec.

    They are no longer on the read path, but they document the intended
    semantics and the realdb test below compares against them.
    """

    def test_helpers_are_importable_and_behave(self) -> None:
        from eden.datasets.spreadsheet import SpreadsheetRow

        rows = [
            SpreadsheetRow(id="1", dataset_id="d", input="apple", expected_output=""),
            SpreadsheetRow(id="2", dataset_id="d", input="banana", expected_output=""),
        ]
        got = apply_filter(rows, [{"column": "input", "op": "==", "value": "apple"}])
        assert [r.id for r in got] == ["1"]
        assert [r.id for r in apply_sort(rows, [
            {"column": "input", "direction": "desc"}
        ])] == ["2", "1"]


@pytest.mark.realdb
class TestSqlMatchesPythonOnARealDatabase:
    """Proves the pushdown agrees with the reference implementation.

    Skipped without ``--realdb``; the builder tests above are the everyday
    guard. This is the test that would turn "the semantics should match" into
    "the semantics do match", and it is deliberately left as the only place
    that claim is made.
    """

    def test_placeholder_until_a_realdb_fixture_exists(self) -> None:
        pytest.skip(
            "needs a Postgres fixture with a seeded dataset_items table; "
            "the SQL/Python parity claim is unproven until this runs"
        )


# ── Defects found in review of this change, 2026-07-30 ───────────────


class TestNoPlaceholderGaps:
    """A bound parameter no SQL references makes the statement unusable.

    Postgres derives a statement's parameter count from the highest ``$n``
    referenced, then rejects any lower index it could not type:
    ``could not determine data type of parameter $n``. ``build_filter_sql``
    called ``_column_expr`` (which binds the JSONB key) *before* deciding that
    an ordered comparison against a non-numeric target matches nothing, then
    emitted ``FALSE`` and referenced nothing. The most common way to reach it is
    an operator picked with the value box left blank, and the result was a 500
    where the code intended an empty result set.
    """

    @staticmethod
    def _placeholders(sql: str) -> set[int]:
        return {int(m) for m in re.findall(r"\$(\d+)", sql)}

    @pytest.mark.parametrize("value", ["", "abc", "1,5", "twelve", "inf"])
    @pytest.mark.parametrize("op", [">", ">=", "<", "<="])
    def test_non_numeric_target_binds_nothing(self, op: str, value: str) -> None:
        params: list[Any] = []
        sql = build_filter_sql(
            [{"column": "score", "op": op, "value": value}], params
        )
        assert sql == "(FALSE)"
        assert params == [], f"bound {params} without referencing it"

    def test_mixed_predicates_keep_a_gap_free_sequence(self) -> None:
        params: list[Any] = []
        sql = build_filter_sql(
            [
                {"column": "score", "op": ">", "value": "abc"},
                {"column": "label", "op": "==", "value": "ok"},
            ],
            params,
        )
        assert self._placeholders(sql) == set(range(1, len(params) + 1))

    @pytest.mark.asyncio
    async def test_service_query_has_no_gaps_for_a_blank_numeric_filter(
        self,
    ) -> None:
        """End-to-end through the service, not just the builder."""
        pg = _RecordingPg()
        svc = SpreadsheetService(pg)
        await svc.list_rows(
            "ds-1", filter_spec=[{"column": "score", "op": ">", "value": ""}]
        )
        assert self._placeholders(pg.sql) == set(range(1, len(pg.params) + 1))


class TestDescendingSortPutsNumbersFirst:
    """The rank term must not carry the direction.

    ``CASE WHEN numeric THEN 0 ELSE 1 END DESC`` sorted rank 1 (non-numeric)
    first, so "highest score first" filled page one with rows whose score cell
    was blank — the opposite of this module's documented invariant.
    """

    def test_rank_term_is_ascending_regardless_of_direction(self) -> None:
        # Cannot split on "," -- COALESCE(payload->>$1, '') contains one.
        for direction in ("asc", "desc"):
            sql = build_sort_sql([{"column": "score", "direction": direction}], [])
            assert "THEN 0 ELSE 1 END) ASC" in sql, (
                f"{direction} sort ranks non-numerics first: {sql[:120]!r}"
            )
            assert "THEN 0 ELSE 1 END) DESC" not in sql

    def test_numeric_term_puts_nulls_last_under_desc(self) -> None:
        """DESC defaults to NULLS FIRST, which hoists the guard's rejects."""
        sql = build_sort_sql([{"column": "score", "direction": "desc"}], [])
        assert "DESC NULLS LAST" in sql

    def test_direction_still_reaches_the_value_terms(self) -> None:
        asc = build_sort_sql([{"column": "score", "direction": "asc"}], [])
        desc = build_sort_sql([{"column": "score", "direction": "desc"}], [])
        assert "ELSE NULL END) ASC NULLS LAST" in asc
        assert "ELSE NULL END) DESC NULLS LAST" in desc
        # And the text fallback term.
        assert asc.rstrip().endswith("created_at DESC, id ASC")
        assert "'') ASC," in asc and "'') DESC," in desc


class TestTotalOnAnEmptyPage:
    """``COUNT(*) OVER ()`` arrives on rows, so an empty page has no count.

    Returning 0 there reports "nothing matches" for any offset past the end of
    the result set -- the same confidently-wrong count this change was written
    to remove, relocated to the last page.
    """

    class _TwoQueryPg:
        """Empty page from the paged query, a real count from the fallback."""

        def __init__(self, total: int) -> None:
            self.total = total
            self.calls: list[tuple[str, tuple[Any, ...]]] = []

        async def fetch(self, sql: str, *params: Any) -> list[dict[str, Any]]:
            self.calls.append((" ".join(sql.split()), params))
            if "COUNT(*) AS total_matching" in sql:
                return [{"total_matching": self.total}]
            return []

    @pytest.mark.asyncio
    async def test_offset_past_the_end_still_reports_the_real_total(self) -> None:
        pg = self._TwoQueryPg(total=4321)
        svc = SpreadsheetService(pg)
        rows, total = await svc.list_rows_page("ds-1", limit=200, offset=100_000)
        assert rows == []
        assert total == 4321, "an empty page reported the filter as matching nothing"
        assert len(pg.calls) == 2, "the fallback count did not run"

    @pytest.mark.asyncio
    async def test_fallback_count_is_given_only_the_predicate_params(self) -> None:
        """asyncpg rejects more args than placeholders.

        The sort binds parameters after the filter, so passing everything up to
        LIMIT would hand the COUNT query the sort's JSONB keys, which its WHERE
        clause never references.
        """
        pg = self._TwoQueryPg(total=7)
        svc = SpreadsheetService(pg)
        await svc.list_rows_page(
            "ds-1",
            filter_spec=[{"column": "label", "op": "==", "value": "ok"}],
            sort_spec=[{"column": "score", "direction": "desc"}],
            limit=10,
            offset=999,
        )
        count_sql, count_params = pg.calls[-1]
        assert "COUNT(*) AS total_matching" in count_sql
        placeholders = {int(m) for m in re.findall(r"\$(\d+)", count_sql)}
        assert placeholders == set(range(1, len(count_params) + 1)), (
            f"COUNT got {len(count_params)} args for placeholders "
            f"{sorted(placeholders)}"
        )
        assert "score" not in count_params, "sort param leaked into the COUNT"


class TestTotalIsOptional:
    """The window count defeats the LIMIT short-circuit, so it must be opt-in."""

    @pytest.mark.asyncio
    async def test_list_rows_does_not_ask_for_a_count(self) -> None:
        pg = _RecordingPg()
        svc = SpreadsheetService(pg)
        await svc.list_rows("ds-1", limit=200)
        assert "COUNT(*) OVER ()" not in pg.sql, (
            "list_rows paid for a full count it never returns"
        )

    @pytest.mark.asyncio
    async def test_list_rows_page_asks_for_a_count_by_default(self) -> None:
        pg = _RecordingPg()
        svc = SpreadsheetService(pg)
        await svc.list_rows_page("ds-1")
        # queries[0] is the paged statement; a fallback COUNT may follow.
        assert "COUNT(*) OVER ()" in pg.queries[0]

    @pytest.mark.asyncio
    async def test_with_total_false_returns_the_page_length(self) -> None:
        pg = _RecordingPg(rows=[])
        svc = SpreadsheetService(pg)
        rows, total = await svc.list_rows_page("ds-1", with_total=False)
        assert (rows, total) == ([], 0)
