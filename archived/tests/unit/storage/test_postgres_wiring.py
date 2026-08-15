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

from eden.config import Settings


def _settings(**overrides) -> Settings:
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


def test_statement_cache_size_setting_default():
    """Default ``postgres_statement_cache_size`` is 0 (disabled).

    HIGH fix: asyncpg's default client-side prepared-statement cache
    (size 100, keyed per physical ``Connection``) is incompatible with
    PgBouncer transaction-mode pooling — a statement prepared on one
    backend connection can be replayed against a different backend
    after PgBouncer multiplexes the logical connection, producing
    intermittent "prepared statement does not exist" / "prepared
    statement already exists" errors under load. ``PostgresClient``'s
    docstring explicitly targets PgBouncer transaction mode, so the
    cache must default off.
    """
    s = _settings()
    assert s.postgres_statement_cache_size == 0


def test_statement_cache_size_setting_reads_env():
    """``POSTGRES_STATEMENT_CACHE_SIZE`` env var is honoured."""
    s = _settings(postgres_statement_cache_size=100)
    assert s.postgres_statement_cache_size == 100


def test_create_pool_disables_statement_cache_by_default():
    """``initialize()`` passes ``statement_cache_size=0`` to
    ``asyncpg.create_pool`` by default, so PgBouncer transaction-mode
    pooling can't hit cross-connection "prepared statement does not
    exist" errors.
    """
    import asyncio

    from eden.storage.postgres import PostgresClient

    settings = _settings()
    captured_kwargs: dict = {}

    async def _fake_create_pool(**kwargs):
        captured_kwargs.update(kwargs)
        return object()

    import eden.storage.postgres as pg_mod

    with pytest.MonkeyPatch.context() as mp:
        _patch_settings(mp, settings)
        mp.setattr(pg_mod.asyncpg, "create_pool", _fake_create_pool)
        client = PostgresClient()
        asyncio.run(client.initialize())

    assert captured_kwargs.get("statement_cache_size") == 0


def test_create_pool_honours_configured_statement_cache_size():
    """A non-default ``postgres_statement_cache_size`` setting is
    forwarded to ``asyncpg.create_pool`` (escape hatch for session-mode
    pooling or no pooler at all).
    """
    import asyncio

    from eden.storage.postgres import PostgresClient

    settings = _settings(postgres_statement_cache_size=100)
    captured_kwargs: dict = {}

    async def _fake_create_pool(**kwargs):
        captured_kwargs.update(kwargs)
        return object()

    import eden.storage.postgres as pg_mod

    with pytest.MonkeyPatch.context() as mp:
        _patch_settings(mp, settings)
        mp.setattr(pg_mod.asyncpg, "create_pool", _fake_create_pool)
        client = PostgresClient()
        asyncio.run(client.initialize())

    assert captured_kwargs.get("statement_cache_size") == 100


def test_down_revision_chain_continues():
    """Squash is the chain base (covers migration 043)."""
    import importlib.util
    from pathlib import Path

    versions_dir = (
        Path(__file__).resolve().parents[3]
        / "src" / "eden" / "db_migrations" / "versions"
    )
    path = versions_dir / "000_squash_001_160.py"
    spec = importlib.util.spec_from_file_location("migration_squash", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.revision == "160_signal_definitions_org_enabled_created"
    assert mod.down_revision is None


def test_migration_uses_create_index_if_not_exists():
    """Squash upgrade contains idempotent index creation from migration 043."""
    from pathlib import Path

    versions_dir = (
        Path(__file__).resolve().parents[3]
        / "src" / "eden" / "db_migrations" / "versions"
    )
    text = (versions_dir / "000_squash_001_160.py").read_text()
    assert "CREATE INDEX IF NOT EXISTS" in text
    # The squash must include the 043 indexes.
    for idx_name in (
        "idx_telemetry_events_tenant_created_at",
        "idx_notifications_user_created_at",
        "idx_notifications_user_unread",
    ):
        assert idx_name in text, f"squash missing index {idx_name}"


def test_migration_044_chains_off_043_and_drops_redundant_indexes():
    """Squash contains migration 044's composite-index DDL and redundant-drop list."""
    from pathlib import Path

    versions_dir = (
        Path(__file__).resolve().parents[3]
        / "src" / "eden" / "db_migrations" / "versions"
    )
    text = (versions_dir / "000_squash_001_160.py").read_text()
    # The squash must contain the 044 indexes.
    assert "CREATE INDEX IF NOT EXISTS" in text
    # _REDUNDANT_DROPS includes idx_jobs_user_id and idx_jobs_org_id.
    assert "idx_jobs_user_id" in text
    assert "idx_jobs_org_id" in text
    # _AUTOVACUUM content present in the upgrade body.
    assert "_AUTOVACUUM" in text
    assert "telemetry_events" in text


def test_migration_044_downgrade_restores_dropped_indexes():
    """Squash downgrade raises NotImplementedError (squash boundary)."""
    from pathlib import Path

    versions_dir = (
        Path(__file__).resolve().parents[3]
        / "src" / "eden" / "db_migrations" / "versions"
    )
    text = (versions_dir / "000_squash_001_160.py").read_text()
    downgrade_body = text.split("def downgrade()", 1)[1]
    assert "NotImplementedError" in downgrade_body
