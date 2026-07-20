"""W8 Agent 8.4 — Tinybird / columnar pipe-query failure soft-fails.

Covers:
* Tinybird bare table names (no ``database.`` prefix)
* Home KPI query omits missing ``cost_usd`` column
* TSV parser rejects misaligned rows + parses Tinybird JSON
* Tinybird DDL/DML is raised (not silent empty success)
* ColumnarQueryEngine PG outage → envelope (not uncaught 500)
* GDPR CH purge soft-skips Tinybird hosts; uses ``tenant_id``
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.data_platform.clickhouse_sink import (
    ClickHouseConfig,
    ClickHouseError,
    ClickHouseSink,
)


class TestQualifiedTable:
    def test_tinybird_bare_name(self) -> None:
        cfg = ClickHouseConfig(
            url="https://api.us-east.tinybird.co",
            database="eden",
            tinybird_token="t",
        )
        assert cfg.qualified_table("telemetry_events_ch") == "telemetry_events_ch"
        assert cfg.qualified_table("eden.agent_performance") == "agent_performance"

    def test_clickhouse_prefixed(self) -> None:
        cfg = ClickHouseConfig(url="http://localhost:8123", database="eden")
        assert cfg.qualified_table("agent_performance") == "eden.agent_performance"


class TestParseResult:
    def test_tsv_happy(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        rows = sink._parse_tsv("a\tb\n1\t2\n")
        assert rows == [{"a": "1", "b": "2"}]

    def test_tsv_skips_misaligned_row(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        rows = sink._parse_tsv("a\tb\n1\t2\nonly_one\n3\t4\n")
        assert rows == [{"a": "1", "b": "2"}, {"a": "3", "b": "4"}]

    def test_json_data_envelope(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        body = '{"meta":[],"data":[{"event_count":"10","error_count":"1"}]}'
        rows = sink._parse_tsv(body)
        assert rows == [{"event_count": "10", "error_count": "1"}]

    def test_json_error_raises(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        with pytest.raises(ClickHouseError, match="query error"):
            sink._parse_tsv('{"error":"Unknown expression identifier \'cost_usd\'"}')


@pytest.mark.asyncio
async def test_tinybird_execute_rejects_ddl() -> None:
    sink = ClickHouseSink(
        ClickHouseConfig(
            url="https://api.us-east.tinybird.co",
            tinybird_token="tok",
        )
    )
    with pytest.raises(ClickHouseError, match="rejects DDL"):
        await sink._execute("ALTER TABLE agent_performance DELETE WHERE 1")


@pytest.mark.asyncio
async def test_tinybird_execute_appends_tsv_format() -> None:
    sink = ClickHouseSink(
        ClickHouseConfig(
            url="https://api.us-east.tinybird.co",
            tinybird_token="tok",
        )
    )
    resp = MagicMock()
    resp.status = 200
    resp.text = AsyncMock(return_value="n\n1\n")
    resp.__aenter__ = AsyncMock(return_value=resp)
    resp.__aexit__ = AsyncMock(return_value=False)
    session = MagicMock()
    session.post = MagicMock(return_value=resp)

    with patch.object(sink, "_get_session", AsyncMock(return_value=session)):
        await sink._execute("SELECT 1 AS n")

    _, kwargs = session.post.call_args
    q = kwargs["params"]["q"]
    assert "FORMAT TabSeparatedWithNames" in q


@pytest.mark.asyncio
async def test_query_home_kpis_sql_has_no_cost_usd() -> None:
    sink = ClickHouseSink(
        ClickHouseConfig(
            url="https://api.us-east.tinybird.co",
            database="eden",
            tinybird_token="tok",
        )
    )
    captured: list[str] = []

    async def capture(query: str, params=None) -> str:  # noqa: ANN001
        captured.append(query)
        if len(captured) == 1:
            return (
                "event_count\terror_count\tavg_duration_ms\tp95_duration_ms\n"
                "10\t1\t12.5\t40.0\n"
            )
        return "event_count\n5\n"

    with patch.object(sink, "_execute", side_effect=capture):
        out = await sink.query_home_kpis("org-1", window_hours=24)

    assert out["event_count"] == 10
    assert out["prev_event_count"] == 5
    assert out["cost_usd"] == 0.0
    assert "FROM telemetry_events_ch" in captured[0]
    assert "eden.telemetry_events_ch" not in captured[0]
    assert "sum(cost_usd)" not in captured[0]
    assert "\\'" not in captured[0]  # SQL-standard escape, not backslash


@pytest.mark.asyncio
async def test_query_engine_pg_outage_returns_envelope() -> None:
    from eden.columnar import ColumnarQueryEngine
    from eden.columnar._common import _reset_ch_health_cache

    _reset_ch_health_cache()
    pg = MagicMock()
    pg.fetch = AsyncMock(side_effect=ConnectionRefusedError("pg down"))

    with (
        patch(
            "eden.columnar._common._check_ch_available",
            new=AsyncMock(return_value=False),
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=pg),
        ),
    ):
        result = await ColumnarQueryEngine().execute(
            "org_test",
            query=(
                "SELECT count(*) AS n FROM telemetry_events "
                "WHERE org_id = 'org_test'"
            ),
            engine="auto",
        )
    assert result["status"] == "not_implemented"
    assert "postgres query unavailable" in result["message"]


@pytest.mark.asyncio
async def test_aggregator_both_down_returns_envelope() -> None:
    from eden.columnar.aggregations import ColumnarAggregator

    end = datetime(2026, 6, 25, tzinfo=UTC)
    start = end - timedelta(days=1)
    pg = MagicMock()
    pg.fetch = AsyncMock(side_effect=ConnectionRefusedError("pg down"))
    pg.execute = AsyncMock(side_effect=ConnectionRefusedError("pg down"))

    with (
        patch(
            "eden.columnar._common._check_ch_available",
            new=AsyncMock(return_value=False),
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=pg),
        ),
    ):
        result = await ColumnarAggregator().precompute_rollups(
            "org_test",
            table="telemetry_events",
            granularity="day",
            window_start=start,
            window_end=end,
        )
    assert result["status"] == "not_implemented"
    assert "rollup unavailable" in result["message"]


@pytest.mark.asyncio
async def test_gdpr_ch_purge_skips_tinybird() -> None:
    from eden.data_platform.retention import DataRetentionManager

    mgr = DataRetentionManager(dry_run=False)
    with patch(
        "eden.data_platform.retention.settings"
    ) as fake_settings:
        fake_settings.clickhouse_url = "https://api.us-east.tinybird.co"
        n = await mgr._delete_from_clickhouse("tenant-1")
    assert n == 0


def test_gdpr_ch_purge_uses_tenant_id_column() -> None:
    import inspect

    from eden.data_platform.retention import DataRetentionManager

    src = inspect.getsource(DataRetentionManager._delete_from_clickhouse)
    assert "DELETE WHERE tenant_id =" in src
    assert "DELETE WHERE org_id =" not in src
