"""Unit tests for Phase M — read-only SQL executor.

Pure-function tests for the executor's guards + rewriter.
The actual Postgres round-trip is mocked; the executor
exposes a clean separation between the parser/rewriter layer
(this file) and the execution layer (e2e tests).

What's covered:

  * Statement guard — rejects INSERT / UPDATE / DELETE / DDL /
    EXPLAIN / multi-statement.
  * Table allowlist — rejects ``users``, ``secrets`` and any
    other non-allowlisted table.
  * Tenant injection — appends ``WHERE org_id = ...`` to
    queries that lack one; ANDs into existing WHERE.
  * Row cap — wraps query in a CTE; the underlying fetch is
    called with the right LIMIT.
  * Param binding — ``:name`` placeholders become positional
    $N; the actual values are bound to the args list.
  * Result formatting — column order preserved; truncated
    flag set when the cap is hit.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional
from unittest.mock import AsyncMock

import pytest

from eden.observability.sql_executor import (
    ALLOWED_TABLES,
    DEFAULT_MAX_ROWS,
    MAX_MAX_ROWS,
    SqlExecutor,
    SqlExecutorError,
    SqlForbiddenStatementError,
    SqlMultiStatementError,
    SqlResult,
    SqlTenantViolationError,
    SqlTimeoutError,
    SqlUnknownTableError,
    _is_timeout,
    get_schema_summary,
)


# ── Fake Postgres client ───────────────────────────────────────────


class FakePg:
    """In-memory Postgres for unit tests.

    Stores a single table (``telemetry_events``) and supports
    the methods the executor calls: ``transaction()`` (async
    context manager) and ``fetch()``.

    The fake also captures every SQL + args tuple passed to it
    so tests can assert against the rewritten query.
    """

    def __init__(self, table_rows: Optional[list[dict]] = None) -> None:
        self.table_rows = table_rows or []
        self.calls: list[tuple[str, tuple]] = []
        # Pre-populate one allowlisted table so the schema
        # summary + a basic query both work.
        self._table_columns: dict[str, list[tuple[str, str]]] = {
            "telemetry_events": [
                ("id", "uuid"),
                ("org_id", "uuid"),
                ("event_type", "text"),
                ("created_at", "timestamptz"),
            ],
            "judge_scores": [
                ("id", "uuid"),
                ("org_id", "uuid"),
                ("score", "numeric"),
            ],
        }

    def transaction(self) -> "_Transaction":
        return _Transaction(self)

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append((query, args))
        # The schema-summary query lists information_schema.
        if "information_schema.columns" in query:
            table = args[0] if args else None
            cols = self._table_columns.get(table, [])
            return [{"column_name": c[0], "data_type": c[1]} for c in cols]
        # The user's query — return the pre-loaded rows.
        return list(self.table_rows)

    async def execute(self, query: str, *args: Any) -> str:
        self.calls.append((query, args))
        return "OK"


class _Transaction:
    def __init__(self, pg: FakePg) -> None:
        self.pg = pg

    async def __aenter__(self) -> "FakePg":
        return self.pg

    async def __aexit__(self, *args: Any) -> None:
        pass

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        return await self.pg.fetch(query, *args)


# ── Statement guard ────────────────────────────────────────────────


class TestStatementGuard:
    def _executor(self) -> SqlExecutor:
        return SqlExecutor(FakePg())

    def test_select_passes(self) -> None:
        ex = self._executor()
        # The actual fetch will run; we mock by setting an
        # empty rows list. The point is the guard doesn't fire.
        asyncio.run(ex.execute("SELECT 1 FROM telemetry_events",
                                org_id="o-1"))
        # No exception.

    def test_with_select_passes(self) -> None:
        ex = self._executor()
        asyncio.run(ex.execute(
            "WITH x AS (SELECT 1) SELECT * FROM telemetry_events",
            org_id="o-1",
        ))

    @pytest.mark.parametrize("stmt", [
        "INSERT INTO telemetry_events (id) VALUES ('1')",
        "UPDATE telemetry_events SET id = '1'",
        "DELETE FROM telemetry_events",
        "DROP TABLE telemetry_events",
        "ALTER TABLE telemetry_events ADD COLUMN foo TEXT",
        "CREATE TABLE foo (id INT)",
        "TRUNCATE telemetry_events",
        "MERGE INTO telemetry_events",
        "GRANT ALL ON telemetry_events TO public",
        "REVOKE ALL ON telemetry_events FROM public",
        "COPY telemetry_events TO '/tmp/foo'",
        "VACUUM telemetry_events",
        "REINDEX TABLE telemetry_events",
        "CLUSTER telemetry_events",
        "EXPLAIN SELECT 1 FROM telemetry_events",
        "EXPLAIN ANALYZE SELECT 1 FROM telemetry_events",
        "SHOW search_path",
        "SET search_path TO public",
        "RESET search_path",
    ])
    def test_write_statements_rejected(self, stmt: str) -> None:
        ex = self._executor()
        with pytest.raises(SqlForbiddenStatementError):
            asyncio.run(ex.execute(stmt, org_id="o-1"))

    def test_empty_query_rejected(self) -> None:
        ex = self._executor()
        with pytest.raises(SqlForbiddenStatementError):
            asyncio.run(ex.execute("   ", org_id="o-1"))

    def test_comment_only_rejected(self) -> None:
        ex = self._executor()
        with pytest.raises(SqlForbiddenStatementError):
            asyncio.run(ex.execute("-- just a comment", org_id="o-1"))

    def test_multi_statement_rejected(self) -> None:
        ex = self._executor()
        with pytest.raises(SqlMultiStatementError):
            asyncio.run(ex.execute(
                "SELECT 1 FROM telemetry_events; SELECT 1 FROM telemetry_events",
                org_id="o-1",
            ))

    def test_trailing_semicolon_ok(self) -> None:
        ex = self._executor()
        asyncio.run(ex.execute(
            "SELECT 1 FROM telemetry_events;",
            org_id="o-1",
        ))

    def test_comment_with_semicolon_ok(self) -> None:
        ex = self._executor()
        # ``-- foo; bar`` is a single line comment; the
        # semicolon inside is not a statement terminator.
        asyncio.run(ex.execute(
            "-- foo; bar\nSELECT 1 FROM telemetry_events",
            org_id="o-1",
        ))


# ── Table allowlist ────────────────────────────────────────────────


class TestTableAllowlist:
    def _executor(self) -> SqlExecutor:
        return SqlExecutor(FakePg())

    def test_known_table_passes(self) -> None:
        ex = self._executor()
        asyncio.run(ex.execute(
            "SELECT 1 FROM telemetry_events", org_id="o-1",
        ))

    def test_join_known_tables_passes(self) -> None:
        ex = self._executor()
        asyncio.run(ex.execute(
            """
            SELECT t.id, j.score
            FROM telemetry_events t
            JOIN judge_scores j ON j.org_id = t.org_id
            """,
            org_id="o-1",
        ))

    @pytest.mark.parametrize("table", [
        "users",
        "secrets",
        "api_keys",
        "pg_user",
        "pg_shadow",
        "pg_authid",
        "information_schema.tables",
    ])
    def test_unknown_table_rejected(self, table: str) -> None:
        ex = self._executor()
        with pytest.raises(SqlUnknownTableError):
            asyncio.run(ex.execute(
                f"SELECT 1 FROM {table}", org_id="o-1",
            ))

    def test_schema_qualified_rejected_for_other_schema(self) -> None:
        ex = self._executor()
        with pytest.raises(SqlUnknownTableError):
            asyncio.run(ex.execute(
                "SELECT 1 FROM private.telemetry_events",
                org_id="o-1",
            ))

    def test_allowlist_is_comprehensive(self) -> None:
        # Sanity check: the allowlist should contain the
        # core tables we use everywhere.
        assert "telemetry_events" in ALLOWED_TABLES
        assert "judge_scores" in ALLOWED_TABLES
        assert "usage_events" in ALLOWED_TABLES
        assert "incidents" in ALLOWED_TABLES
        # And the sensitive ones should NOT be in it.
        assert "users" not in ALLOWED_TABLES
        assert "secrets" not in ALLOWED_TABLES
        assert "api_keys" not in ALLOWED_TABLES


# ── Tenant injection ───────────────────────────────────────────────


class TestTenantInjection:
    def _executor(self) -> SqlExecutor:
        return SqlExecutor(FakePg())

    def test_appends_where_when_missing(self) -> None:
        ex = self._executor()
        pg = ex._pg  # the FakePg
        asyncio.run(ex.execute(
            "SELECT id FROM telemetry_events", org_id="o-1",
        ))
        # The SQL the executor actually ran.
        sql = pg.calls[-1][0]
        assert "WHERE org_id = 'o-1'" in sql
        # And the CTE wrapper.
        assert "WITH _user_query AS" in sql

    def test_ands_into_existing_where(self) -> None:
        ex = self._executor()
        pg = ex._pg
        asyncio.run(ex.execute(
            "SELECT id FROM telemetry_events WHERE event_type = 'foo'",
            org_id="o-1",
        ))
        sql = pg.calls[-1][0]
        assert "WHERE event_type = 'foo'" in sql
        assert "AND org_id = 'o-1'" in sql

    def test_escapes_single_quote_in_org_id(self) -> None:
        ex = self._executor()
        pg = ex._pg
        # Craft an org_id with a single quote.
        asyncio.run(ex.execute(
            "SELECT id FROM telemetry_events", org_id="o'; DROP TABLE x; --",
        ))
        sql = pg.calls[-1][0]
        # The quote is doubled (SQL escape).
        assert "'o''; DROP TABLE x; --'" in sql

    def test_query_with_only_non_tenant_table_rejected(self) -> None:
        # A query that references only non-tenant tables.
        # (The test exercises the "no allowlisted table"
        # branch — without a tenant-scoped reference, we can't
        # safely scope the query, so the executor refuses.)
        ex = self._executor()
        with pytest.raises(SqlUnknownTableError):
            asyncio.run(ex.execute(
                "SELECT 1 FROM some_random_table", org_id="o-1",
            ))

    def test_query_without_from_is_allowed(self) -> None:
        # ``SELECT 1`` has no FROM, so there's nothing to scope
        # — the executor allows it (it's harmless constants).
        # We pre-load one row into the fake so the fetch returns
        # it (the fake doesn't evaluate the query).
        ex = SqlExecutor(FakePg(table_rows=[{"one": 1}]))
        result = asyncio.run(ex.execute(
            "SELECT 1 AS one", org_id="o-1",
        ))
        assert result.row_count == 1
        assert result.rows == [[1]]


# ── Param binding ──────────────────────────────────────────────────


class TestParamBinding:
    def _executor(self) -> SqlExecutor:
        return SqlExecutor(FakePg())

    def test_named_params_bound_positional(self) -> None:
        ex = self._executor()
        pg = ex._pg
        asyncio.run(ex.execute(
            "SELECT id FROM telemetry_events WHERE event_type = :etype",
            org_id="o-1",
            params={"etype": "llm.completion"},
        ))
        sql = pg.calls[-1][0]
        args = pg.calls[-1][1]
        assert "$1" in sql
        assert ":etype" not in sql
        assert args == ("llm.completion",)

    def test_unbound_param_left_intact(self) -> None:
        ex = self._executor()
        pg = ex._pg
        asyncio.run(ex.execute(
            "SELECT id FROM telemetry_events WHERE event_type = :missing",
            org_id="o-1",
        ))
        # The :missing placeholder is left in the SQL — the
        # user will get a Postgres error about an unbound
        # parameter. That's the correct failure mode.
        sql = pg.calls[-1][0]
        assert ":missing" in sql

    def test_multiple_params(self) -> None:
        ex = self._executor()
        pg = ex._pg
        asyncio.run(ex.execute(
            "SELECT id FROM telemetry_events WHERE event_type = :t AND agent_id = :a",
            org_id="o-1",
            params={"t": "llm.completion", "a": "agent-1"},
        ))
        sql = pg.calls[-1][0]
        args = pg.calls[-1][1]
        assert "$1" in sql and "$2" in sql
        assert args == ("llm.completion", "agent-1")


# ── Row cap + result formatting ────────────────────────────────────


class TestRowCap:
    def test_truncation_flag_set(self) -> None:
        # Build a fake with more rows than the cap.
        rows = [{"id": str(i), "name": f"row-{i}"} for i in range(10)]
        ex = SqlExecutor(FakePg(table_rows=rows), max_rows=5)
        result = asyncio.run(ex.execute(
            "SELECT id, name FROM telemetry_events",
            org_id="o-1",
        ))
        assert result.row_count == 5
        assert result.truncated is True
        assert result.cap_hit == "row_limit"

    def test_no_truncation_under_cap(self) -> None:
        rows = [{"id": str(i)} for i in range(3)]
        ex = SqlExecutor(FakePg(table_rows=rows), max_rows=5)
        result = asyncio.run(ex.execute(
            "SELECT id FROM telemetry_events",
            org_id="o-1",
        ))
        assert result.row_count == 3
        assert result.truncated is False
        assert result.cap_hit is None

    def test_max_rows_clamped_to_hard_cap(self) -> None:
        ex = SqlExecutor(FakePg(), max_rows=999_999)
        assert ex.max_rows == MAX_MAX_ROWS

    def test_default_max_rows_used(self) -> None:
        ex = SqlExecutor(FakePg())
        assert ex.max_rows == DEFAULT_MAX_ROWS

    def test_result_columns_preserved(self) -> None:
        rows = [{"id": "1", "name": "x", "score": 0.5}]
        ex = SqlExecutor(FakePg(table_rows=rows))
        result = asyncio.run(ex.execute(
            "SELECT id, name, score FROM telemetry_events",
            org_id="o-1",
        ))
        assert result.columns == ["id", "name", "score"]
        assert result.rows == [["1", "x", 0.5]]


# ── Timeout ────────────────────────────────────────────────────────


class TestTimeoutDetection:
    def test_is_timeout_detects_query_canceled(self) -> None:
        class _Exc(Exception):
            sqlstate = "57014"
        assert _is_timeout(_Exc()) is True

    def test_is_timeout_detects_by_name(self) -> None:
        class QueryCanceledError(Exception):
            pass
        assert _is_timeout(QueryCanceledError()) is True

    def test_is_timeout_rejects_other_errors(self) -> None:
        assert _is_timeout(ValueError("nope")) is False
        assert _is_timeout(RuntimeError("nothing about timing here")) is False


class FakePgTimeout(FakePg):
    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        if "SET LOCAL" in query:
            return []
        # Raise a QueryCanceledError-shaped exception.
        class _QueryCanceledError(Exception):
            sqlstate = "57014"
        raise _QueryCanceledError("canceling statement due to statement timeout")


class TestTimeoutExecution:
    def test_timeout_raises_typed_error(self) -> None:
        ex = SqlExecutor(FakePgTimeout(), max_seconds=5)
        with pytest.raises(SqlTimeoutError):
            asyncio.run(ex.execute(
                "SELECT id FROM telemetry_events", org_id="o-1",
            ))


# ── Schema summary ─────────────────────────────────────────────────


class TestSchemaSummary:
    def test_returns_known_tables(self) -> None:
        pg = FakePg()
        tables = asyncio.run(get_schema_summary(pg))
        # All allowlisted tables are present.
        names = {t["table"] for t in tables}
        assert "telemetry_events" in names
        assert "judge_scores" in names
        # And the sensitive ones aren't.
        assert "users" not in names
        assert "secrets" not in names

    def test_columns_populated_for_known_tables(self) -> None:
        pg = FakePg()
        tables = asyncio.run(get_schema_summary(pg))
        te = next(t for t in tables if t["table"] == "telemetry_events")
        col_names = {c["name"] for c in te["columns"]}
        assert "id" in col_names
        assert "org_id" in col_names
        assert "event_type" in col_names


# ── Result dataclass ───────────────────────────────────────────────


class TestSqlResult:
    def test_defaults(self) -> None:
        r = SqlResult()
        assert r.columns == []
        assert r.rows == []
        assert r.row_count == 0
        assert r.truncated is False
        assert r.execution_ms == 0.0
        assert r.rewritten_sql == ""
        assert r.cap_hit is None
