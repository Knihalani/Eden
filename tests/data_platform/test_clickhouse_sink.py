"""Tests for the ClickHouse analytics sink."""

import pytest
from eden.data_platform.clickhouse_sink import (
    ClickHouseSink,
    ClickHouseConfig,
    IngestionReport,
    ClickHouseError,
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
