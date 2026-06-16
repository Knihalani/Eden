"""DSN builder for the Postgres connection.

Extracted from ``db_migrations/env.py`` so it can be unit-tested without
triggering the alembic runtime. The same builder is used by:

- ``db_migrations/env.py`` (alembic CLI path)
- ``storage/postgres.py`` (runtime path — uses the DSN components
  individually rather than parsing a DSN, but reads the same Settings)
- Application startup that needs to verify the connection before the
  pool comes up

Behaviour
---------
1. If ``settings.database_url`` is set, use it verbatim. The full-URL
   override field is the recommended path for managed providers (Neon,
   RDS, Aurora) where the connection string includes a pgbouncer-style
   pooler, an endpoint id, or non-standard SSL.
2. Otherwise, build the DSN from the individual ``POSTGRES_*`` vars.
   Append ``?sslmode=<mode>`` and ``&channel_binding=<mode>`` when
   those Settings are non-empty. ``asyncpg`` parses the DSN query
   string for SSL kwargs and applies them per-connection.
"""
from __future__ import annotations

from eden.config import Settings


def build_dsn(settings: Settings | None = None) -> str:
    """Return the asyncpg DSN for the configured Postgres connection.

    ``settings`` is injected for unit-testability; defaults to the
    cached ``get_settings()`` instance.
    """
    if settings is None:
        from eden.config import get_settings

        settings = get_settings()
    if settings.database_url:
        return settings.database_url
    base = (
        f"postgresql+asyncpg://{settings.postgres_user}:{settings.postgres_password}"
        f"@{settings.postgres_host}:{settings.postgres_port}/{settings.postgres_db}"
    )
    query_parts: list[str] = []
    if settings.postgres_sslmode:
        query_parts.append(f"sslmode={settings.postgres_sslmode}")
    if settings.postgres_channel_binding:
        query_parts.append(f"channel_binding={settings.postgres_channel_binding}")
    if query_parts:
        base = f"{base}?{'&'.join(query_parts)}"
    return base
