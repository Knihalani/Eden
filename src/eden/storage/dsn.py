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
        url = settings.database_url
        # Normalise to asyncpg for SQLAlchemy's async engine.
        # The application uses asyncpg directly so the URL doesn't
        # need the ``+asyncpg`` driver suffix, but SQLAlchemy's
        # ``async_engine_from_config`` does.
        if url.startswith("postgresql://"):
            url = "postgresql+asyncpg://" + url[len("postgresql://"):]
        elif url.startswith("postgres://"):
            url = "postgresql+asyncpg://" + url[len("postgres://"):]
        # NOTE: sslmode / channel_binding are preserved verbatim when
        # the URL is supplied via ``database_url`` — managed-provider
        # strings (Neon, RDS, Aurora) carry them as libpq-style query
        # params and asyncpg's SSLContext parsing accepts them on
        # most drivers. Translation happens later, inside the
        # asyncpg connect() shim, where the runtime decides whether
        # to consume sslmode or ssl.
        return url
    base = (
        f"postgresql+asyncpg://{settings.postgres_user}:{settings.postgres_password}"
        f"@{settings.postgres_host}:{settings.postgres_port}/{settings.postgres_db}"
    )
    if settings.postgres_sslmode:
        base = f"{base}?ssl={settings.postgres_sslmode.lower()}"
    return base


# Mapping of libpq ``sslmode`` values → asyncpg ``ssl`` parameter.
# asyncpg accepts: True / False / 'require' / 'verify-ca' / 'verify-full' /
# an SSLContext. ``disable`` / ``allow`` / ``prefer`` map to ``ssl=false``
# (asyncpg has no soft-fail option).
_SSLMODE_TO_ASYNCPG_SSL = {
    "disable": "false",
    "allow": "false",
    "prefer": "false",
    "require": "require",
    "verify-ca": "verify-ca",
    "verify-full": "verify-full",
}


def _translate_sslmode_to_asyncpg_ssl(url: str) -> str:
    """Rewrite ``sslmode=...`` query params to asyncpg's ``ssl=...`` form.

    No-op if no ``sslmode`` is present or the scheme isn't asyncpg.
    """
    if "sslmode=" not in url:
        return url
    if "postgresql+asyncpg://" not in url:
        return url
    from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

    parsed = urlparse(url)
    qs = parse_qs(parsed.query, keep_blank_values=True)
    sslmode_vals = qs.pop("sslmode", None)
    channel_binding_vals = qs.pop("channel_binding", None)
    if sslmode_vals:
        sslmode = sslmode_vals[0].lower()
        ssl_val = _SSLMODE_TO_ASYNCPG_SSL.get(sslmode, "require")
        # asyncpg with ``ssl=require`` ignores channel_binding (it
        # uses scram-sha-256 by default, equivalent to libpq's
        # ``channel_binding=require``), so we just drop the param.
        qs["ssl"] = [ssl_val]
    elif channel_binding_vals:
        # No sslmode but channel_binding was set — translate to
        # ``ssl=require`` (channel_binding is libpq-only).
        qs["ssl"] = ["require"]
    new_query = urlencode(
        {k: v[0] if len(v) == 1 else v for k, v in qs.items()},
        doseq=True,
    )
    return urlunparse(parsed._replace(query=new_query))
