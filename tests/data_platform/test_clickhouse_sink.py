"""Tests for the ClickHouse analytics sink."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.data_platform.clickhouse_sink import (
    ClickHouseConfig,
    ClickHouseError,
    ClickHouseSink,
    IngestionReport,
)


class TestClickHouseConfig:
    def test_default_config(self):
        config = ClickHouseConfig()
        assert config.url == "http://localhost:8123"
        assert config.database == "eden"
        assert config.user == "default"
        assert config.timeout == 30

    def test_custom_config(self):
        config = ClickHouseConfig(
            url="http://ch.example.com:8123",
            database="analytics",
            user="admin",
            password="secret",
            timeout=60,
        )
        assert config.url == "http://ch.example.com:8123"
        assert config.database == "analytics"
        assert config.timeout == 60


class TestClickHouseSink:
    def test_init(self):
        config = ClickHouseConfig()
        sink = ClickHouseSink(config)
        assert sink.config == config
        assert sink._initialized is False
        assert sink._session is None

    def test_batch_size_constant(self):
        assert ClickHouseSink.BATCH_SIZE == 10_000

    @pytest.mark.asyncio
    async def test_health_check_no_server(self):
        config = ClickHouseConfig(url="http://localhost:19999")
        sink = ClickHouseSink(config)
        status = await sink.health_check()
        assert "error" in status.lower() or "connected" in status.lower()

    @pytest.mark.asyncio
    async def test_close_without_session(self):
        sink = ClickHouseSink()
        await sink.close()  # Should not raise
        assert sink._session is None


class TestIngestionReport:
    def test_defaults(self):
        report = IngestionReport(table="agent_performance")
        assert report.table == "agent_performance"
        assert report.rows_inserted == 0
        assert report.rows_failed == 0
        assert report.duration_ms == 0.0

    def test_with_data(self):
        report = IngestionReport(
            table="usage_trends",
            rows_inserted=1000,
            rows_failed=5,
            duration_ms=500.0,
            errors=["timeout"],
        )
        assert report.rows_inserted == 1000
        assert report.rows_failed == 5
        assert len(report.errors) == 1


class TestClickHouseError:
    def test_error_message(self):
        err = ClickHouseError("Connection refused")
        assert str(err) == "Connection refused"


class TestUuidColumnFilters:
    """Phase 0 overhaul: tenant_id filters must not use toUUID().

    Tinybird's ``agent_performance``/``pipeline_stages``/``usage_trends``
    datasources declare ``tenant_id UUID``, but callers throughout this
    codebase (and its own test suite — ``"org_test"``, ``"tenant-1"``)
    routinely pass a plain opaque string id, not a strictly-formed UUID
    literal. ``tenant_id = toUUID('org_test')`` fails outright on
    Tinybird with a UUID-parse error before the row filter ever runs.
    The deployed Tinybird pipes (``tinybird/pipes/agent_performance_api.pipe``
    et al.) already use a bare string-literal comparison instead; these
    tests pin the Python query helpers to the same working pattern.
    """

    def test_uuid_column_eq_builds_bare_string_comparison(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        assert sink._uuid_column_eq("tenant_id", "org_test") == "tenant_id = 'org_test'"

    def test_uuid_column_eq_escapes_quotes(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        assert (
            sink._uuid_column_eq("tenant_id", "o'brien")
            == "tenant_id = 'o''brien'"
        )

    @pytest.mark.asyncio
    async def test_query_agent_performance_has_no_touuid(self) -> None:
        sink = ClickHouseSink(
            ClickHouseConfig(
                url="https://api.us-east.tinybird.co",
                tinybird_token="tok",
            )
        )
        captured: list[str] = []

        async def capture(query: str, params=None) -> str:  # noqa: ANN001
            captured.append(query)
            return "tenant_id\tagent_name\n"

        with patch.object(sink, "_execute", side_effect=capture):
            await sink.query_agent_performance(tenant_id="org_test")

        assert "toUUID" not in captured[0]
        assert "tenant_id = 'org_test'" in captured[0]

    @pytest.mark.asyncio
    async def test_query_pipeline_bottlenecks_has_no_touuid(self) -> None:
        sink = ClickHouseSink(
            ClickHouseConfig(
                url="https://api.us-east.tinybird.co",
                tinybird_token="tok",
            )
        )
        captured: list[str] = []

        async def capture(query: str, params=None) -> str:  # noqa: ANN001
            captured.append(query)
            return "stage\n"

        with patch.object(sink, "_execute", side_effect=capture):
            await sink.query_pipeline_bottlenecks(tenant_id="tenant-1")

        assert "toUUID" not in captured[0]
        assert "tenant_id = 'tenant-1'" in captured[0]

    @pytest.mark.asyncio
    async def test_query_usage_trends_has_no_touuid(self) -> None:
        sink = ClickHouseSink(
            ClickHouseConfig(
                url="https://api.us-east.tinybird.co",
                tinybird_token="tok",
            )
        )
        captured: list[str] = []

        async def capture(query: str, params=None) -> str:  # noqa: ANN001
            captured.append(query)
            return "time_bucket\n"

        with patch.object(sink, "_execute", side_effect=capture):
            await sink.query_usage_trends(tenant_id="org_test")

        assert "toUUID" not in captured[0]
        assert "tenant_id = 'org_test'" in captured[0]


class TestUnreadDatasourceIngestGate:
    """Phase 1 overhaul: stop unpaid Tinybird storage for zero-reader tables.

    ``agent_performance``/``pipeline_stages``/``usage_trends``/
    ``benchmark_results`` have no query call sites anywhere in this
    codebase, and their only writer (``KafkaEventConsumer.
    consume_clickhouse``) is never invoked by any running process. Default
    OFF; flipping ``tinybird_ingest_unread_datasources_enabled`` restores
    the old always-on behaviour.
    """

    @staticmethod
    def _fake_settings(*, enabled: bool) -> MagicMock:
        """A settings double patched onto clickhouse_sink's own binding.

        ``clickhouse_sink.py`` does ``from eden.config import get_settings``
        at module load, so patching ``eden.config.get_settings`` (what the
        session-wide ``patch_settings`` autouse fixture does) does not
        reach this module's already-bound name — the same reason
        ``eden.api.middleware.*`` needs an explicit per-module patch in
        that fixture. Patching ``eden.data_platform.clickhouse_sink.
        get_settings`` directly is the correct target here.
        """
        fake = MagicMock()
        fake.tinybird_ingest_unread_datasources_enabled = enabled
        return fake

    def test_flag_defaults_off(self) -> None:
        from eden.config import Settings

        assert (
            Settings.model_fields[
                "tinybird_ingest_unread_datasources_enabled"
            ].default
            is False
        )

    @pytest.mark.asyncio
    async def test_ingest_agent_traces_noops_by_default(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        with (
            patch(
                "eden.data_platform.clickhouse_sink.get_settings",
                return_value=self._fake_settings(enabled=False),
            ),
            patch.object(sink, "init_schema", AsyncMock()) as mock_init,
            patch.object(sink, "_insert_json", AsyncMock()) as mock_insert,
        ):
            report = await sink.ingest_agent_traces([{"org_id": "org_test"}])
        assert report.table == "agent_performance"
        assert report.rows_inserted == 0
        assert report.rows_failed == 0
        mock_init.assert_not_called()
        mock_insert.assert_not_called()

    @pytest.mark.asyncio
    async def test_ingest_pipeline_stages_noops_by_default(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        with (
            patch(
                "eden.data_platform.clickhouse_sink.get_settings",
                return_value=self._fake_settings(enabled=False),
            ),
            patch.object(sink, "init_schema", AsyncMock()),
            patch.object(sink, "_insert_json", AsyncMock()) as mock_insert,
        ):
            report = await sink.ingest_pipeline_stages([{"org_id": "org_test"}])
        assert report.rows_inserted == 0
        mock_insert.assert_not_called()

    @pytest.mark.asyncio
    async def test_ingest_usage_trends_noops_by_default(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        with (
            patch(
                "eden.data_platform.clickhouse_sink.get_settings",
                return_value=self._fake_settings(enabled=False),
            ),
            patch.object(sink, "init_schema", AsyncMock()),
            patch.object(sink, "_insert_json", AsyncMock()) as mock_insert,
        ):
            report = await sink.ingest_usage_trends([{"org_id": "org_test"}])
        assert report.rows_inserted == 0
        mock_insert.assert_not_called()

    @pytest.mark.asyncio
    async def test_ingest_benchmark_results_noops_by_default(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        with (
            patch(
                "eden.data_platform.clickhouse_sink.get_settings",
                return_value=self._fake_settings(enabled=False),
            ),
            patch.object(sink, "init_schema", AsyncMock()),
            patch.object(sink, "_insert_json", AsyncMock()) as mock_insert,
        ):
            report = await sink.ingest_benchmark_results([{"org_id": "org_test"}])
        assert report.rows_inserted == 0
        mock_insert.assert_not_called()

    @pytest.mark.asyncio
    async def test_ingest_agent_traces_runs_when_flag_enabled(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig())
        sink._initialized = True  # skip the network-touching init_schema path
        with (
            patch(
                "eden.data_platform.clickhouse_sink.get_settings",
                return_value=self._fake_settings(enabled=True),
            ),
            patch.object(sink, "_insert_json", AsyncMock()) as mock_insert,
        ):
            report = await sink.ingest_agent_traces([{"org_id": "org_test"}])
        assert report.rows_inserted == 1
        mock_insert.assert_awaited_once()

    def test_telemetry_events_ch_ingest_is_not_gated(self) -> None:
        """The gate only names the four unread datasources.

        ``telemetry_events_ch`` has real readers (the query API pipe, the
        Home KPI rollups) and must stay on regardless of this flag —
        ``insert()``/``_insert_json`` (its call path) have no such check.
        """
        import inspect

        from eden.data_platform import clickhouse_sink as mod

        src = inspect.getsource(mod.ClickHouseSink.insert)
        assert "_unread_datasource_ingest_enabled" not in src


class TestHomeKpiRollup:
    """Home KPI hourly rollup (``home_kpi_hourly``): prefer the Tinybird
    pipe, then /v0/sql over the rollup, then live ``telemetry_events_ch``.

    See ``tests/unit/data_platform/test_w8_4_tinybird_columnar.py`` for the
    SQL-shape assertions on both the rollup and live queries; these tests
    cover the Postgres-fallback-preserving contract at the sink boundary.
    """

    @staticmethod
    def _tsv(event_count: int, prev_event_count: int = 0, *, trace_count: int | None = None) -> str:
        traces = event_count if trace_count is None else trace_count
        prev_traces = prev_event_count
        return (
            "event_count\ttrace_count\terror_count\tavg_duration_ms\t"
            "p95_duration_ms\tprev_event_count\tprev_trace_count\n"
            f"{event_count}\t{traces}\t0\t10.0\t20.0\t{prev_event_count}\t{prev_traces}\n"
        )

    @pytest.mark.asyncio
    async def test_rollup_result_used_when_nonempty(self) -> None:
        sink = ClickHouseSink(
            ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="tok")
        )
        with (
            patch.object(sink, "_query_home_kpis_pipe", AsyncMock(return_value=None)),
            patch.object(
                sink, "_execute", AsyncMock(return_value=self._tsv(10, 5, trace_count=8))
            ) as mock_execute,
        ):
            out = await sink.query_home_kpis("org_test", window_hours=24)
        assert out["event_count"] == 10
        assert out["trace_count"] == 8
        assert out["prev_event_count"] == 5
        mock_execute.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_falls_back_to_live_scan_on_rollup_exception(self) -> None:
        """Rollup query error (e.g. datasource not yet deployed) does not
        propagate — callers (``wave6_online._home_kpi_from_clickhouse``)
        must still get a usable result, not an exception that would skip
        straight past the Postgres fallback entirely.
        """
        sink = ClickHouseSink(
            ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="tok")
        )

        async def side_effect(query: str, params=None):  # noqa: ANN001
            if "home_kpi_hourly" in query:
                raise ClickHouseError("Unknown datasource 'home_kpi_hourly'")
            return self._tsv(3, 1)

        with (
            patch.object(
                sink,
                "_query_home_kpis_pipe",
                AsyncMock(side_effect=ClickHouseError("pipe missing")),
            ),
            patch.object(sink, "_execute", side_effect=side_effect) as mock_execute,
        ):
            out = await sink.query_home_kpis("org_test", window_hours=24)
        assert out["event_count"] == 3
        assert mock_execute.await_count == 2

    @pytest.mark.asyncio
    async def test_falls_back_to_live_scan_on_empty_rollup(self) -> None:
        """A zero-event rollup row (new datasource, no rows yet) falls back
        rather than reporting a false zero while the live table has data.
        """
        sink = ClickHouseSink(
            ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="tok")
        )

        async def side_effect(query: str, params=None):  # noqa: ANN001
            if "home_kpi_hourly" in query:
                return self._tsv(0, 0)
            return self._tsv(6, 2)

        with (
            patch.object(sink, "_query_home_kpis_pipe", AsyncMock(return_value=None)),
            patch.object(sink, "_execute", side_effect=side_effect),
        ):
            out = await sink.query_home_kpis("org_test", window_hours=24)
        assert out["event_count"] == 6
        assert out["prev_event_count"] == 2

    @pytest.mark.asyncio
    async def test_local_clickhouse_never_queries_rollup(self) -> None:
        """Non-Tinybird ClickHouse has no ``home_kpi_hourly`` datasource
        (it is Tinybird-native, per Decision B) — go straight to the live
        query.
        """
        sink = ClickHouseSink(ClickHouseConfig(url="http://localhost:8123"))
        with patch.object(
            sink, "_execute", AsyncMock(return_value=self._tsv(8, 4))
        ) as mock_execute:
            out = await sink.query_home_kpis("org_test", window_hours=24)
        assert out["event_count"] == 8
        mock_execute.assert_awaited_once()
        query = mock_execute.await_args.args[0]
        assert "home_kpi_hourly" not in query
        assert "FROM eden.telemetry_events_ch" in query

    @pytest.mark.asyncio
    async def test_postgres_fallback_path_unaffected(self) -> None:
        """``wave6_online._home_kpi_from_clickhouse`` soft-fails to ``None``
        (its Postgres-fallback signal) when the sink itself raises — the
        rollup/live split inside ``query_home_kpis`` must not change that
        outer contract.
        """
        sink = ClickHouseSink(
            ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="tok")
        )
        with (
            patch.object(
                sink,
                "_query_home_kpis_pipe",
                AsyncMock(side_effect=ClickHouseError("connection refused")),
            ),
            patch.object(
                sink, "_execute", AsyncMock(side_effect=ClickHouseError("connection refused"))
            ),
        ):
            with pytest.raises(ClickHouseError):
                await sink.query_home_kpis("org_test", window_hours=24)


class TestApplyTtlMigrationsTinybirdGuard:
    """Phase 1 overhaul: TTL is tb-deploy-owned on Tinybird; skip the ALTERs.

    Before this guard, every ``init_schema()`` call issued 8 ``ALTER
    TABLE ... MODIFY TTL`` statements against Tinybird's ``/v0/sql``, each
    one a guaranteed ``ClickHouseError`` (DDL is rejected outright) caught
    and logged at DEBUG — a wasted request per table, every call, against
    the same request quota ``init_schema`` otherwise skips DDL for.
    """

    @pytest.mark.asyncio
    async def test_skips_all_alters_on_tinybird(self) -> None:
        sink = ClickHouseSink(
            ClickHouseConfig(
                url="https://api.us-east.tinybird.co",
                tinybird_token="tok",
            )
        )
        with patch.object(sink, "_execute", AsyncMock()) as mock_execute:
            await sink._apply_ttl_migrations()
        mock_execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_still_runs_on_local_clickhouse(self) -> None:
        sink = ClickHouseSink(ClickHouseConfig(url="http://localhost:8123"))
        with patch.object(sink, "_execute", AsyncMock()) as mock_execute:
            await sink._apply_ttl_migrations()
        assert mock_execute.await_count == 8


class TestUnreadTelemetryMirrorFields:
    """Phase 1 overhaul: stop writing metrics/tags into telemetry_events_ch.

    No SELECT anywhere in this codebase (nor the deployed
    ``telemetry_events_query_api.pipe``) reads either column back from
    ClickHouse/Tinybird — Postgres holds the real JSON. Preferred over an
    ``ALTER TABLE ... DROP COLUMN`` per the task: the columns stay in both
    schemas, only the writer stops populating them.
    """

    @staticmethod
    def _tinybird_events_session() -> tuple[MagicMock, MagicMock]:
        resp = MagicMock()
        resp.status = 202
        resp.text = AsyncMock(return_value="")
        resp.__aenter__ = AsyncMock(return_value=resp)
        resp.__aexit__ = AsyncMock(return_value=False)
        session = MagicMock()
        session.post = MagicMock(return_value=resp)
        return session, resp

    @pytest.mark.asyncio
    async def test_metrics_and_tags_stripped_for_telemetry_events_ch(self) -> None:
        sink = ClickHouseSink(
            ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="tok")
        )
        session, _ = self._tinybird_events_session()
        with patch.object(sink, "_get_session", AsyncMock(return_value=session)):
            await sink._insert_json(
                "telemetry_events_ch",
                [{"event_id": "e1", "metrics": '{"cost_usd": 1}', "tags": "[]"}],
            )
        _, kwargs = session.post.call_args
        body = kwargs["data"]
        assert '"event_id"' in body
        assert '"metrics"' not in body
        assert '"tags"' not in body

    @pytest.mark.asyncio
    async def test_other_tables_keep_their_fields(self) -> None:
        """The strip is table-scoped, not a blanket key removal."""
        sink = ClickHouseSink(
            ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="tok")
        )
        session, _ = self._tinybird_events_session()
        with patch.object(sink, "_get_session", AsyncMock(return_value=session)):
            await sink._insert_json(
                "agent_performance",
                [{"tenant_id": "t1", "metrics": "keepme"}],
            )
        _, kwargs = session.post.call_args
        assert '"metrics":"keepme"' in kwargs["data"] or '"metrics": "keepme"' in kwargs["data"]


class TestInsertJsonBatchChunking:
    """``BATCH_SIZE`` was a dead constant — nothing chunked on it, so a

    single oversized ``insert()`` call would post one multi-thousand-row
    NDJSON body in one Events API request. ``_insert_json`` now splits
    anything over ``BATCH_SIZE`` into sequential sub-batch POSTs.
    """

    @staticmethod
    def _tinybird_events_session() -> tuple[MagicMock, MagicMock]:
        resp = MagicMock()
        resp.status = 202
        resp.text = AsyncMock(return_value="")
        resp.__aenter__ = AsyncMock(return_value=resp)
        resp.__aexit__ = AsyncMock(return_value=False)
        session = MagicMock()
        session.post = MagicMock(return_value=resp)
        return session, resp

    @pytest.mark.asyncio
    async def test_rows_under_batch_size_send_one_request(self) -> None:
        sink = ClickHouseSink(
            ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="tok")
        )
        sink.BATCH_SIZE = 3
        session, _ = self._tinybird_events_session()
        rows = [{"tenant_id": "t1", "n": i} for i in range(3)]
        with patch.object(sink, "_get_session", AsyncMock(return_value=session)):
            await sink._insert_json("agent_performance", rows)
        assert session.post.call_count == 1

    @pytest.mark.asyncio
    async def test_rows_over_batch_size_chunk_into_sequential_requests(self) -> None:
        sink = ClickHouseSink(
            ClickHouseConfig(url="https://api.us-east.tinybird.co", tinybird_token="tok")
        )
        sink.BATCH_SIZE = 3
        session, _ = self._tinybird_events_session()
        rows = [{"tenant_id": "t1", "n": i} for i in range(7)]
        with patch.object(sink, "_get_session", AsyncMock(return_value=session)):
            await sink._insert_json("agent_performance", rows)
        # 7 rows / chunks of 3 -> 3 requests (3 + 3 + 1), no row dropped.
        assert session.post.call_count == 3
        seen_ns: list[int] = []
        for _, kwargs in session.post.call_args_list:
            body = kwargs["data"]
            for line in body.strip().split("\n"):
                import json as _json

                seen_ns.append(_json.loads(line)["n"])
        assert seen_ns == list(range(7))
