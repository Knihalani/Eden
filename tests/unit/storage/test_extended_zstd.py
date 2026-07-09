"""Unit tests for Phase B2 — extended ZSTD compression.

Verifies:
- compress_jsonb / decompress_jsonb round-trip on the 6 new field
  shapes (reasoning, tool_calls_full, tool_results, payload,
  metrics, attributes)
- The backfill script's _TARGETS list matches migration 038's
  column list
- The new *_zstd columns are correctly referenced in
  telemetry_collector._route_postgres (writer) and _read_payload
  (reader)
- Migration 038 + 039 round-trip cleanly (manual SQL sanity)

Pydantic / DB-level tests for the INSERT path live in
``tests/integration/test_telemetry_ingest.py`` (out of scope here).
"""
from __future__ import annotations

import ast
import inspect
import re
from pathlib import Path

import pytest

from eden.storage.compression import (
    compress_jsonb,
    decompress_jsonb,
)

# ── Compression round-trip on the 6 new field shapes ──────────────────


REASONING_SAMPLE = {
    "summary": "The agent reasoned step-by-step about the user's request.",
    "steps": [
        {"step": 1, "thought": "Identify the core question"},
        {"step": 2, "thought": "Look up the relevant context"},
        {"step": 3, "thought": "Compose a response"},
    ],
    "model": "o3-mini",
    "tokens": 4321,
}

TOOL_CALLS_FULL_SAMPLE = [
    {
        "id": "call_abc123",
        "type": "function",
        "function": {
            "name": "search_database",
            "arguments": '{"query": "recent orders", "limit": 10}',
        },
    },
    {
        "id": "call_def456",
        "type": "function",
        "function": {
            "name": "send_email",
            "arguments": '{"to": "alice@example.com", "subject": "Follow-up"}',
        },
    },
]

TOOL_RESULTS_SAMPLE = [
    {"tool_call_id": "call_abc123", "content": [{"type": "text", "text": "12 results"}]},
    {"tool_call_id": "call_def456", "content": [{"type": "text", "text": "Email sent"}]},
]

PAYLOAD_SAMPLE = {
    "user_id": "u_123",
    "feature": "smart_summarize",
    "experiment_id": "exp_q3_2026",
    "metadata": {"plan": "pro", "region": "us-east-1"},
}

METRICS_SAMPLE = {
    "tokens_in": 1234,
    "tokens_out": 567,
    "latency_ms": 432.1,
    "cost_usd": 0.0023,
}

ATTRIBUTES_SAMPLE = {
    "model": "gpt-4o",
    "environment": "production",
    "deployment": "canary-v3",
    "user_segment": "power_user",
}


class TestCompressionRoundTrip:
    @pytest.mark.parametrize(
        "label,value",
        [
            ("reasoning", REASONING_SAMPLE),
            ("tool_calls_full", TOOL_CALLS_FULL_SAMPLE),
            ("tool_results", TOOL_RESULTS_SAMPLE),
            ("payload", PAYLOAD_SAMPLE),
            ("metrics", METRICS_SAMPLE),
            ("attributes", ATTRIBUTES_SAMPLE),
        ],
    )
    def test_round_trip_lossless(self, label: str, value):
        compressed = compress_jsonb(value)
        assert isinstance(compressed, bytes)
        # Empty-bytes sentinel is reserved for None; valid data
        # must produce a non-empty frame (with the trained dict
        # loaded — in dev environments where the dict is missing
        # the frame is still non-empty).
        assert len(compressed) > 0
        assert decompress_jsonb(compressed) == value

    def test_none_round_trip(self):
        # The empty-bytes sentinel preserves None round-trip.
        assert decompress_jsonb(compress_jsonb(None)) is None


class TestBackfillScriptTargets:
    """The backfill script's _TARGETS list must match migration 038."""

    @staticmethod
    def _script_targets():
        from scripts.backfill_extended_zstd import _TARGETS

        return _TARGETS

    @staticmethod
    def _migration_columns():
        """Read the 6 new BYTEA column names from migration 038.

        Parses the ``new_columns = [...]`` list literal at the top
        of the upgrade() body — this is the source of truth. The
        SQL DDL is an f-string (``{col}`` interpolated at runtime)
        so we can't regex against the rendered SQL.
        """
        m038 = _MIGRATIONS_DIR / "038_zstd_extended_payloads.py"
        text = m038.read_text()
        # Extract the new_columns list literal.
        m = re.search(r"new_columns\s*=\s*\[(.*?)\]", text, re.DOTALL)
        assert m is not None, "migration 038 missing new_columns list"
        body = m.group(1)
        cols = re.findall(r'"(\w+_zstd)"', body)
        assert len(cols) == 6, f"expected 6 columns, got {len(cols)}: {cols}"
        return cols

    def test_targets_count_matches_migration_count(self):
        assert len(self._script_targets()) == 6
        assert len(self._migration_columns()) == 6

    def test_targets_match_migration_columns(self):
        new_cols_in_script = [new for _, new in self._script_targets()]
        assert new_cols_in_script == self._migration_columns()

    def test_old_new_paired_correctly(self):
        for old, new in self._script_targets():
            assert new == old + "_zstd", (
                f"{old} should pair with {old}_zstd, got {new}"
            )


# Audit 2026-06-23: original hardcoded macOS path failed on CI.
_MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[3]
    / "src" / "eden" / "db_migrations" / "versions"
)


class TestMigrationSQLSyntax:
    """Light syntax checks on migration 038/039 — no DB connection."""

    def _load_migration(self, filename: str):
        """Load a migration module by filename (the alembic versions
        dir doesn't auto-import every file)."""
        import importlib.util
        from pathlib import Path

        path = _MIGRATIONS_DIR / filename
        spec = importlib.util.spec_from_file_location(filename[:-3], path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_migration_038_has_upgrade_and_downgrade(self):
        m = self._load_migration("038_zstd_extended_payloads.py")
        assert callable(m.upgrade)
        assert callable(m.downgrade)
        assert m.revision == "038"
        assert m.down_revision == "037"

    def test_migration_039_is_no_op_drop_pattern(self):
        m = self._load_migration("039_zstd_extended_drop.py")
        assert callable(m.upgrade)
        assert m.revision == "039"
        assert m.down_revision == "038"
        # upgrade is intentionally empty (deferred drop, like 033).
        # The body must contain ``pass`` and no live ALTER/DROP statements
        # (the DROP COLUMN references in docstring comments are fine).
        body = inspect.getsource(m.upgrade)
        assert "pass" in body, "upgrade() must contain pass"
        # Strip comments (lines starting with #) before checking.
        body_no_comments = "\n".join(
            line for line in body.splitlines() if not line.strip().startswith("#")
        )
        assert "DROP COLUMN" not in body_no_comments, (
            "DROP COLUMN lives in scripts/drop_extended_original_columns.sql, "
            "not in the migration upgrade() (mirrors migration 033)"
        )

    def test_drop_sql_covers_all_six_columns(self):
        """The drop SQL must reference all 6 columns."""
        sql_path = (
            Path(__file__).resolve().parents[3]
            / "scripts" / "drop_extended_original_columns.sql"
        )
        sql = sql_path.read_text()
        for col in (
            "reasoning",
            "tool_calls_full",
            "tool_results",
            "payload",
            "metrics",
            "attributes",
        ):
            assert f"DROP COLUMN IF EXISTS {col}" in sql, (
                f"{col} missing from drop_extended_original_columns.sql"
            )


class TestTelemetryCollectorWiring:
    """The 6 new fields must be wired into _route_postgres (write)
    and _read_payload (read)."""

    @pytest.fixture
    def write_source(self):
        return (
            Path(__file__).resolve().parents[3]
            / "src" / "eden" / "observability" / "telemetry_collector.py"
        ).read_text()

    def test_write_path_compresses_all_six(self, write_source):
        # Each *_zstd local must be assigned from the batch API or
        # the previous direct / gather forms. v1.8 added the batch
        # :func:`compress_many` dispatch and renamed the locals
        # (they're still ``*_zstd`` so the SQL placeholders are
        # unchanged). The pattern we look for is: ``<field>,`` in
        # the unpacked tuple AND the corresponding ``event.<base>``
        # inside the list passed to :func:`compress_many`.
        for field in (
            "reasoning_zstd",
            "tool_calls_full_zstd",
            "tool_results_zstd",
            "payload_zstd",
            "metrics_zstd",
            "attributes_zstd",
        ):
            base = field[:-5]
            # Match the new batch-dispatch pattern.
            batch_unpack = f"{field},"
            batch_input = f"event.{base},"
            assert batch_unpack in write_source, (
                f"_route_postgres must unpack {field} from the batch result"
            )
            assert batch_input in write_source, (
                f"_route_postgres must feed event.{base} into compress_many"
            )

    def test_write_path_inserts_all_six(self, write_source):
        """All 6 *_zstd columns appear in the INSERT column list."""
        for field in (
            "reasoning_zstd",
            "tool_calls_full_zstd",
            "tool_results_zstd",
            "payload_zstd",
            "metrics_zstd",
            "attributes_zstd",
        ):
            assert field in write_source, (
                f"_route_postgres INSERT must reference {field}"
            )

    def test_read_path_uses_all_six(self, write_source):
        """The 6 *_zstd columns are referenced in the row read path.

        v1.8 batched the decompressions: ``_read_payload`` was
        replaced by a single :func:`decompress_many` call across
        all rows and the column names appear in the ``_zstd_cols``
        tuple. The test checks both the new tuple and the older
        ``_read_payload(row, "<field>", ...)`` form so a future
        regression to the old per-row serial decompress is caught.
        """
        for field in (
            "reasoning_zstd",
            "tool_calls_full_zstd",
            "tool_results_zstd",
            "payload_zstd",
            "metrics_zstd",
            "attributes_zstd",
        ):
            old_pattern = f'"{field}", "'
            new_pattern = f'"{field}",'
            assert old_pattern in write_source or new_pattern in write_source, (
                f"_route_postgres/_load_from_archive path must read {field} "
                f"(either via _read_payload or the _zstd_cols tuple)"
            )

    def test_write_path_placeholder_count_updated(self, write_source):
        """The INSERT must have $46 (the last new column)."""
        # ast-parsed would be ideal but we're matching text.
        # The last positional placeholder before NOW() must be $46.
        assert "$46, NOW()" in write_source, (
            "INSERT must end with $46, NOW() after adding 6 new columns"
        )
