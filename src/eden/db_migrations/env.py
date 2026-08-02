"""Alembic migration environment.

Uses SQLAlchemy's sync engine to run migrations against PostgreSQL.

Audit 2026-07-03 — switched from asyncpg (via async_engine_from_config)
to psycopg2 (sync) because asyncpg's prepared-statement mode raises
``unrecognized node type: 0`` on parameterless ``WHERE <bool expr>``
clauses in ``CREATE INDEX`` statements (e.g. ``WHERE model IS NOT
NULL``, ``WHERE NOT cached``). The error is reproducible: any
parameterless CREATE INDEX WHERE that's not a simple comparison
crashes asyncpg. Migrations are DDL and don't benefit from async;
the runtime app still uses asyncpg via the PostgresClient.
"""

import os
import sys
from logging.config import fileConfig
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from alembic import context
from alembic.config import Config
from sqlalchemy import pool
from sqlalchemy.engine import Connection, create_engine

# Put ``src`` on sys.path — not the project root. The root has no ``eden``
# package, so the name would fall through to the editable install, whose
# ``.pth`` lists ``sdk/python`` (the SDK) before ``src``.
sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
)

from eden.config import get_settings  # noqa: E402
from eden.db_migrations.version_table import (  # noqa: E402
    ensure_version_table,
    use_wide_version_table,
)

# Override alembic's stock varchar(32) version_num so fresh databases can
# record descriptive revision ids (the longest on disk is 37 chars).
use_wide_version_table()

settings = get_settings()

# Build the DSN from Settings, then strip asyncpg + libpq-only kwargs
# so SQLAlchemy's sync psycopg2 driver can use it. The async-specific
# DSN form would either be rejected by psycopg2 (sslmode kwarg) or
# silently change SSL semantics. We keep the same credentials and SSL
# posture; only the driver suffix and SSL kwarg shape change.
from eden.storage.dsn import build_dsn  # noqa: E402

_async_url = build_dsn(settings)
# Strip +asyncpg suffix (psycopg2 understands postgresql://).
_sync_url = _async_url.replace("+asyncpg", "", 1) if "+asyncpg" in _async_url else _async_url
# Translate asyncpg's ``ssl=...`` query param (e.g. ``ssl=require``) to
# libpq's ``sslmode=...`` so psycopg2 can parse the DSN. asyncpg used
# ``ssl=`` because that's what its connect() accepts; psycopg2 / libpq
# want ``sslmode=``. Async values are: True / False / 'require' /
# 'verify-ca' / 'verify-full'.
_parsed = urlparse(_sync_url)
_qs = parse_qs(_parsed.query, keep_blank_values=True)
_ssl_vals = _qs.pop("ssl", None)
if _ssl_vals:
    _ssl = _ssl_vals[0].lower()
    if _ssl in {"true", "1"}:
        _sslmode = "require"
    elif _ssl in {"false", "0"}:
        _sslmode = "disable"
    else:
        # Already a libpq-style value (require / verify-ca / verify-full).
        _sslmode = _ssl
    _qs["sslmode"] = [_sslmode]
    # Drop channel_binding too — libpq accepts it but we don't need
    # to forward what the operator didn't ask for.
    _qs.pop("channel_binding", None)
    _new_query = urlencode(
        {k: v[0] if len(v) == 1 else v for k, v in _qs.items()},
        doseq=True,
    )
    _sync_url = urlunparse(_parsed._replace(query=_new_query))
url = _sync_url

# Alembic Config object — prefer the CLI-provided config when running via
# ``alembic`` commands, otherwise build one from the project ini so that
# importing this module from application code (e.g. app startup) is safe.
_alembic_cfg = getattr(context, "config", None)
if _alembic_cfg is not None:
    config: Config = _alembic_cfg
else:
    # Not running under Alembic CLI — construct from known project path
    ini_path = getattr(
        settings,
        "alembic_ini",
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "alembic.ini"),
    )
    config = Config(ini_path)

# Interpret the config file for Python logging only when it exists.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", url)

# Target metadata (we use raw SQL migrations, so this is None)
target_metadata = None


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL and not an Engine.
    Calls to context.execute() emit the given string to the script output.
    """
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    """Execute migrations within a transaction.

    ``ensure_version_table`` must run and commit *before*
    ``context.configure``: under SQLAlchemy 2.0 the widening SELECT
    opens an implicit transaction that alembic will not commit if it
    treats it as externally managed, silently rolling back every
    migration on connection close while still exiting 0.
    """
    ensure_version_table(connection)
    connection.commit()
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode with sync psycopg2 engine.

    The sync driver is intentional — see the module docstring. Migrations
    are a one-shot CLI operation; the connection-pool setup cost of the
    async driver is wasted work for DDL.
    """
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = url

    connectable = create_engine(
        url,
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        do_run_migrations(connection)

    connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
