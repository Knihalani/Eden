"""Unit tests for the cold archive service + migration 040 (Phase B3).

Verifies:
- ArchiveService.archive_old_rows: candidate selection, per-trace
  batching, idempotent re-runs (ON CONFLICT), NDJSON shape.
- ArchiveService.lookup / rehydrate: round-trip the in-process cache.
- Migration 040 syntax + revision chain.
- Retention cron wires ArchiveService.
- Read shim in telemetry_collector falls back to archive when the
  Postgres query returns no rows.
"""
from __future__ import annotations

import importlib.util
import inspect
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.services.data_platform import DEFAULT_COLD_AGE_DAYS, ArchiveService

# ── Constants ─────────────────────────────────────────────────────────


def test_default_cold_age_is_90_days():
    assert DEFAULT_COLD_AGE_DAYS == 90


# ── Migration 040 syntax ─────────────────────────────────────────────

# Audit 2026-06-23: original hardcoded macOS path
# (``/Users/kaiavnihalani/Downloads/Eden/...``) failed on the CI
# runner (Ubuntu). Resolve relative to this test file.
_MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[4]
    / "src" / "eden" / "db_migrations" / "versions"
)


class TestMigration040Syntax:
    @staticmethod
    def _load_migration():
        path = _MIGRATIONS_DIR / "040_trace_archive_index.py"
        spec = importlib.util.spec_from_file_location(
            "trace_archive_index", path
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_revision_chain(self):
        m = self._load_migration()
        assert m.revision == "040"
        assert m.down_revision == "039"

    def test_index_columns(self):
        """The trace_archive_index table has the 5 expected columns."""
        text = (_MIGRATIONS_DIR / "040_trace_archive_index.py").read_text()
        for col in (
            "trace_id",
            "org_id",
            "archive_path",
            "row_count",
            "archived_at",
        ):
            assert col in text, f"trace_archive_index missing column {col}"

    def test_indexes_created(self):
        text = (_MIGRATIONS_DIR / "040_trace_archive_index.py").read_text()
        assert "idx_trace_archive_org_archived" in text
        assert "idx_trace_archive_archived_brin" in text


# ── ArchiveService.archive_old_rows ───────────────────────────────────


class TestArchiveOldRows:
    @pytest.mark.asyncio
    async def test_returns_zero_when_no_postgres(self):
        svc = ArchiveService()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            result = await svc.archive_old_rows("org_1", dry_run=False)
        assert result == {"traces_archived": 0, "rows_archived": 0, "s3_objects": 0}

    @pytest.mark.asyncio
    async def test_no_eligible_traces_returns_zero(self):
        svc = ArchiveService()
        client = MagicMock()
        client.fetch = AsyncMock(return_value=[])
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            result = await svc.archive_old_rows("org_1", dry_run=False)
        assert result["traces_archived"] == 0

    @pytest.mark.asyncio
    async def test_dry_run_reports_counts_without_writes(self):
        svc = ArchiveService()
        client = MagicMock()
        # First call returns the candidate list; subsequent calls return
        # the per-trace rows (5 for trace_a, 3 for trace_b).
        candidates = [
            {"trace_id": "trace_a", "n": 5, "first_ts": datetime.now(UTC)},
            {"trace_id": "trace_b", "n": 3, "first_ts": datetime.now(UTC)},
        ]
        rows_a = [{"event_id": f"evt_a_{i}", "trace_id": "trace_a"} for i in range(5)]
        rows_b = [{"event_id": f"evt_b_{i}", "trace_id": "trace_b"} for i in range(3)]
        call_count = {"n": 0}

        async def fetch_side_effect(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return candidates
            if call_count["n"] == 2:
                return rows_a
            return rows_b

        client.fetch = AsyncMock(side_effect=fetch_side_effect)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            result = await svc.archive_old_rows("org_1", dry_run=True)
        assert result["traces_archived"] == 2
        assert result["rows_archived"] == 8
        # No INSERT / DELETE in dry-run
        assert not client.execute.called

    @pytest.mark.asyncio
    async def test_archive_one_trace_writes_impossible_cloud_and_deletes(self):
        svc = ArchiveService()
        client = MagicMock()
        # First call: per-trace SELECT (returns 3 rows).
        client.fetch = AsyncMock(
            side_effect=[
                [
                    {
                        "event_id": "evt_1",
                        "tenant_id": "org_1",
                        "trace_id": "trace_x",
                        "timestamp": datetime.now(UTC),
                        "payload": '{"x":1}',
                    },
                    {
                        "event_id": "evt_2",
                        "tenant_id": "org_1",
                        "trace_id": "trace_x",
                        "timestamp": datetime.now(UTC),
                        "payload": '{"x":2}',
                    },
                    {
                        "event_id": "evt_3",
                        "tenant_id": "org_1",
                        "trace_id": "trace_x",
                        "timestamp": datetime.now(UTC),
                        "payload": '{"x":3}',
                    },
                ],
                # Second fetch: _fetch_trace_messages. The prompt/completion
                # bodies live in trace_messages, not telemetry_events, so
                # _archive_one_trace now pulls them into the same blob —
                # archiving events alone and then deleting the messages
                # produced a structurally body-less archive. Empty here: this
                # test asserts the events path.
                [],
            ]
        )
        client.execute = AsyncMock()
        client.transaction = MagicMock()
        client.transaction.return_value.__aenter__ = AsyncMock(
            return_value=None
        )
        client.transaction.return_value.__aexit__ = AsyncMock(
            return_value=None
        )
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            svc._write_impossible_cloud = AsyncMock()
            n = await svc._archive_one_trace(
                client, "org_1", "trace_x", dry_run=False
            )
        assert n == 3
        svc._write_impossible_cloud.assert_called_once()
        # The path includes org + trace_id.
        write_kwargs = svc._write_impossible_cloud.call_args.args
        assert "cold/telemetry_events/org=org_1/trace=trace_x/" in write_kwargs[0]
        # Transaction-wrapped: 1 INSERT (index) + 1 DELETE (rows) = 2.
        #
        # The dedup cleanup is no longer a third client.execute: it goes
        # through the message store, and it is now guarded by
        # ``if message_rows``. Deleting a trace's messages without having
        # archived them destroyed the prompt/completion text
        # irrecoverably, because the archive blob held events only. This
        # trace has no messages, so nothing is deleted.
        assert client.execute.await_count == 2

    @pytest.mark.asyncio
    async def test_messages_are_archived_and_only_then_deleted(self):
        """The dedup delete must be gated on the messages having been
        written into the blob — that ordering is the whole point."""
        svc = ArchiveService()
        client = MagicMock()
        client.fetch = AsyncMock(
            side_effect=[
                [{"event_id": "evt_1", "tenant_id": "org_1",
                  "trace_id": "trace_x", "timestamp": datetime.now(UTC),
                  "payload": '{"x":1}'}],
                [{"trace_id": "trace_x", "msg_hash": "h1", "body": "hello"}],
            ]
        )
        client.execute = AsyncMock()
        client.transaction = MagicMock()
        client.transaction.return_value.__aenter__ = AsyncMock(return_value=None)
        client.transaction.return_value.__aexit__ = AsyncMock(return_value=None)

        store = MagicMock()
        store.delete_trace = AsyncMock()
        with (
            patch(
                "eden.storage.postgres.get_postgres_client",
                new=AsyncMock(return_value=client),
            ),
            patch(
                "eden.observability.message_store.get_message_store",
                return_value=store,
            ),
        ):
            svc._write_impossible_cloud = AsyncMock()
            await svc._archive_one_trace(client, "org_1", "trace_x", dry_run=False)

        body = svc._write_impossible_cloud.call_args.args[1]
        assert '"__kind": "trace_message"' in body, (
            "the message body must be in the archive blob before it is deleted"
        )
        assert '"__kind": "telemetry_event"' in body
        store.delete_trace.assert_awaited_once_with("trace_x")


# ── ArchiveService.lookup + rehydrate ──────────────────────────────────


class TestArchiveLookup:
    @pytest.mark.asyncio
    async def test_lookup_returns_none_when_no_postgres(self):
        svc = ArchiveService()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            result = await svc.lookup("trace_x")
        assert result is None

    @pytest.mark.asyncio
    async def test_lookup_returns_row_when_found(self):
        svc = ArchiveService()
        client = MagicMock()
        client.fetchrow = AsyncMock(
            return_value={
                "trace_id": "trace_x",
                "org_id": "org_1",
                "archive_path": "cold/telemetry_events/org=org_1/trace=trace_x/x.ndjson",
                "row_count": 5,
                "archived_at": datetime.now(UTC),
            }
        )
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            result = await svc.lookup("trace_x")
        assert result is not None
        assert result["trace_id"] == "trace_x"
        assert result["row_count"] == 5

    @pytest.mark.asyncio
    async def test_rehydrate_returns_empty_when_not_archived(self):
        svc = ArchiveService()
        # lookup returns None → rehydrate returns []
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            rows = await svc.rehydrate("trace_unknown")
        assert rows == []


class TestArchiveRehydrateCache:
    @pytest.mark.asyncio
    async def test_rehydrate_returns_empty_on_cache_miss_without_postgres(self):
        """When the cache is empty and Postgres is unavailable, rehydrate
        returns [] without raising (the lookup path returns None)."""
        svc = ArchiveService()
        # The read-through cache was an ``lru_cache`` (``_rehydrate_cache``
        # with ``.cache_clear()``); it is now a bounded OrderedDict LRU
        # behind ``_rehydrate_cache_{get,put,clear}``.
        from eden.services.data_platform.archive import _rehydrate_cache_clear

        _rehydrate_cache_clear()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            rows = await svc.rehydrate("trace_unknown")
        assert rows == []
        _rehydrate_cache_clear()


# ── Retention cron wires ArchiveService ───────────────────────────────


class TestRetentionCronArchive:
    @pytest.mark.asyncio
    async def test_cron_calls_archive_old_rows(self):
        from eden.data_platform import retention_cron

        # Mock ArchiveService and the orgs-with-old-traces list.
        mock_archive = MagicMock()
        mock_archive.archive_old_rows = AsyncMock(
            return_value={"traces_archived": 0, "rows_archived": 0, "s3_objects": 0}
        )
        mock_retention = MagicMock()
        mock_retention.policies = []
        mock_retention.run_retention_policy = AsyncMock(
            return_value=MagicMock(errors=[])
        )
        mock_lifecycle = MagicMock()
        mock_lifecycle.apply_s3_lifecycle_rules = AsyncMock(return_value=True)
        mock_lifecycle.expire_temporary_data = AsyncMock(return_value=0)

        with (
            patch(
                "eden.data_platform.retention_cron.ArchiveService",
                return_value=mock_archive,
            ),
            patch(
                "eden.data_platform.retention_cron.DataRetentionManager",
                return_value=mock_retention,
            ),
            patch(
                "eden.data_platform.retention_cron.StorageLifecycleManager",
                return_value=mock_lifecycle,
            ),
            patch(
                "eden.data_platform.retention_cron._list_orgs_with_old_traces",
                new=AsyncMock(return_value=["org_1"]),
            ),
            patch(
                "eden.data_platform.retention_cron._load_org_warm_days",
                new=AsyncMock(return_value={}),
            ),
        ):
            results = await retention_cron.run(dry_run=True)

        assert "cold_archive" in results
        assert "org_1" in results["cold_archive"]
        mock_archive.archive_old_rows.assert_awaited_once()
        call_kwargs = mock_archive.archive_old_rows.await_args
        assert call_kwargs.args[0] == "org_1"
        assert call_kwargs.kwargs.get("dry_run") is True
        assert call_kwargs.kwargs.get("before_date") is not None


# ── TelemetryCollector._load_from_archive fallback ────────────────────


class TestTraceTreeArchiveFallback:
    @pytest.mark.asyncio
    async def test_load_from_archive_returns_list(self):
        from eden.observability.telemetry_collector import TelemetryCollector

        collector = TelemetryCollector()

        with patch(
            "eden.services.data_platform.ArchiveService.rehydrate",
            new=AsyncMock(
                return_value=[{"event_id": "evt_cold", "trace_id": "trace_cold"}]
            ),
        ):
            rows = await collector._load_from_archive("org_1", "trace_cold")
        assert len(rows) == 1
        assert rows[0]["event_id"] == "evt_cold"

    @pytest.mark.asyncio
    async def test_load_from_archive_handles_failure(self):
        """A rehydrate failure must not raise — return [] so the
        caller (get_trace_tree) renders a clean 404."""
        from eden.observability.telemetry_collector import TelemetryCollector

        collector = TelemetryCollector()
        with patch(
            "eden.services.data_platform.ArchiveService.rehydrate",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ):
            rows = await collector._load_from_archive("org_1", "trace_x")
        assert rows == []


# ── Wave 1: mixed-age trace ───────────────────────────────────────────


class TestMixedAgeTraceCandidateSql:
    """Archive eligibility must require MAX(timestamp) < before_date.

    A trace whose last event is recent must not be archived even if some
    of its earlier events are older than the warm window.
    """

    def test_candidate_sql_uses_having_max_timestamp(self):
        source = inspect.getsource(ArchiveService.archive_old_rows)
        assert "HAVING MAX(timestamp) < $2" in source, (
            "Candidate SQL must filter with HAVING MAX(timestamp) < $2 "
            "to prevent premature archiving of long-lived traces"
        )

    def test_candidate_sql_does_not_filter_timestamp_in_where(self):
        """WHERE must not contain timestamp < $2 — only HAVING should."""
        source = inspect.getsource(ArchiveService.archive_old_rows)
        # Extract only the SQL string (between the triple-quoted strings)
        # We assert the WHERE clause does not directly filter timestamp.
        where_block = source.split("WHERE tenant_id = $1")[1].split("GROUP BY")[0]
        assert "timestamp < $2" not in where_block, (
            "WHERE clause must not filter timestamp; use HAVING MAX(timestamp) < $2"
        )

    @pytest.mark.asyncio
    async def test_mixed_age_trace_excluded_from_candidates(self):
        """A trace with a recent event must not appear as a candidate."""
        svc = ArchiveService()
        client = MagicMock()
        # The candidate query (with HAVING) returns empty because the
        # single trace has a recent event; simulate this.
        client.fetch = AsyncMock(return_value=[])
        before_date = datetime.now(UTC) - timedelta(days=90)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            result = await svc.archive_old_rows("org_1", before_date=before_date)
        assert result["traces_archived"] == 0
        # Verify the SQL sent contains HAVING not WHERE timestamp
        call_args = client.fetch.call_args
        sql = call_args.args[0]
        assert "HAVING MAX(timestamp)" in sql
        assert "WHERE tenant_id" in sql
        # timestamp filter must be in HAVING, not bare WHERE
        where_part = sql.split("GROUP BY")[0]
        assert "timestamp < $2" not in where_part


# ── Wave 1: per-org warm scan isolation ──────────────────────────────


class TestPerOrgWarmScanIsolation:
    """_list_orgs_with_old_traces must not miss default-policy orgs."""

    @pytest.mark.asyncio
    async def test_default_policy_orgs_included_when_override_is_longer(self):
        """When an override is 120 days (> default 90), the scan cutoff
        must still use DEFAULT_COLD_AGE_DAYS so 90-day-old data is found."""
        from eden.data_platform import retention_cron
        from eden.services.data_platform.archive import DEFAULT_COLD_AGE_DAYS

        archive_svc = ArchiveService()
        # org_A has an override of 120 days — longer than the default.
        org_warm_days = {"org_A": 120}

        mock_fetch = AsyncMock(return_value=[{"tenant_id": "org_default"}])

        with (
            patch(
                "eden.storage.postgres.get_postgres_client",
                new=AsyncMock(return_value=MagicMock()),
            ),
            patch(
                "eden.storage.watermark.fetch_stale_candidates",
                new=mock_fetch,
            ),
        ):
            orgs = await retention_cron._list_orgs_with_old_traces(
                archive_svc, org_warm_days
            )

        assert orgs == ["org_default"]
        call_kwargs = mock_fetch.await_args.kwargs
        candidate_table = call_kwargs["candidate_table"]
        assert f"INTERVAL '{DEFAULT_COLD_AGE_DAYS} days'" in candidate_table, (
            f"Expected scan to use DEFAULT_COLD_AGE_DAYS ({DEFAULT_COLD_AGE_DAYS}), "
            f"not the longer override (120). candidate_table: {candidate_table}"
        )
        assert call_kwargs["watermark_table"] == "retention_archive_watermark"
        assert call_kwargs["watermark_id_column"] == "tenant_id"
        assert call_kwargs["limit"] == retention_cron._RETENTION_ARCHIVE_BATCH_SIZE

    @pytest.mark.asyncio
    async def test_shorter_override_sets_scan_cutoff(self):
        """When an org override is shorter than default (30 < 90), the
        scan should use 30 so that org is not missed."""
        from eden.data_platform import retention_cron

        archive_svc = ArchiveService()
        org_warm_days = {"org_B": 30}

        mock_fetch = AsyncMock(return_value=[])

        with (
            patch(
                "eden.storage.postgres.get_postgres_client",
                new=AsyncMock(return_value=MagicMock()),
            ),
            patch(
                "eden.storage.watermark.fetch_stale_candidates",
                new=mock_fetch,
            ),
        ):
            await retention_cron._list_orgs_with_old_traces(
                archive_svc, org_warm_days
            )

        candidate_table = mock_fetch.await_args.kwargs["candidate_table"]
        assert "INTERVAL '30 days'" in candidate_table


# ── Wave 1: purge index-guard ─────────────────────────────────────────


class TestPurgeIndexGuard:
    """purge_archived_telemetry must only delete rows with an archive index entry
    and must respect the per-org filter when org_id is provided."""

    @pytest.mark.asyncio
    async def test_purge_dry_run_counts_only_archived_rows(self):
        from eden.data_platform.retention import DataRetentionManager

        mgr = DataRetentionManager(dry_run=True)
        client = MagicMock()
        client.fetchval = AsyncMock(return_value=5)
        mgr._postgres_client = client

        before_date = datetime.now(UTC) - timedelta(days=90)
        count = await mgr.purge_archived_telemetry(before_date)

        assert count == 5
        call_sql = client.fetchval.call_args.args[0]
        # Must join against trace_archive_index (the index-guard)
        assert "trace_archive_index" in call_sql

    @pytest.mark.asyncio
    async def test_purge_with_org_id_filters_tenant(self):
        """When org_id is supplied the DELETE must be scoped to that tenant."""
        from eden.data_platform.retention import DataRetentionManager

        mgr = DataRetentionManager(dry_run=False)
        client = MagicMock()
        client.execute = AsyncMock(return_value="DELETE 3")
        mgr._postgres_client = client

        before_date = datetime.now(UTC) - timedelta(days=90)
        count = await mgr.purge_archived_telemetry(before_date, org_id="org_42")

        assert count == 3
        call_args = client.execute.call_args
        sql = call_args.args[0]
        params = call_args.args[1:]
        # SQL must contain a per-tenant filter
        assert "tenant_id = $2" in sql
        # org_id must be passed as the second positional param
        assert "org_42" in params

    @pytest.mark.asyncio
    async def test_purge_without_org_id_deletes_globally(self):
        """Without org_id the query must not add a tenant filter."""
        from eden.data_platform.retention import DataRetentionManager

        mgr = DataRetentionManager(dry_run=False)
        client = MagicMock()
        client.execute = AsyncMock(return_value="DELETE 7")
        mgr._postgres_client = client

        before_date = datetime.now(UTC) - timedelta(days=90)
        count = await mgr.purge_archived_telemetry(before_date)

        assert count == 7
        call_args = client.execute.call_args
        sql = call_args.args[0]
        assert "tenant_id = $2" not in sql

    @pytest.mark.asyncio
    async def test_purge_dry_run_with_org_id(self):
        from eden.data_platform.retention import DataRetentionManager

        mgr = DataRetentionManager(dry_run=True)
        client = MagicMock()
        client.fetchval = AsyncMock(return_value=2)
        mgr._postgres_client = client

        before_date = datetime.now(UTC) - timedelta(days=30)
        count = await mgr.purge_archived_telemetry(before_date, org_id="org_42")

        assert count == 2
        call_args = client.fetchval.call_args
        sql = call_args.args[0]
        params = call_args.args[1:]
        assert "tenant_id = $2" in sql
        assert "org_42" in params


class TestArchiveSqlUsesTenantId:
    """Regression: telemetry_events uses tenant_id, not org_id."""

    def test_candidate_query_uses_tenant_id(self):
        import inspect

        from eden.services.data_platform.archive import ArchiveService

        source = inspect.getsource(ArchiveService.archive_old_rows)
        assert "tenant_id = $1" in source
        assert "org_id = $1" not in source.split("trace_archive_index")[0]

    def test_archive_one_trace_uses_tenant_id(self):
        import inspect

        from eden.services.data_platform.archive import ArchiveService

        source = inspect.getsource(ArchiveService._archive_one_trace)
        assert "tenant_id = $1" in source
        assert "org_id" in source
