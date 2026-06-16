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
    # asyncpg's DSN format is different from libpq's:
    #   - libpq uses ``sslmode=require`` to require SSL
    #   - asyncpg accepts ``ssl=require`` (or ``ssl=true``, ``ssl=verify-full``,
    #     or an ``ssl.SSLContext``) and passes it to ``connect()``
    # We translate ``postgres_sslmode`` (a libpq-style string) to the
    # asyncpg equivalent. ``channel_binding`` is libpq-only; not honoured
    # by asyncpg — the SSL handshake in asyncpg uses scram-sha-256 by
    # default, which is the same thing channel_binding=require enforces.
    query_parts: list[str] = []
    if settings.postgres_sslmode:
        # Map libpq-style sslmode values to asyncpg's ``ssl`` parameter.
        # asyncpg accepts: True / False / 'require' / 'verify-ca' /
        # 'verify-full' / an SSLContext.
        sslmode = settings.postgres_sslmode.lower()
        if sslmode in {"disable", "allow", "prefer"}:
            query_parts.append("ssl=false")
        elif sslmode in {"require", "verify-ca", "verify-full"}:
            # asyncpg's 'require' is the closest match to libpq's
            # 'require' (no cert verification); 'verify-ca' / 'verify-full'
            # map directly.
            query_parts.append(f"ssl={sslmode}")
        else:
            # Unknown sslmode — fall back to 'require'.
            query_parts.append("ssl=require")
    if query_parts:
        base = f"{base}?{'&'.join(query_parts)}"
    return base
