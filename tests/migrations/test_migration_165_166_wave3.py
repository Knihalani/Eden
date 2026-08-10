"""Wave 3 P3.3/P3.4 — static verification of migrations 165 and 166.

No live Postgres is available in this env, so these tests statically
verify the chain linkage and the SQL shape — the same pattern as
``test_migration_156_agent_link_columns_index.py``:

* **165** drops only the two proven-dead tables (``test_y``,
  ``test_part_full_renamed``) and never touches ``app_events``,
  ``clickhouse_fallback`` or ``jobs`` (all live — verified by grep +
  live row probe 2026-08-10).
* **166** tunes ``telemetry_events``: 7-day chunks, 90-day retention,
  compression guarded by the same ``feature_not_supported`` block
  migration 034 uses (apache-build no-op).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2] / "src" / "eden" / "db_migrations" / "versions"
)


def _load_migration(name: str) -> Any:
    path = MIGRATIONS_DIR / f"{name}.py"
    if not path.exists():
        pytest.fail(f"migration not found: {path}")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _sql_of(mod: Any) -> str:
    """Return the concatenated SQL executed by ``upgrade()``."""
    import contextlib
    import io

    out = io.StringIO()
    calls: list[str] = []

    class _Op:
        @staticmethod
        def execute(sql: str) -> None:
            calls.append(str(sql))

    with contextlib.redirect_stdout(out):
        mod.upgrade.__globals__["op"] = _Op()  # type: ignore[attr-defined]
        mod.upgrade()
    return "\n".join(calls)


class Test165DropDeadTestTables:
    def test_chain_links_from_164(self) -> None:
        mod = _load_migration("165_drop_dead_test_tables")
        assert mod.down_revision == "164_vector_documents"

    def test_drops_only_the_two_proven_dead_tables(self) -> None:
        mod = _load_migration("165_drop_dead_test_tables")
        sql = _sql_of(mod)
        assert "DROP TABLE IF EXISTS test_y" in sql
        assert "DROP TABLE IF EXISTS test_part_full_renamed" in sql
        # Live tables from the same P3.3 list must NOT be touched.
        for live in ("app_events", "clickhouse_fallback", "jobs"):
            assert live not in sql

    def test_downgrade_recreates_empty_shells(self) -> None:
        mod = _load_migration("165_drop_dead_test_tables")
        import contextlib
        import io

        out = io.StringIO()
        calls: list[str] = []

        class _Op:
            @staticmethod
            def execute(sql: str) -> None:
                calls.append(str(sql))

        with contextlib.redirect_stdout(out):
            mod.downgrade.__globals__["op"] = _Op()  # type: ignore[attr-defined]
            mod.downgrade()
        joined = "\n".join(calls)
        assert "CREATE TABLE IF NOT EXISTS test_y" in joined
        assert "CREATE TABLE IF NOT EXISTS test_part_full_renamed" in joined


class Test166TelemetryChunkRetention:
    def test_chain_links_from_165(self) -> None:
        mod = _load_migration("166_telemetry_chunk_retention")
        assert mod.down_revision == "165_drop_dead_test_tables"

    def test_widens_chunk_interval_to_seven_days(self) -> None:
        mod = _load_migration("166_telemetry_chunk_retention")
        sql = _sql_of(mod)
        assert "set_chunk_time_interval('telemetry_events', INTERVAL '7 days')" in sql

    def test_adds_ninety_day_retention_policy(self) -> None:
        mod = _load_migration("166_telemetry_chunk_retention")
        sql = _sql_of(mod)
        assert "add_retention_policy" in sql
        assert "INTERVAL '90 days'" in sql
        assert "if_not_exists => TRUE" in sql

    def test_retention_guarded_for_apache_build(self) -> None:
        """add_retention_policy is ALSO license-gated on the Neon apache
        OSS build (verified live 2026-08-10: FeatureNotSupported) — the
        migration must swallow it, not hard-fail."""
        mod = _load_migration("166_telemetry_chunk_retention")
        sql = _sql_of(mod)
        # Both the retention block and the compression block must be
        # inside feature_not_supported-guarded DO blocks.
        assert sql.count("feature_not_supported") >= 2

    def test_compression_guarded_for_apache_build(self) -> None:
        """The columnstore block must swallow feature_not_supported, not
        hard-fail the migration on the Neon apache OSS build."""
        mod = _load_migration("166_telemetry_chunk_retention")
        sql = _sql_of(mod)
        assert "timescaledb.compress" in sql
        assert "feature_not_supported" in sql

    def test_downgrade_removes_policies_only(self) -> None:
        """Downgrade must never drop telemetry_events or its data."""
        mod = _load_migration("166_telemetry_chunk_retention")
        import contextlib
        import io

        out = io.StringIO()
        calls: list[str] = []

        class _Op:
            @staticmethod
            def execute(sql: str) -> None:
                calls.append(str(sql))

        with contextlib.redirect_stdout(out):
            mod.downgrade.__globals__["op"] = _Op()  # type: ignore[attr-defined]
            mod.downgrade()
        joined = "\n".join(calls)
        assert "remove_retention_policy" in joined
        assert "remove_compression_policy" in joined
        assert "DROP TABLE" not in joined
