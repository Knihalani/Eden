"""Wave 6 — ClickHouseSink SQL literal escape for user filters."""

from __future__ import annotations

from eden.data_platform.clickhouse_sink import ClickHouseSink


def test_sql_literal_escapes_single_quotes() -> None:
    assert ClickHouseSink._sql_literal("O'Brien") == "O''Brien"
    assert ClickHouseSink._sql_literal("'; DROP TABLE x; --") == (
        "''; DROP TABLE x; --"
    )
    assert ClickHouseSink._sql_literal(None) == ""
