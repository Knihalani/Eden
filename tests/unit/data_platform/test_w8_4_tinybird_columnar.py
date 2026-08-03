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
async def test_query_home_kpis_live_sql_has_no_cost_usd() -> None:
    """``_query_home_kpis_live`` (the ``telemetry_events_ch`` fallback path)."""
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
        return (
            "event_count\ttrace_count\terror_count\tavg_duration_ms\t"
            "p95_duration_ms\tprev_event_count\tprev_trace_count\n"
            "10\t8\t1\t12.5\t40.0\t5\t4\n"
        )

    with patch.object(sink, "_execute", side_effect=capture):
        out = await sink._query_home_kpis_live("org-1", 24)

    assert out["event_count"] == 10
    assert out["trace_count"] == 8
    assert out["prev_event_count"] == 5
    assert out["prev_trace_count"] == 4
    assert out["cost_usd"] == 0.0
    # Single-scan: current + previous window collapsed into one query.
    assert len(captured) == 1
    assert "FROM telemetry_events_ch" in captured[0]
    assert "eden.telemetry_events_ch" not in captured[0]
    assert "sum(cost_usd)" not in captured[0]
    assert "\\'" not in captured[0]  # SQL-standard escape, not backslash
    assert "uniqExactIf(trace_id," in captured[0]
    assert "countIf(" in captured[0]


@pytest.mark.asyncio
async def test_query_home_kpis_prefers_pipe_on_tinybird() -> None:
    """``query_home_kpis`` hits ``home_kpi_hourly_api`` before /v0/sql."""
    sink = ClickHouseSink(
        ClickHouseConfig(
            url="https://api.us-east.tinybird.co",
            database="eden",
            tinybird_token="tok",
        )
    )
    pipe_result = {
        "event_count": 10,
        "trace_count": 7,
        "error_count": 1,
        "avg_duration_ms": 12.5,
        "p95_duration_ms": 40.0,
        "cost_usd": 0.0,
        "prev_event_count": 5,
        "prev_trace_count": 3,
    }
    with (
        patch.object(sink, "_query_home_kpis_pipe", AsyncMock(return_value=pipe_result)),
        patch.object(sink, "_execute", AsyncMock()) as mock_execute,
    ):
        out = await sink.query_home_kpis("org-1", window_hours=24)

    assert out == pipe_result
    mock_execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_query_home_kpis_prefers_rollup_on_tinybird() -> None:
    """``query_home_kpis`` reads ``home_kpi_hourly`` via /v0/sql when pipe misses."""
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
        return (
            "event_count\ttrace_count\terror_count\tavg_duration_ms\t"
            "p95_duration_ms\tprev_event_count\tprev_trace_count\n"
            "10\t8\t1\t12.5\t40.0\t5\t4\n"
        )

    with (
        patch.object(
            sink, "_query_home_kpis_pipe", AsyncMock(return_value=None)
        ),
        patch.object(sink, "_execute", side_effect=capture),
    ):
        out = await sink.query_home_kpis("org-1", window_hours=24)

    assert out["event_count"] == 10
    assert out["trace_count"] == 8
    assert out["prev_event_count"] == 5
    assert out["prev_trace_count"] == 4
    assert out["cost_usd"] == 0.0
    assert len(captured) == 1
    assert "FROM home_kpi_hourly" in captured[0]
    assert "telemetry_events_ch" not in captured[0]
    assert "countMerge(event_count)" in captured[0]
    assert "uniqExactMerge(trace_count)" in captured[0]
    assert "sumMerge(error_count)" in captured[0]
    assert "avgMerge(avg_duration_state)" in captured[0]
    assert "quantileMerge(0.95)(p95_duration_state)" in captured[0]
    assert "sum(cost_usd)" not in captured[0]


@pytest.mark.asyncio
async def test_query_home_kpis_pipe_parses_window_rows() -> None:
    """Pipe JSON (current + previous windows) folds into the sink dict."""
    sink = ClickHouseSink(
        ClickHouseConfig(
            url="https://api.us-east.tinybird.co",
            tinybird_token="tok",
        )
    )
    body = (
        '{"data":['
        '{"window":"current","event_count":10,"trace_count":7,'
        '"error_count":1,"avg_duration_ms":12.5,"p95_duration_ms":40.0},'
        '{"window":"previous","event_count":5,"trace_count":3,'
        '"error_count":0,"avg_duration_ms":9.0,"p95_duration_ms":20.0}'
        "]}"
    )
    resp = MagicMock()
    resp.status = 200
    resp.text = AsyncMock(return_value=body)
    resp.__aenter__ = AsyncMock(return_value=resp)
    resp.__aexit__ = AsyncMock(return_value=False)
    session = MagicMock()
    session.get = MagicMock(return_value=resp)

    with patch.object(sink, "_get_session", AsyncMock(return_value=session)):
        out = await sink._query_home_kpis_pipe("org-1", 24)

    assert out is not None
    assert out["event_count"] == 10
    assert out["trace_count"] == 7
    assert out["prev_event_count"] == 5
    assert out["prev_trace_count"] == 3
    _, kwargs = session.get.call_args
    assert kwargs["params"]["tenant_id"] == "org-1"
    assert kwargs["params"]["hours"] == "24"
    assert session.get.call_args.args[0].endswith(
        "/v0/pipes/home_kpi_hourly_api.json"
    )


@pytest.mark.asyncio
async def test_query_home_kpis_rollup_floors_window_to_hour_boundary() -> None:
    """Regression: comparing the hour-floored ``hour`` bucket column against
    a raw ``now() - INTERVAL n HOUR`` instant (non-zero minutes) pushed the
    single bucket straddling that instant entirely into ``prev``, silently
    undercounting ``cur``. Both sides of the cur/prev split must floor the
    threshold with ``toStartOfHour`` so the split is bucket-aligned and
    disjoint.
    """
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
        return (
            "event_count\ttrace_count\terror_count\tavg_duration_ms\t"
            "p95_duration_ms\tprev_event_count\tprev_trace_count\n"
            "10\t8\t1\t12.5\t40.0\t5\t4\n"
        )

    with (
        patch.object(sink, "_query_home_kpis_pipe", AsyncMock(return_value=None)),
        patch.object(sink, "_execute", side_effect=capture),
    ):
        await sink.query_home_kpis("org-1", window_hours=24)

    query = captured[0]
    assert "toStartOfHour(now() - INTERVAL 24 HOUR)" in query
    assert "toStartOfHour(now() - INTERVAL 48 HOUR)" in query
    # cur and prev must key off the *same* floored threshold instant so the
    # windows stay disjoint (no double count, no gap).
    assert query.count("toStartOfHour(now() - INTERVAL 24 HOUR)") == 2


@pytest.mark.asyncio
async def test_query_home_kpis_falls_back_when_rollup_raises() -> None:
    """A rollup-query error (e.g. not yet deployed) falls back to the live scan."""
    sink = ClickHouseSink(
        ClickHouseConfig(
            url="https://api.us-east.tinybird.co",
            database="eden",
            tinybird_token="tok",
        )
    )
    calls: list[str] = []

    async def flaky(query: str, params=None) -> str:  # noqa: ANN001
        calls.append(query)
        if "home_kpi_hourly" in query:
            raise ClickHouseError("HTTP 404: Unknown datasource 'home_kpi_hourly'")
        return (
            "event_count\ttrace_count\terror_count\tavg_duration_ms\t"
            "p95_duration_ms\tprev_event_count\tprev_trace_count\n"
            "7\t6\t0\t9.0\t20.0\t3\t2\n"
        )

    with (
        patch.object(
            sink,
            "_query_home_kpis_pipe",
            AsyncMock(side_effect=ClickHouseError("pipe 404")),
        ),
        patch.object(sink, "_execute", side_effect=flaky),
    ):
        out = await sink.query_home_kpis("org-1", window_hours=24)

    assert out["event_count"] == 7
    assert out["trace_count"] == 6
    assert out["prev_event_count"] == 3
    assert len(calls) == 2
    assert "home_kpi_hourly" in calls[0]
    assert "FROM telemetry_events_ch" in calls[1]


@pytest.mark.asyncio
async def test_query_home_kpis_falls_back_when_rollup_empty() -> None:
    """A rollup row with zero current-window events falls back (new datasource)."""
    sink = ClickHouseSink(
        ClickHouseConfig(
            url="https://api.us-east.tinybird.co",
            database="eden",
            tinybird_token="tok",
        )
    )
    calls: list[str] = []

    async def empty_then_live(query: str, params=None) -> str:  # noqa: ANN001
        calls.append(query)
        if "home_kpi_hourly" in query:
            return (
                "event_count\ttrace_count\terror_count\tavg_duration_ms\t"
                "p95_duration_ms\tprev_event_count\tprev_trace_count\n"
                "0\t0\t0\t0\t0\t0\t0\n"
            )
        return (
            "event_count\ttrace_count\terror_count\tavg_duration_ms\t"
            "p95_duration_ms\tprev_event_count\tprev_trace_count\n"
            "4\t3\t1\t15.0\t30.0\t2\t1\n"
        )

    with (
        patch.object(sink, "_query_home_kpis_pipe", AsyncMock(return_value=None)),
        patch.object(sink, "_execute", side_effect=empty_then_live),
    ):
        out = await sink.query_home_kpis("org-1", window_hours=24)

    assert out["event_count"] == 4
    assert out["trace_count"] == 3
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_query_home_kpis_local_clickhouse_skips_rollup() -> None:
    """Local (non-Tinybird) ClickHouse always uses the live query directly."""
    sink = ClickHouseSink(ClickHouseConfig(url="http://localhost:8123"))
    captured: list[str] = []

    async def capture(query: str, params=None) -> str:  # noqa: ANN001
        captured.append(query)
        return (
            "event_count\ttrace_count\terror_count\tavg_duration_ms\t"
            "p95_duration_ms\tprev_event_count\tprev_trace_count\n"
            "10\t8\t1\t12.5\t40.0\t5\t4\n"
        )

    with patch.object(sink, "_execute", side_effect=capture):
        out = await sink.query_home_kpis("org-1", window_hours=24)

    assert out["event_count"] == 10
    assert out["trace_count"] == 8
    assert len(captured) == 1
    assert "FROM eden.telemetry_events_ch" in captured[0]
    assert "countIf(" in captured[0]
    assert "uniqExactIf(trace_id," in captured[0]
    assert "avgIf(" in captured[0]
    assert "quantileIf(" in captured[0]


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
async def test_gdpr_ch_purge_raises_on_tinybird() -> None:
    """Tinybird cannot ALTER DELETE via /v0/sql — the purge must raise
    rather than silently report an empty-but-successful erasure. The
    caller (``delete_tenant_data``) catches this and records it on
    ``RetentionReport.errors`` so the incomplete erasure is visible,
    not swallowed as ``deleted_clickhouse_rows == 0``.
    """
    from eden.data_platform.retention import DataRetentionManager

    mgr = DataRetentionManager(dry_run=False)
    with patch(
        "eden.data_platform.retention.settings"
    ) as fake_settings:
        fake_settings.clickhouse_url = "https://api.us-east.tinybird.co"
        with pytest.raises(RuntimeError, match="Tinybird cannot ALTER DELETE"):
            await mgr._delete_from_clickhouse("tenant-1")


def test_gdpr_ch_purge_uses_tenant_id_column() -> None:
    import inspect

    from eden.data_platform.clickhouse_sink import ClickHouseSink

    src = inspect.getsource(ClickHouseSink.delete_tenant_rows)
    assert "DELETE WHERE tenant_id =" in src
    assert "DELETE WHERE org_id =" not in src
    assert "qualified_table" in src
    assert "metrics.agent_performance" not in src
    assert "default.telemetry_events_ch" not in src
