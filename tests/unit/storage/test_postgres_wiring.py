"""Tests for the Neon-cost-pool-wiring fixes from June 2026.

Two regressions were uncovered during the cost audit:

1. ``PostgresClient.__init__`` ignored ``settings.postgres_pool_size``
   and ``settings.postgres_min_pool_size`` — every pool was created
   with the hardcoded 5/20 defaults. The Northflank manifest sets
   ``POSTGRES_POOL_SIZE=10`` / ``POSTGRES_MIN_POOL_SIZE=2`` to fit
   the 512 MB API container; before the fix those env vars were
   silently discarded.

2. ``statement_timeout`` was hardcoded to 30000 ms. The
   ``POSTGRES_STATEMENT_TIMEOUT_MS`` env var was set in
   ``northflank.yml`` but never read.

These tests verify both wirings work without touching a real
Postgres (no asyncpg pool is actually created). They use
``Settings(...)`` directly instead of ``get_settings()`` because
``tests/conftest.py`` autouse-patches ``get_settings`` to a test
singleton.
"""
from __future__ import annotations

import pytest


def _settings(**overrides) -> "Settings":
    """Instantiate a fresh ``Settings`` with explicit overrides."""
    from eden.config import Settings

    return Settings(**overrides)


def _patch_settings(mp, settings) -> None:
    """Patch ``get_settings`` at every import site the module under
    test uses. ``conftest.patch_settings`` autouse-patches
    ``eden.config.get_settings``; ``eden.storage.postgres`` does
    ``from eden.config import get_settings`` so it sees a separate
    symbol bound at import time.
    """
    mp.setattr("eden.config.get_settings", lambda: settings, raising=False)
    mp.setattr("eden.storage.postgres.get_settings", lambda: settings, raising=False)


def test_pool_size_defaults_are_read_from_settings():
    """Default pool honours ``settings.postgres_pool_size``."""
    from eden.storage.postgres import PostgresClient

    settings = _settings(postgres_pool_size=10, postgres_min_pool_size=2)
    with pytest.MonkeyPatch.context() as mp:
        _patch_settings(mp, settings)
        client = PostgresClient()
    assert client.config.min_size == 2
    assert client.config.max_size == 10
    assert settings.postgres_pool_size == 10
    assert settings.postgres_min_pool_size == 2


def test_pool_size_explicit_overrides_settings():
    """Explicit kwargs beat settings — the previous escape hatch still works."""
    from eden.storage.postgres import PostgresClient

    settings = _settings(postgres_pool_size=10, postgres_min_pool_size=2)
    with pytest.MonkeyPatch.context() as mp:
        _patch_settings(mp, settings)
        client = PostgresClient(min_pool_size=7, max_pool_size=42)
    assert client.config.min_size == 7
    assert client.config.max_size == 42


def test_statement_timeout_setting_default():
    """Default ``statement_timeout`` is 30 s when no env override."""
    s = _settings()
    assert s.postgres_statement_timeout_ms == 30_000


def test_statement_timeout_setting_reads_env():
    """``POSTGRES_STATEMENT_TIMEOUT_MS`` env var is honoured."""
    s = _settings(postgres_statement_timeout_ms=12_000)
    assert s.postgres_statement_timeout_ms == 12_000


def test_init_callback_uses_configured_timeout():
    """The asyncpg pool's ``init`` callback applies both server-side caps.

    Captures the SQL executed by the init callback and verifies both
    ``statement_timeout`` and ``idle_in_transaction_session_timeout``
    are set from settings.
    """
    import asyncio

    from eden.storage.postgres import PostgresClient

    settings = _settings(
        postgres_statement_timeout_ms=7_500,
        postgres_idle_in_transaction_timeout_ms=15_000,
    )
    captured: list[str] = []

    class _FakeConn:
        async def execute(self, sql: str) -> None:
            captured.append(sql)

    async def _fake_create_pool(**kwargs):
        await kwargs["init"](_FakeConn())
        return object()

    import eden.storage.postgres as pg_mod

    with pytest.MonkeyPatch.context() as mp:
        _patch_settings(mp, settings)
        mp.setattr(pg_mod.asyncpg, "create_pool", _fake_create_pool)
        client = PostgresClient()
        asyncio.run(client.initialize())

    assert "SET statement_timeout = 7500" in captured
    assert "SET idle_in_transaction_session_timeout = 15000" in captured


def test_idle_in_transaction_default():
    """Default ``idle_in_transaction_session_timeout`` is 60 s."""
    s = _settings()
    assert s.postgres_idle_in_transaction_timeout_ms == 60_000


def test_idle_in_transaction_setting_reads_env():
    """``POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS`` env var is honoured."""
    s = _settings(postgres_idle_in_transaction_timeout_ms=15_000)
    assert s.postgres_idle_in_transaction_timeout_ms == 15_000


def test_down_revision_chain_continues():
    """Migration 043 chains correctly off 042."""
    import importlib

    m = importlib.import_module(
        "eden.db_migrations.versions.043_neon_cost_indexes"
    )
    assert m.revision == "043"
    assert m.down_revision == "042"


def test_migration_uses_create_index_if_not_exists():
    """Migration must be idempotent (CREATE INDEX IF NOT EXISTS)."""
    import importlib

    m = importlib.import_module(
        "eden.db_migrations.versions.043_neon_cost_indexes"
    )

    src = m.upgrade.__code__.co_consts
    assert any(
        isinstance(c, str) and "CREATE INDEX IF NOT EXISTS" in c
        for c in src
    )
    # The downgrade path drops the three indexes it creates.
    down_src = m.downgrade.__code__.co_consts
    for idx in (
        "idx_telemetry_events_tenant_created_at",
        "idx_notifications_user_created_at",
        "idx_notifications_user_unread",
    ):
        assert any(
            isinstance(c, str) and idx in c for c in down_src
        ), f"downgrade() must drop {idx}"


def test_migration_044_chains_off_043_and_drops_redundant_indexes():
    """Migration 044 chains off 043, creates the new composite indexes,
    drops the now-redundant single-column indexes, and tunes autovacuum.
    """
    import importlib

    m = importlib.import_module(
        "eden.db_migrations.versions.044_neon_cost_indexes_2"
    )
    assert m.revision == "044"
    assert m.down_revision == "043"

    # The composite-index column lists are interpolated at call time
    # via f-strings, so they don't appear in co_consts. Check the
    # module-level _INDEXES tuple directly — that's what the runtime
    # actually consumes.
    declared_indexes = {
        (table, columns): where
        for (table, columns, where, _comment) in m._INDEXES
    }
    assert ("jobs", "(user_id, created_at DESC)") in declared_indexes
    assert ("jobs", "(org_id, created_at DESC)") in declared_indexes
    assert ("jobs", "(status, created_at DESC)") in declared_indexes
    # And the partial-index WHERE clause is present for the worker-poll
    # entry.
    assert declared_indexes[("jobs", "(status, created_at DESC)")] == (
        "WHERE status IN ('pending', 'running')"
    )

    up_src = m.upgrade.__code__.co_consts
    assert any(
        isinstance(c, str) and "CREATE INDEX IF NOT EXISTS" in c
        for c in up_src
    ), "upgrade() must use CREATE INDEX IF NOT EXISTS"
    # _REDUNDANT_DROPS is the module-level tuple of (table, idx_name)
    # pairs the upgrade drops. Verify the two single-column jobs
    # indexes we want gone are in it.
    dropped = {idx for _tbl, idx in m._REDUNDANT_DROPS}
    assert {"idx_jobs_user_id", "idx_jobs_org_id"} <= dropped
    # Autovacuum tuning — table names interpolated at runtime, just
    # confirm the ALTER TABLE template literal exists.
    assert any(
        isinstance(c, str) and "ALTER TABLE " in c
        for c in up_src
    ), "upgrade() must use the ALTER TABLE template"

    # Autovacuum values are also runtime-interpolated; check the
    # module-level _AUTOVACUUM table directly.
    tuned_tables = {row[0] for row in m._AUTOVACUUM}
    assert {"telemetry_events", "judge_scores", "silver_events", "jobs"} <= (
        tuned_tables
    )
    # All tune values are below the Postgres defaults (0.2 / 0.1).
    for _tbl, vac, ana, _comment in m._AUTOVACUUM:
        assert vac < 0.2
        assert ana < 0.1


def test_migration_044_downgrade_restores_dropped_indexes():
    """Downgrade must recreate the dropped single-column indexes so a
    rollback leaves the schema in a state compatible with 043."""
    import importlib

    m = importlib.import_module(
        "eden.db_migrations.versions.044_neon_cost_indexes_2"
    )
    down_src = m.downgrade.__code__.co_consts
    # Both halves of the col mapping dict are interpolated into the
    # CREATE statement at call time; spot-check the column names + the
    # literal CREATE INDEX IF NOT EXISTS template.
    assert any(
        isinstance(c, str) and "CREATE INDEX IF NOT EXISTS" in c
        for c in down_src
    ), "downgrade() must restore dropped indexes"
    for col in ("user_id", "org_id"):
        assert any(
            isinstance(c, str) and col in c for c in down_src
        ), f"downgrade() must reference column {col}"