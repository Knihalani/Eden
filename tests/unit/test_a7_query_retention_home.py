"""A7 — query / retention / Home optimization tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.data_platform.retention import ARCHIVE_CHUNK_SIZE, DataRetentionManager
from eden.observability.search_service import SearchService
from eden.observability.typesense_client import TypesenseClient
from eden.services.cat2_intel.signals import SignalClusterer, compile_signal
from eden.services.cat2_intel.signals import NLSignal


class _CapturingPG:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self._rows = rows or []

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append((sql, args))
        return list(self._rows)

    async def execute(self, sql: str, *args: Any) -> str:
        self.calls.append((sql, args))
        return "DELETE 0"


class TestK31SearchBounds:
    @pytest.mark.asyncio
    async def test_pg_fallback_always_applies_time_bounds(self, monkeypatch):
        pg = _CapturingPG(rows=[])
        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=pg),
        )
        svc = SearchService(client=None)
        await svc._pg_fallback_search(tenant_id="t1", query="hello")
        assert pg.calls, "expected a PG fetch"
        sql, args = pg.calls[0]
        assert "tenant_id = $1" in sql
        assert "timestamp >= to_timestamp(" in sql
        assert "timestamp <= to_timestamp(" in sql
        # Sargable timestamp compare — not EXTRACT on the column.
        assert "EXTRACT(EPOCH FROM timestamp) >=" not in sql
        # Trgm-friendly bare-column ILIKE (mig 113).
        assert "name ILIKE" in sql
        assert "agent_id ILIKE" in sql
        assert "COALESCE(agent_id" not in sql
        # args: tenant, pattern, from_ts, to_ts
        assert args[0] == "t1"
        assert float(args[-2]) < float(args[-1])

    def test_bounded_time_range_defaults_window(self):
        start, end = SearchService._bounded_time_range(None, None)
        assert end - start == SearchService.DEFAULT_FALLBACK_WINDOW_S


class TestK31CircuitBreaker:
    def test_opens_after_failure_threshold(self):
        client = TypesenseClient(host="h", port=8108, api_key="k")
        client._failure_threshold = 2
        client._backoff_s = 30.0
        assert client._is_reachable() is True
        client._record_failure()
        assert client._is_reachable() is True  # below threshold
        client._record_failure()
        assert client._is_reachable() is False
        client._open_until = 0.0  # half-open
        assert client._is_reachable() is True
        client._record_success()
        assert client._failure_count == 0


class TestB4RetentionChunking:
    @pytest.mark.asyncio
    async def test_archive_select_always_has_limit(self):
        pg = _CapturingPG(rows=[])
        mgr = DataRetentionManager(dry_run=True)
        mgr._get_postgres = AsyncMock(return_value=pg)  # type: ignore[method-assign]
        before = datetime.now(UTC) - timedelta(days=90)
        archived, s3 = await mgr.archive_to_cold(before, chunk_size=25)
        assert archived == 0 and s3 == 0
        assert pg.calls
        sql, args = pg.calls[0]
        assert "LIMIT" in sql.upper()
        assert args[-1] == 25
        assert ARCHIVE_CHUNK_SIZE == 1000

    @pytest.mark.asyncio
    async def test_archive_chunks_keyset(self):
        rows_page1 = [
            {"silver_event_id": f"00000000-0000-0000-0000-00000000000{i}",
             "timestamp": datetime(2024, 1, 1, tzinfo=UTC) + timedelta(seconds=i)}
            for i in range(2)
        ]
        pg = _CapturingPG()
        call_n = {"n": 0}

        async def fetch(sql: str, *args: Any) -> list[dict[str, Any]]:
            pg.calls.append((sql, args))
            call_n["n"] += 1
            if call_n["n"] == 1:
                return rows_page1
            return []

        pg.fetch = fetch  # type: ignore[method-assign]
        mgr = DataRetentionManager(dry_run=True)
        mgr._get_postgres = AsyncMock(return_value=pg)  # type: ignore[method-assign]
        archived, _ = await mgr.archive_to_cold(
            datetime.now(UTC), chunk_size=2
        )
        assert archived == 2
        assert len(pg.calls) >= 2
        assert "LIMIT" in pg.calls[0][0].upper()
        assert "(timestamp, silver_event_id)" in pg.calls[1][0]


class TestB12B13ListLimits:
    def test_playground_route_limit_le_100(self):
        from eden.api.routes import playgrounds as mod
        import inspect
        src = inspect.getsource(mod.list_playgrounds)
        assert "le=100" in src
        assert "Query(" in src

    def test_automations_route_limit_le_100(self):
        from eden.api.routes import wave6_online as mod
        import inspect
        src = inspect.getsource(mod.list_automations)
        assert "le=100" in src

    def test_labeling_board_limit_le_100(self):
        from eden.api.routes import labeling as mod
        import inspect
        src = inspect.getsource(mod.queue_board)
        assert "le=100" in src


class TestB22ClustererCap:
    def test_cluster_caps_n(self):
        clusterer = SignalClusterer(max_signals=5)

        def _sig(i: int) -> NLSignal:
            desc = f"refusal rate above {i}%"
            return NLSignal(
                id=f"s{i}",
                org_id="o",
                description=desc,
                rule=compile_signal(desc),
            )

        signals = [_sig(i) for i in range(20)]
        mapping = clusterer.cluster(signals)
        assert len(mapping) == 5


class TestK34HomeClickhouseSoftFail:
    @pytest.mark.asyncio
    async def test_home_kpi_soft_fails_without_url(self):
        from eden.api.routes.wave6_online import _home_kpi_from_clickhouse

        fake = MagicMock()
        fake.clickhouse_url = ""
        with patch("eden.config.get_settings", return_value=fake):
            assert await _home_kpi_from_clickhouse("org", window_hours=24) is None

    @pytest.mark.asyncio
    async def test_home_kpi_soft_fails_on_sink_error(self):
        from eden.api.routes.wave6_online import _home_kpi_from_clickhouse

        fake = MagicMock()
        fake.clickhouse_url = "http://localhost:8123"

        async def boom():
            raise RuntimeError("down")

        with (
            patch("eden.config.get_settings", return_value=fake),
            patch(
                "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
                side_effect=boom,
            ),
        ):
            assert await _home_kpi_from_clickhouse("org", window_hours=24) is None


class TestK32Projections:
    def test_issues_list_sql_projects_columns(self):
        from eden.issues import repo as mod
        assert "SELECT *" not in mod._ISSUE_LIST_COLUMNS
        assert "fingerprint" in mod._ISSUE_LIST_COLUMNS

    def test_alerts_list_sql_projects_columns(self):
        from eden.alerts import repo as mod
        assert "id" in mod._ALERT_EVENT_COLUMNS
        assert "*" not in mod._ALERT_EVENT_COLUMNS
