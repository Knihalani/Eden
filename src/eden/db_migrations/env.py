"""Alembic migration environment.

Uses SQLAlchemy's async engine to run migrations against PostgreSQL.
"""

import asyncio
import os
import sys
from logging.config import fileConfig

from alembic import context
from alembic.config import Config
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

# Add project root to path so we can import Settings
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))

from eden.config import get_settings  # noqa: E402

settings = get_settings()

# Build asyncpg URL from settings
url = (
    f"postgresql+asyncpg://{settings.postgres_user}:{settings.postgres_password}"
    f"@{settings.postgres_host}:{settings.postgres_port}/{settings.postgres_db}"
)

# Alembic Config object — prefer the CLI-provided config when running via
# ``alembic`` commands, otherwise build one from the project ini so that
# importing this module from application code (e.g. app startup) is safe.
_alembic_cfg = getattr(context, "config", None)
if _alembic_cfg is not None:
    config: Config = _alembic_cfg
else:
    # Not running under Alembic CLI — construct from known project path
    ini_path = getattr(settings, "alembic_ini", os.path.join(os.path.dirname(__file__), "..", "..", "..", "alembic.ini"))
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
    """Execute migrations within a transaction."""
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Run migrations in 'online' mode with async engine."""
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = url

    connectable = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Entry point for online migrations."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
