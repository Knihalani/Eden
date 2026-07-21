"""Behavioural tests for Cat 18 — Columnar Engine (v1.3).

Exercises the four real services
(:class:`ColumnarPartitionManager`, :class:`ColumnarAggregator`,
:class:`ColumnarCompactor`, :class:`ColumnarQueryEngine`) and
the four routes that expose them, plus the closed-loop
:class:`ColumnarHook` that fires on the SLA-breach path AND
on the ``ch_unavailable`` reason from the query engine's
Postgres fallback.

Mirrors the structure of
:mod:`tests.intelligence.test_metric_studio` and
:mod:`tests.intelligence.test_cost_intelligence`:

* **Service-level unit tests** — call the service
  classes directly with a mocked Postgres client +
  a mocked :class:`ClickHouseSink`. The
  :func:`patch_postgres` autouse fixture in
  :mod:`tests.conftest` returns an empty ``fetch()`` by
  default, which gives the services a clean "no data"
  path. Tests that need data override the mock with a
  side-effect that matches the SQL fragment the
  service runs.
* **Route-level smoke tests** — a minimal
  :class:`FastAPI` app with the ``intelligence_columnar``
  router mounted and ``get_current_user`` overridden.
  We hit each of the 4 Cat 18 routes and assert the
  response shape.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Sample data ─────────────────────────────────────────────────


def _tsv_row(**kwargs: Any) -> str:
    """Build a TSV string the ClickHouseSink parser can read.

    The fixtures (partition, rollup, compaction_log) used
    to live as named builders but were never referenced
    by the test methods — the service classes construct
    their own sample data via the
    ``mock_postgres_client.fetch / fetchrow`` mocks. The
    builders were deleted in the v1.3 polish pass.
    """
    headers = list(kwargs.keys())
    values = [str(v) for v in kwargs.values()]
    return "\t".join(headers) + "\n" + "\t".join(values)


# ─── Test class: ColumnarPartitionManager ───────────────────────


class TestColumnarPartitionManager:
    """Service-level tests for the partition manager."""

    async def test_invalid_granularity_returns_stub(self) -> None:
        from eden.columnar import ColumnarPartitionManager
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        result = await ColumnarPartitionManager().ensure(
            "org_test", granularity="invalid"
        )
        assert result["status"] == "not_implemented"
        assert "invalid granularity" in result["message"]

    async def test_invalid_source_table_returns_stub(self) -> None:
        from eden.columnar import ColumnarPartitionManager
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        result = await ColumnarPartitionManager().ensure(
            "org_test",
            granularity="day",
            source_table="drop_table_x",
        )
        assert result["status"] == "not_implemented"
        assert "invalid source_table" in result["message"]

    async def test_clickhouse_unavailable_falls_back_to_postgres(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.columnar import ColumnarPartitionManager
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        # Force the probe to return False.
        with patch(
            "eden.columnar._common._check_ch_available",
            new=AsyncMock(return_value=False),
        ):
            mock_postgres_client.fetchrow = AsyncMock(
                return_value={"n": 5000}
            )
            result = await ColumnarPartitionManager().ensure(
                "org_test",
                granularity="day",
                source_table="telemetry_events",
            )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["data_source"] == "postgres_fallback"
        assert result["data"]["rows_estimate"] == 5000
        assert "ClickHouse unavailable" in result["message"]

    async def test_clickhouse_happy_path(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.columnar import ColumnarPartitionManager
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        # Mock ClickHouse sink to return a healthy + count
        # result. The probe and the count call both hit
        # the sink.
        mock_sink = MagicMock()
        mock_sink.config.database = "eden"
        mock_sink.health_check = AsyncMock(return_value="connected")
        mock_sink._execute = AsyncMock(
            return_value=_tsv_row(n=10000, b=2560000)
        )
        mock_sink._parse_tsv = MagicMock(
            return_value=[{"n": 10000, "b": 2560000}]
        )
        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            new=AsyncMock(return_value=mock_sink),
        ):
            result = await ColumnarPartitionManager().ensure(
                "org_test",
                granularity="day",
                source_table="telemetry_events",
            )
        assert result["status"] == "ok"
        assert result["data"]["data_source"] == "clickhouse"
        assert result["data"]["rows_estimate"] == 10000
        assert result["data"]["bytes_estimate"] == 2560000
        assert "fallback" not in result.get("message", "")

    async def test_hourly_granularity_rejected(self) -> None:
        """Hourly granularity was cut per upgradespec §D.6.

        Asking for hourly must return the stable not_implemented
        envelope so the UI renders the missing-granularity card
        instead of silently falling back to daily.
        """
        from eden.columnar import ColumnarPartitionManager

        result = await ColumnarPartitionManager().ensure(
            "org_test",
            granularity="hour",
            source_table="telemetry_events",
        )
        assert result["status"] == "not_implemented"
        assert result["live"] is False
        assert "hour" in result["message"]

    async def test_clickhouse_exception_falls_back(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """A ClickHouse error mid-call should fall through to Postgres."""
        from eden.columnar import ColumnarPartitionManager
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        mock_sink = MagicMock()
        mock_sink.config.database = "eden"
        mock_sink.health_check = AsyncMock(return_value="connected")
        mock_sink._execute = AsyncMock(
            side_effect=RuntimeError("ch timeout")
        )
        mock_sink._parse_tsv = MagicMock(return_value=[])
        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            new=AsyncMock(return_value=mock_sink),
        ):
            mock_postgres_client.fetchrow = AsyncMock(
                return_value={"n": 1000}
            )
            result = await ColumnarPartitionManager().ensure(
                "org_test",
                granularity="day",
                source_table="usage_events",
            )
        assert result["status"] == "ok"
        assert result["data"]["data_source"] == "postgres_fallback"


# ─── Test class: ColumnarAggregator ──────────────────────────────


class TestColumnarAggregator:
    """Service-level tests for the rollup pre-compute."""

    async def test_invalid_source_table_returns_stub(self) -> None:
        from eden.columnar import ColumnarAggregator
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        result = await ColumnarAggregator().precompute_rollups(
            "org_test",
            table="DROP TABLE x",
            granularity="day",
            window_start=datetime(2026, 5, 1, tzinfo=UTC),
            window_end=datetime(2026, 6, 1, tzinfo=UTC),
        )
        assert result["status"] == "not_implemented"
        assert "invalid source_table" in result["message"]

    async def test_invalid_granularity_returns_stub(self) -> None:
        from eden.columnar import ColumnarAggregator
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        result = await ColumnarAggregator().precompute_rollups(
            "org_test",
            table="telemetry_events",
            granularity="year",
            window_start=datetime(2026, 1, 1, tzinfo=UTC),
            window_end=datetime(2026, 12, 1, tzinfo=UTC),
        )
        assert result["status"] == "not_implemented"
        assert "invalid granularity" in result["message"]

    async def test_inverted_window_returns_stub(self) -> None:
        from eden.columnar import ColumnarAggregator

        result = await ColumnarAggregator().precompute_rollups(
            "org_test",
            table="telemetry_events",
            granularity="day",
            window_start=datetime(2026, 6, 1, tzinfo=UTC),
            window_end=datetime(2026, 5, 1, tzinfo=UTC),
        )
        assert result["status"] == "not_implemented"
        assert "window_end must be after window_start" in result["message"]

    async def test_clickhouse_happy_path_persists(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.columnar import ColumnarAggregator
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        # 3 buckets × varying counts.
        mock_sink = MagicMock()
        mock_sink.config.database = "eden"
        mock_sink.health_check = AsyncMock(return_value="connected")
        mock_sink._execute = AsyncMock(
            return_value=(
                "bucket\tn\tn_errors\tp95_ms\n"
                "2026-05-01 00:00:00\t1000\t5\t87.4\n"
                "2026-05-02 00:00:00\t1500\t8\t92.1\n"
                "2026-05-03 00:00:00\t500\t2\t65.0\n"
            )
        )
        mock_sink._parse_tsv = MagicMock(
            return_value=[
                {"bucket": "2026-05-01 00:00:00", "n": "1000",
                 "n_errors": "5", "p95_ms": "87.4"},
                {"bucket": "2026-05-02 00:00:00", "n": "1500",
                 "n_errors": "8", "p95_ms": "92.1"},
                {"bucket": "2026-05-03 00:00:00", "n": "500",
                 "n_errors": "2", "p95_ms": "65.0"},
            ]
        )
        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            new=AsyncMock(return_value=mock_sink),
        ):
            mock_postgres_client.execute = AsyncMock(return_value=None)
            result = await ColumnarAggregator().precompute_rollups(
                "org_test",
                table="telemetry_events",
                granularity="day",
                window_start=datetime(2026, 5, 1, tzinfo=UTC),
                window_end=datetime(2026, 6, 1, tzinfo=UTC),
            )
        assert result["status"] == "ok"
        assert result["data"]["data_source"] == "clickhouse"
        assert result["data"]["n_rows"] == 3000
        assert result["data"]["n_buckets"] == 3
        # Persistence: delete + insert both called.
        assert mock_postgres_client.execute.await_count == 2
        # The persisted payload is a JSON string with 3
        # buckets. The helper passes args positionally
        # (sql, uuid, org_id, source_table, granularity,
        # window_start, window_end, payload_json, n_rows,
        # compressed_bytes) so payload_json is at args[7].
        insert_call = mock_postgres_client.execute.await_args_list[1]
        payload_str = insert_call.args[7]
        payload = json.loads(payload_str)
        assert len(payload["buckets"]) == 3

    async def test_postgres_fallback_path(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.columnar import ColumnarAggregator
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        with patch(
            "eden.columnar._common._check_ch_available",
            new=AsyncMock(return_value=False),
        ):
            mock_postgres_client.fetch = AsyncMock(
                return_value=[
                    {"bucket": datetime(2026, 5, 1, tzinfo=UTC),
                     "n": 800},
                    {"bucket": datetime(2026, 5, 2, tzinfo=UTC),
                     "n": 1200},
                ]
            )
            mock_postgres_client.execute = AsyncMock(return_value=None)
            result = await ColumnarAggregator().precompute_rollups(
                "org_test",
                table="usage_events",
                granularity="day",
                window_start=datetime(2026, 5, 1, tzinfo=UTC),
                window_end=datetime(2026, 6, 1, tzinfo=UTC),
            )
        assert result["status"] == "ok"
        assert result["data"]["data_source"] == "postgres_fallback"
        assert result["data"]["n_rows"] == 2000


# ─── Test class: ColumnarCompactor ──────────────────────────────


class TestColumnarCompactor:
    """Service-level tests for the compactor."""

    async def test_empty_partition_id_returns_stub(self) -> None:
        from eden.columnar import ColumnarCompactor

        result = await ColumnarCompactor().compact_segments(
            "org_test", partition_id=""
        )
        assert result["status"] == "not_implemented"
        assert "partition_id is required" in result["message"]

    async def test_clickhouse_happy_path(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.columnar import ColumnarCompactor
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        # size call 1 (rows_in) + size call 2 (rows_out)
        # + optimize call.
        mock_sink = MagicMock()
        mock_sink.config.database = "eden"
        mock_sink.health_check = AsyncMock(return_value="connected")
        mock_sink._execute = AsyncMock(side_effect=[
            _tsv_row(n=10000, b=2560000),  # rows_in
            "",  # optimize (no return)
            _tsv_row(n=200, b=51200),  # rows_out
        ])
        mock_sink._parse_tsv = MagicMock(side_effect=[
            [{"n": 10000, "b": 2560000}],
            [{"n": 200, "b": 51200}],
        ])
        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            new=AsyncMock(return_value=mock_sink),
        ):
            mock_postgres_client.execute = AsyncMock(return_value=None)
            result = await ColumnarCompactor().compact_segments(
                "org_test", partition_id="eden.org_test.2026_06"
            )
        assert result["status"] == "ok"
        assert result["data"]["data_source"] == "clickhouse"
        assert result["data"]["rows_in"] == 10000
        assert result["data"]["rows_out"] == 200
        assert result["data"]["compression_ratio"] == 50.0
        assert result["data"]["status"] == "ok"
        assert result["data"]["sla_breached"] is False

    async def test_postgres_fallback_synthesises_compression(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.columnar import ColumnarCompactor
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        with patch(
            "eden.columnar._common._check_ch_available",
            new=AsyncMock(return_value=False),
        ):
            mock_postgres_client.fetchrow = AsyncMock(
                return_value={"n": 50000}
            )
            mock_postgres_client.execute = AsyncMock(return_value=None)
            result = await ColumnarCompactor().compact_segments(
                "org_test", partition_id="eden.org_test.2026_06"
            )
        assert result["status"] == "ok"
        assert result["data"]["data_source"] == "postgres_fallback"
        # 50x compression target on 50,000 rows = 1000.
        assert result["data"]["rows_out"] == 1000
        assert result["data"]["compression_ratio"] == 50.0

    async def test_sla_breach_fires_hook(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """A wall-clock time > SLA_SECONDS fires on_compaction_drift.

        We can't actually sleep for 4 hours in a test, so
        we patch :data:`SLA_SECONDS` to a tiny value
        (1ms) and let the actual ``_ch_optimize`` call
        take its real wall-clock time. The hook is
        verified via the ``ColumnarHook`` singleton.
        """
        from eden.columnar import ColumnarCompactor
        from eden.columnar import compaction as compaction_mod
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        mock_sink = MagicMock()
        mock_sink.config.database = "eden"
        mock_sink.health_check = AsyncMock(return_value="connected")
        mock_sink._execute = AsyncMock(side_effect=[
            _tsv_row(n=1000, b=256000),
            "",
            _tsv_row(n=20, b=5120),
        ])
        mock_sink._parse_tsv = MagicMock(side_effect=[
            [{"n": 1000, "b": 256000}],
            [{"n": 20, "b": 5120}],
        ])
        with patch.object(compaction_mod, "SLA_SECONDS", 0), patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            new=AsyncMock(return_value=mock_sink),
        ):
            mock_postgres_client.execute = AsyncMock(return_value=None)
            # Patch the hook firer to record the call.
            with patch(
                "eden.columnar.compaction._fire_compaction_drift_hook",
                new=AsyncMock(),
            ) as mock_fire:
                result = await ColumnarCompactor().compact_segments(
                    "org_test", partition_id="eden.org_test.2026_06"
                )
        assert result["data"]["sla_breached"] is True
        # The hook firer was called with the SLA-breach
        # reason.
        assert mock_fire.await_count == 1
        reason_kw = mock_fire.await_args.kwargs
        assert reason_kw["reason"] == "sla_breach"
        assert reason_kw["severity"] == "high"


# ─── Test class: ColumnarQueryEngine ────────────────────────────


class TestColumnarQueryEngine:
    """Service-level tests for the query engine."""

    async def test_invalid_engine_returns_stub(self) -> None:
        from eden.columnar import ColumnarQueryEngine

        result = await ColumnarQueryEngine().execute(
            "org_test",
            query="SELECT 1",
            engine="snowflake",
        )
        assert result["status"] == "not_implemented"
        assert "invalid engine" in result["message"]

    async def test_empty_query_returns_stub(self) -> None:
        from eden.columnar import ColumnarQueryEngine

        result = await ColumnarQueryEngine().execute(
            "org_test", query="   "
        )
        assert result["status"] == "not_implemented"
        assert "query is required" in result["message"]

    async def test_readonly_violation_rejected(self) -> None:
        from eden.columnar import ColumnarQueryEngine

        result = await ColumnarQueryEngine().execute(
            "org_test",
            query="DROP TABLE telemetry_events",
            engine="clickhouse",
        )
        assert result["status"] == "not_implemented"
        assert "read-only allowlist" in result["message"]

    async def test_missing_org_id_filter_rejected(self) -> None:
        from eden.columnar import ColumnarQueryEngine
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        # Bypass the auto probe (we want to test the
        # auto path that would otherwise call the
        # substrate). We can test the missing-org-id path
        # by using engine='postgres' (no probe needed).
        result = await ColumnarQueryEngine().execute(
            "org_test",
            query="SELECT count() FROM telemetry_events",
            engine="postgres",
        )
        assert result["status"] == "not_implemented"
        assert "must include an org_id filter" in result["message"]

    async def test_clickhouse_happy_path(self) -> None:
        from eden.columnar import ColumnarQueryEngine
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        mock_sink = MagicMock()
        mock_sink.config.database = "eden"
        mock_sink.health_check = AsyncMock(return_value="connected")
        mock_sink._execute = AsyncMock(
            return_value="model\tn\nclaude-sonnet-4\t452000\n"
        )
        mock_sink._parse_tsv = MagicMock(
            return_value=[{"model": "claude-sonnet-4", "n": "452000"}]
        )
        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            new=AsyncMock(return_value=mock_sink),
        ):
            result = await ColumnarQueryEngine().execute(
                "org_test",
                query=(
                    "SELECT model, count() AS n "
                    "FROM telemetry_events "
                    "WHERE org_id = 'org_test' "
                    "GROUP BY model"
                ),
                engine="clickhouse",
            )
        assert result["status"] == "ok"
        assert result["data"]["data_source"] == "clickhouse"
        assert result["data"]["n_rows"] == 1

    async def test_clickhouse_failure_with_auto_falls_back(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.columnar import ColumnarQueryEngine
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        mock_sink = MagicMock()
        mock_sink.config.database = "eden"
        mock_sink.health_check = AsyncMock(return_value="connected")
        mock_sink._execute = AsyncMock(
            side_effect=RuntimeError("ch timeout")
        )
        mock_sink._parse_tsv = MagicMock(return_value=[])
        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            new=AsyncMock(return_value=mock_sink),
        ):
            mock_postgres_client.fetch = AsyncMock(
                return_value=[{"model": "gpt-4o", "n": 100}]
            )
            with patch(
                "eden.columnar.query._fire_compaction_drift_hook",
                new=AsyncMock(),
            ) as mock_fire:
                result = await ColumnarQueryEngine().execute(
                    "org_test",
                    query=(
                        "SELECT model, count() AS n "
                        "FROM telemetry_events "
                        "WHERE org_id = 'org_test' "
                        "GROUP BY model"
                    ),
                    engine="auto",
                )
        assert result["status"] == "ok"
        assert result["data"]["data_source"] == "postgres_fallback"
        assert result["data"]["n_rows"] == 1
        # The ch_unavailable hook fired.
        assert mock_fire.await_count == 1
        assert mock_fire.await_args.kwargs["reason"] == "ch_unavailable"

    async def test_clickhouse_failure_with_explicit_engine_returns_error(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.columnar import ColumnarQueryEngine
        from eden.columnar._common import _reset_ch_health_cache

        _reset_ch_health_cache()
        mock_sink = MagicMock()
        mock_sink.config.database = "eden"
        mock_sink.health_check = AsyncMock(return_value="connected")
        mock_sink._execute = AsyncMock(
            side_effect=RuntimeError("ch boom")
        )
        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            new=AsyncMock(return_value=mock_sink),
        ):
            result = await ColumnarQueryEngine().execute(
                "org_test",
                query=(
                    "SELECT model, count() AS n "
                    "FROM telemetry_events "
                    "WHERE org_id = 'org_test' "
                    "GROUP BY model"
                ),
                engine="clickhouse",
            )
        assert result["status"] == "not_implemented"
        assert "clickhouse query failed" in result["message"]

    async def test_postgres_only_path(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.columnar import ColumnarQueryEngine

        mock_postgres_client.fetch = AsyncMock(
            return_value=[{"model": "gpt-4o", "n": 200}]
        )
        result = await ColumnarQueryEngine().execute(
            "org_test",
            query=(
                "SELECT model, count() AS n "
                "FROM telemetry_events "
                "WHERE org_id = 'org_test' "
                "GROUP BY model"
            ),
            engine="postgres",
        )
        assert result["status"] == "ok"
        assert result["data"]["data_source"] == "postgres"
        assert result["data"]["engine_used"] == "postgres"


# ─── Test class: read-only SQL allowlist ────────────────────────


class TestReadOnlySqlAllowlist:
    """The allowlist check is the data-leak defence-in-depth layer."""

    def test_select_passes(self) -> None:
        from eden.columnar.query import _looks_like_readonly_sql

        assert _looks_like_readonly_sql(
            "SELECT 1 FROM telemetry_events WHERE org_id = 'x'"
        )

    def test_with_passes(self) -> None:
        from eden.columnar.query import _looks_like_readonly_sql

        assert _looks_like_readonly_sql(
            "WITH x AS (SELECT 1) SELECT * FROM x"
        )

    def test_drop_rejected(self) -> None:
        from eden.columnar.query import _looks_like_readonly_sql

        assert not _looks_like_readonly_sql("DROP TABLE x")

    def test_update_rejected(self) -> None:
        from eden.columnar.query import _looks_like_readonly_sql

        assert not _looks_like_readonly_sql("UPDATE x SET a = 1")

    def test_delete_rejected(self) -> None:
        from eden.columnar.query import _looks_like_readonly_sql

        assert not _looks_like_readonly_sql("DELETE FROM x")

    def test_insert_rejected(self) -> None:
        from eden.columnar.query import _looks_like_readonly_sql

        assert not _looks_like_readonly_sql("INSERT INTO x VALUES (1)")

    def test_alter_rejected(self) -> None:
        from eden.columnar.query import _looks_like_readonly_sql

        assert not _looks_like_readonly_sql("ALTER TABLE x ADD COLUMN y INT")

    def test_empty_rejected(self) -> None:
        from eden.columnar.query import _looks_like_readonly_sql

        assert not _looks_like_readonly_sql("")
        assert not _looks_like_readonly_sql("   ")

    def test_string_literals_with_keywords_allowed(self) -> None:
        from eden.columnar.query import _looks_like_readonly_sql

        # A string literal containing the word "drop"
        # should not be rejected.
        assert _looks_like_readonly_sql(
            "SELECT 'drop this' FROM x WHERE org_id = 'y'"
        )


# ─── Test class: package contract ───────────────────────────────


class TestPackageContract:
    """The package exposes the 4 services via lazy re-export."""

    def test_lazy_reexports_resolve(self) -> None:
        from eden import columnar

        assert isinstance(columnar.ColumnarAggregator, type)
        assert isinstance(columnar.ColumnarCompactor, type)
        assert isinstance(columnar.ColumnarPartitionManager, type)
        assert isinstance(columnar.ColumnarQueryEngine, type)

    def test_dir_shows_public_surface(self) -> None:
        from eden import columnar

        names = dir(columnar)
        assert "ColumnarAggregator" in names
        assert "ColumnarCompactor" in names
        assert "ColumnarPartitionManager" in names
        assert "ColumnarQueryEngine" in names

    def test_unknown_attribute_raises(self) -> None:
        from eden import columnar

        with pytest.raises(AttributeError):
            _ = columnar.NoSuchService


# ─── Test class: hook registration ───────────────────────────────


class TestColumnarHook:
    """The closed-loop hook is registered as a singleton."""

    def test_singleton_is_registered(self) -> None:
        from eden.llmops.promotion_hooks import (
            ColumnarHook,
            get_columnar_hook,
        )

        hook = get_columnar_hook()
        assert isinstance(hook, ColumnarHook)

    def test_on_compaction_drift_logs(self) -> None:
        from eden.llmops.promotion_hooks import get_columnar_hook

        # No-op in v1.3 — just confirm the call doesn't
        # raise. A v1.4 implementation would route the
        # event to the org's alert channel.
        get_columnar_hook().on_compaction_drift(
            "org_test",
            partition_id="eden.org_test.2026_06",
            reason="sla_breach",
            severity="high",
        )


# ─── Test class: route smoke tests ──────────────────────────────


def _pg_router(
    mock_postgres_client: MagicMock,
) -> Any:
    """Build a FastAPI app with the columnar router mounted."""
    from eden.api.deps import get_current_user, require_path_org_access
    from eden.api.routes import intelligence_columnar

    app = FastAPI()
    app.include_router(intelligence_columnar.router)
    app.dependency_overrides[get_current_user] = lambda: {
        "user_id": "user_test"
    }
    app.dependency_overrides[require_path_org_access] = lambda: "org_test"
    return app


@pytest.fixture(scope="module")
def columnar_client() -> TestClient:
    """A TestClient with the intelligence_gap_v0 flag enabled.

    Mirrors the pattern in
    :mod:`tests.intelligence.test_metric_studio` and
    :mod:`tests.intelligence.test_cost_intelligence` —
    the flag is set on the cached settings singleton so
    the dependency reads it on each call.
    """
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    return TestClient(_pg_router(MagicMock()))


class TestColumnarRoutes:
    """Route-level smoke tests for the 4 Cat 18 routes."""

    def test_partitions_ensure_route(
        self, columnar_client: TestClient, mock_postgres_client: MagicMock
    ) -> None:
        # Force the auto path to fall through to Postgres.
        with patch(
            "eden.columnar._common._check_ch_available",
            new=AsyncMock(return_value=False),
        ):
            mock_postgres_client.execute = AsyncMock(return_value=None)
            mock_postgres_client.fetchrow = AsyncMock(
                return_value={"n": 1000}
            )
            resp = columnar_client.post(
                "/orgs/org_test/intelligence/columnar/partitions/ensure",
                json={"granularity": "day",
                      "source_table": "telemetry_events"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "ColumnarPartitionManager"
        assert body["data"]["data_source"] == "postgres_fallback"

    def test_rollups_precompute_route(
        self, columnar_client: TestClient, mock_postgres_client: MagicMock
    ) -> None:
        with patch(
            "eden.columnar._common._check_ch_available",
            new=AsyncMock(return_value=False),
        ):
            mock_postgres_client.fetch = AsyncMock(
                return_value=[
                    {"bucket": datetime(2026, 5, 1, tzinfo=UTC),
                     "n": 100},
                ]
            )
            mock_postgres_client.execute = AsyncMock(return_value=None)
            resp = columnar_client.post(
                "/orgs/org_test/intelligence/columnar/rollups/precompute",
                json={
                    "table": "telemetry_events",
                    "granularity": "day",
                    "window_start": "2026-05-01T00:00:00+00:00",
                    "window_end": "2026-06-01T00:00:00+00:00",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "ColumnarAggregator"
        assert body["data"]["data_source"] == "postgres_fallback"

    def test_compact_route(
        self, columnar_client: TestClient, mock_postgres_client: MagicMock
    ) -> None:
        with patch(
            "eden.columnar._common._check_ch_available",
            new=AsyncMock(return_value=False),
        ):
            mock_postgres_client.fetchrow = AsyncMock(
                return_value={"n": 1000}
            )
            mock_postgres_client.execute = AsyncMock(return_value=None)
            resp = columnar_client.post(
                "/orgs/org_test/intelligence/columnar/compact",
                json={"partition_id": "eden.org_test.2026_06"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "ColumnarCompactor"
        assert body["data"]["data_source"] == "postgres_fallback"

    def test_query_route_pg_only(
        self, columnar_client: TestClient, mock_postgres_client: MagicMock
    ) -> None:
        mock_postgres_client.fetch = AsyncMock(
            return_value=[{"model": "gpt-4o", "n": 100}]
        )
        resp = columnar_client.post(
            "/orgs/org_test/intelligence/columnar/query",
            json={
                "query": (
                    "SELECT model, count() AS n "
                    "FROM telemetry_events "
                    "WHERE org_id = 'org_test' "
                    "GROUP BY model"
                ),
                "engine": "postgres",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "ColumnarQueryEngine"
        assert body["data"]["data_source"] == "postgres"
        assert body["data"]["n_rows"] == 1

    def test_query_route_readonly_violation(
        self, columnar_client: TestClient
    ) -> None:
        resp = columnar_client.post(
            "/orgs/org_test/intelligence/columnar/query",
            json={
                "query": "DROP TABLE telemetry_events",
                "engine": "clickhouse",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "not_implemented"
        assert "read-only allowlist" in body["message"]
