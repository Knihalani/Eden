"""Unit tests for Phase B4 — content-addressed message dedup.

Verifies:
- Migration 041 creates trace_messages + 2 indexes (idempotent).
- MessageStore.gc_orphans removes rows whose trace has no rows
  in telemetry_events.
- ArchiveService._archive_one_trace cleans up trace_messages for
  the archived trace (Phase B4 integration).
- Retention cron wires the orphan GC.

The hashing + reconstruction paths in :mod:`eden.observability.message_store`
were already covered by existing tests in tests/unit/observability/.
This file focuses on the Phase B4 additions only.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── Migration 041 syntax ─────────────────────────────────────────────

# Audit 2026-06-23: the original path was a hardcoded absolute
# macOS path (``/Users/kaiavnihalani/Downloads/Eden/...``) that
# failed on the CI runner (Ubuntu) with FileNotFoundError.
# Resolve relative to this test file so the test runs anywhere.
_MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[3]
    / "src" / "eden" / "db_migrations" / "versions"
)


class TestMigration041Syntax:
    @staticmethod
    def _load_migration():
        path = _MIGRATIONS_DIR / "041_trace_messages.py"
        spec = importlib.util.spec_from_file_location("trace_messages", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_revision_chain(self):
        m = self._load_migration()
        assert m.revision == "041"
        assert m.down_revision == "040"

    def test_idempotent_create(self):
        """The upgrade must use IF NOT EXISTS so re-runs are safe
        on databases that already have the table from the legacy
        raw-SQL file."""
        m = self._load_migration()
        body = (_MIGRATIONS_DIR / "041_trace_messages.py").read_text()
        assert "CREATE TABLE IF NOT EXISTS trace_messages" in body

    def test_indexes_created(self):
        m = self._load_migration()
        body = (_MIGRATIONS_DIR / "041_trace_messages.py").read_text()
        assert "idx_trace_messages_trace_id" in body
        assert "idx_trace_messages_content_gin" in body

    def test_primary_key(self):
        body = (_MIGRATIONS_DIR / "041_trace_messages.py").read_text()
        # The PK is on (trace_id, msg_hash) — trace-scoped dedup.
        assert "PRIMARY KEY (trace_id, msg_hash)" in body


# ── MessageStore.gc_orphans ───────────────────────────────────────────


class TestMessageStoreGcOrphans:
    @pytest.mark.asyncio
    async def test_gc_returns_zero_when_no_postgres(self):
        from eden.observability.message_store import MessageStore

        store = MessageStore()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            n = await store.gc_orphans()
        assert n == 0

    @pytest.mark.asyncio
    async def test_gc_returns_zero_when_no_orphans(self):
        from eden.observability.message_store import MessageStore

        store = MessageStore()
        client = MagicMock()
        client.fetch = AsyncMock(return_value=[])  # no orphans
        client.execute = AsyncMock()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            n = await store.gc_orphans()
        assert n == 0
        assert client.execute.await_count == 0  # no DELETE issued

    @pytest.mark.asyncio
    async def test_gc_deletes_orphan_batches(self):
        from eden.observability.message_store import MessageStore

        store = MessageStore()
        client = MagicMock()
        # First fetch: 2 orphans. Second fetch: empty (loop exits).
        client.fetch = AsyncMock(side_effect=[
            [{"trace_id": "trace_orphan_1"}, {"trace_id": "trace_orphan_2"}],
            [],
        ])
        # The DELETE returns the asyncpg status string "DELETE n".
        client.execute = AsyncMock(return_value="DELETE 42")

        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            n = await store.gc_orphans(batch_size=500)
        assert n == 42
        client.execute.assert_awaited_once()
        # The ANY($1::text[]) param is positional (the second arg
        # to execute after the SQL string).
        args = client.execute.await_args.args
        assert args[1] == ["trace_orphan_1", "trace_orphan_2"]

    @pytest.mark.asyncio
    async def test_gc_handles_execute_failure(self):
        from eden.observability.message_store import MessageStore

        store = MessageStore()
        client = MagicMock()
        client.fetch = AsyncMock(side_effect=RuntimeError("boom"))
        client.execute = AsyncMock()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            # Failure must not raise — the GC is best-effort.
            n = await store.gc_orphans()
        assert n == 0


# ── ArchiveService drops messages on archive ─────────────────────────


class TestArchiveDropsDedupMessages:
    @pytest.mark.asyncio
    async def test_archive_one_trace_calls_delete_trace(self):
        from eden.services.data_platform.archive import ArchiveService

        svc = ArchiveService()
        client = MagicMock()
        client.fetch = AsyncMock(
            return_value=[
                {
                    "event_id": "evt_1",
                    "tenant_id": "org_1",
                    "trace_id": "trace_x",
                    "timestamp": "2026-06-19T12:00:00Z",
                    "payload": "{}",
                }
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
            with patch(
                "eden.observability.message_store.get_message_store"
            ) as mock_get_store:
                mock_store = MagicMock()
                mock_store.delete_trace = AsyncMock(return_value=1)
                mock_get_store.return_value = mock_store

                n = await svc._archive_one_trace(
                    client, "org_1", "trace_x", dry_run=False
                )
        assert n == 1
        mock_store.delete_trace.assert_awaited_once_with("trace_x")

    @pytest.mark.asyncio
    async def test_archive_survives_dedup_cleanup_failure(self):
        """A failed dedup cleanup must not abort the archive."""
        from eden.services.data_platform.archive import ArchiveService

        svc = ArchiveService()
        client = MagicMock()
        client.fetch = AsyncMock(
            return_value=[
                {
                    "event_id": "evt_1",
                    "tenant_id": "org_1",
                    "trace_id": "trace_x",
                    "timestamp": "2026-06-19T12:00:00Z",
                    "payload": "{}",
                }
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
            with patch(
                "eden.observability.message_store.get_message_store"
            ) as mock_get_store:
                mock_store = MagicMock()
                mock_store.delete_trace = AsyncMock(
                    side_effect=RuntimeError("boom")
                )
                mock_get_store.return_value = mock_store
                # Must not raise even though dedup cleanup fails.
                n = await svc._archive_one_trace(
                    client, "org_1", "trace_x", dry_run=False
                )
        assert n == 1


# ── Retention cron wires GC ───────────────────────────────────────────


class TestRetentionCronWiresGc:
    @pytest.mark.asyncio
    async def test_cron_calls_gc_orphans(self):
        from eden.data_platform import retention_cron

        mock_store = MagicMock()
        mock_store.gc_orphans = AsyncMock(return_value=42)
        mock_retention = MagicMock()
        mock_retention.policies = []
        mock_lifecycle = MagicMock()
        mock_lifecycle.apply_s3_lifecycle_rules = AsyncMock(return_value=True)
        mock_lifecycle.expire_temporary_data = AsyncMock(return_value=0)
        mock_archive = MagicMock()
        mock_archive.archive_old_rows = AsyncMock(
            return_value={"traces_archived": 0, "rows_archived": 0, "s3_objects": 0}
        )

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
                new=AsyncMock(return_value=[]),
            ),
            patch(
                "eden.observability.message_store.get_message_store",
                return_value=mock_store,
            ),
        ):
            results = await retention_cron.run(dry_run=False)

        assert results["trace_messages_gc"] == 42
        mock_store.gc_orphans.assert_awaited_once()
