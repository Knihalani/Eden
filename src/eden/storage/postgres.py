"""PostgreSQL storage client for Eden.

Provides connection pooling via PgBouncer and typed clients for each KB layer.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import logging
from collections.abc import AsyncIterator, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC
from typing import Any, cast

import asyncpg
from asyncpg import Connection, Pool
from asyncpg.transaction import Transaction

from eden.config import get_settings
from eden.util.jsonx import dumps as _jsonx_dumps

logger = logging.getLogger(__name__)

# Request-scoped asyncpg connection pinned by RLSOrgContextMiddleware.
# When set, PostgresClient.acquire/fetch/execute reuse this connection so
# FORCE RLS policies see ``app.current_org_id`` (SET LOCAL on that conn).
# Without this, pool round-trips hit a different connection with a NULL GUC
# and every telemetry_* / FORCE-RLS table returns empty — portal shows
# 0 agents / 0 traces even when rows exist.
_request_pg_conn: contextvars.ContextVar[Connection | None] = contextvars.ContextVar(
    "eden_request_pg_conn",
    default=None,
)


def bind_request_pg_conn(conn: Connection | None) -> contextvars.Token[Connection | None]:
    """Pin ``conn`` for the current asyncio task (middleware entry)."""
    return _request_pg_conn.set(conn)


def reset_request_pg_conn(token: contextvars.Token[Connection | None]) -> None:
    """Restore the previous request-conn binding (middleware exit)."""
    _request_pg_conn.reset(token)


def get_bound_request_pg_conn() -> Connection | None:
    """Return the middleware-pinned connection, if any."""
    return _request_pg_conn.get()


def copy_context_without_request_pg_conn() -> contextvars.Context:
    """Snapshot the current context with the request-pinned pg
    connection var forced back to its default (``None``).

    CRITICAL (cross-tenant connection reuse): ``asyncio.Task``/
    ``loop.create_task`` copy the *calling* ``contextvars.Context``
    at task-creation time. A detached background task created from
    inside an HTTP request (e.g. a fire-and-forget webhook delivery
    scheduled from a route handler) therefore inherits whatever
    connection ``RLSOrgContextMiddleware`` pinned via
    :func:`bind_request_pg_conn` for that request — even though the
    task may still be running long after the middleware's
    ``finally`` block has committed and released that connection
    back to the pool. ``PostgresClient.acquire`` checks
    ``_request_pg_conn`` FIRST (see below) and, if bound, hands back
    that exact connection object without going through the pool's
    checkout — which means the detached task can silently start
    running queries on a connection object that the pool has, by
    then, handed to a *different*, concurrently-tenanted request.

    Callers that spawn a task meant to outlive the request that
    created it should build the task's coroutine inside (or create
    the task via) the context returned here so the copied context
    carries no stale connection binding at all — the task will fall
    through to a normal pool checkout instead. Other context state
    (correlation IDs, etc.) is preserved unchanged.
    """
    ctx = contextvars.copy_context()
    # ``Context.run`` executes with ``ctx`` as the ambient context,
    # so the ``.set(None)`` call below mutates ``ctx`` itself (not a
    # further copy) — see the contextvars docs: "Any changes to any
    # context variables that callable makes will be contained in the
    # context object". Resetting to ``None`` is equivalent to
    # "unset" here because ``None`` is this var's declared default.
    ctx.run(_request_pg_conn.set, None)
    return ctx


def _dump_jsonb(value):
    """Compact JSON serialiser used by every JSONB column in this module.

    Returns ``None`` for ``None`` so the DB sees NULL. Uses
    ``eden.util.jsonx`` (orjson) on the hot path; ``default=str``
    matches the convention used by ``telemetry_collector._route_postgres``
    so the round-trip is identical.
    """
    if value is None:
        return None
    return _jsonx_dumps(value, default=str)
# Note: ``settings`` is intentionally NOT bound to a module-level
# reference — every method that needs a setting calls ``get_settings()``
# (lru_cache'd, so the cost is one dict lookup) so that tests can
# monkeypatch the env and immediately observe the new values, and so
# a future code path that mutates ``Settings`` (e.g. a CLI flag)
# works without re-importing this module.


@dataclass
class ConnectionConfig:
    host: str
    port: int
    database: str
    user: str
    password: str
    min_size: int
    max_size: int


class PostgresClient:
    """PostgreSQL client with connection pooling.

    Uses asyncpg for async database access.
    Designed to work behind PgBouncer in transaction mode.
    """

    def __init__(
        self,
        host: str | None = None,
        port: int | None = None,
        database: str | None = None,
        user: str | None = None,
        password: str | None = None,
        min_pool_size: int | None = None,
        max_pool_size: int | None = None,
        ssl: bool | str | None = None,
    ) -> None:
        # Resolve settings on every call (lru_cache'd, so the cost is
        # one dict lookup) — keeps monkeypatched env vars in tests
        # observable, and means a future caller can swap the config
        # without re-importing this module.
        s = get_settings()

        # Honour ``settings.database_url`` as the canonical override path
        # for managed Postgres (Neon, RDS, Aurora, Cloud SQL). When set,
        # we parse the DSN once here so the pool can use the right
        # host/port/user/password/SSL — without this the pool would
        # silently connect to ``localhost`` and the production deploy
        # would talk to a non-existent DB.
        from urllib.parse import parse_qs, urlsplit

        url_override = s.database_url if s.database_url else None
        if url_override:
            parts = urlsplit(url_override)
            # Accept the three shapes operators actually paste:
            #   - libpq-style:       postgresql://user:pw@host/db?sslmode=require
            #   - SQLAlchemy async:  postgresql+asyncpg://user:pw@host/db
            #   - legacy alias:      postgres://user:pw@host/db
            # Strip any ``+driver`` suffix so all three collapse to the same
            # ``scheme_db`` for the allow-list check below.
            scheme_db = parts.scheme.split("+", 1)[0]
            if scheme_db not in {"postgres", "postgresql"}:
                raise ValueError(
                    f"Unsupported scheme in DATABASE_URL: {parts.scheme!r}"
                )
            host = host or parts.hostname or s.postgres_host
            port = port or parts.port or s.postgres_port
            # Strip leading "/" from path so we don't end up with "/eden"
            database = database or (parts.path.lstrip("/") or s.postgres_db)
            user = user or parts.username or s.postgres_user
            password = password or parts.password or s.postgres_password
            # asyncpg uses ``ssl=`` not libpq's ``sslmode=``. Honour the
            # libpq value here so callers can paste a Neon-style URL
            # verbatim. ``channel_binding`` is libpq-only and ignored
            # (asyncpg uses scram-sha-256 by default which satisfies it).
            query = parse_qs(parts.query)
            if ssl is None and "sslmode" in query:
                mode = query["sslmode"][0].lower()
                ssl = mode not in {"disable", "allow", "prefer", ""}
        self.config = ConnectionConfig(
            host=host or s.postgres_host,
            port=port or s.postgres_port,
            database=database or s.postgres_db,
            user=user or s.postgres_user,
            password=password or s.postgres_password,
            # Honour ``settings.postgres_*_pool_size`` when the caller
            # didn't pass an explicit override — the Northflank manifest
            # sets ``POSTGRES_POOL_SIZE=10`` / ``POSTGRES_MIN_POOL_SIZE=0``
            # for the API container; the previous defaults ignored those
            # env vars and silently kept the hardcoded 5/20 baseline.
            # ``min_size`` MUST stay 0 in Neon deploys so scale-to-zero
            # can fire — warm sockets alone keep compute active.
            min_size=min_pool_size
            if min_pool_size is not None
            else s.postgres_min_pool_size,
            max_size=max_pool_size
            if max_pool_size is not None
            else s.postgres_pool_size,
        )
        # Persist the explicit ``ssl`` arg (caller override) but prefer
        # the parsed URL value when ``database_url`` was the source.
        self._ssl_override = ssl
        self._pool: Pool | None = None

    async def initialize(self) -> None:
        """Initialize the connection pool."""
        if self._pool is not None:
            return

        # ``statement_timeout`` + ``idle_in_transaction_session_timeout`` are
        # server-side ``SET`` parameters, not kwargs accepted by
        # ``asyncpg.create_pool``. Apply them via the ``init`` callback
        # so every connection in the pool has both caps before being
        # handed out. ``statement_timeout`` caps any single query;
        # ``idle_in_transaction_session_timeout`` kills connections that
        # sit idle *inside* a transaction — a "tx in flight but no work
        # happening" connection holds row locks that block vacuum + other
        # writers, and burns Neon CU until the TCP timeout kicks in.
        _settings_init = get_settings()
        _statement_timeout_ms = int(
            getattr(_settings_init, "postgres_statement_timeout_ms", 30_000)
        )
        _idle_in_tx_timeout_ms = int(
            getattr(
                _settings_init, "postgres_idle_in_transaction_timeout_ms", 60_000
            )
        )

        async def _init_connection(conn: asyncpg.Connection) -> None:
            await conn.execute(f"SET statement_timeout = {_statement_timeout_ms}")
            await conn.execute(
                f"SET idle_in_transaction_session_timeout = {_idle_in_tx_timeout_ms}"
            )

        # SSL config (Phase 7 — Neon cutover). Managed providers
        # (Neon, RDS, Aurora) reject unencrypted connections; the
        # local sandbox Postgres on Northflank (when the addon
        # worked) didn't require SSL. ``ssl=True`` is the asyncpg
        # equivalent of ``sslmode=require`` — it uses Python's default
        # SSL context, which is enough for verifying the server
        # certificate via the system CA bundle. Operators who need
        # ``verify-full`` should set ``database_url`` instead and
        # pass a DSN that asyncpg can parse.
        if self._ssl_override is not None:
            ssl: bool | str = self._ssl_override
        else:
            ssl = False
            # Audit 2026-06-23: was `getattr(settings, "postgres_sslmode", "")`
            # but `settings` was never bound in this scope (only
            # `get_settings` is imported per the module docstring). Caused
            # NameError on real `client.initialize()` calls. Resolve
            # via get_settings() to match the rest of the module.
            _ssl_settings = get_settings()
            sslmode = getattr(_ssl_settings, "postgres_sslmode", "")
            if sslmode and sslmode.lower() not in {"disable", "allow", "prefer", ""}:
                ssl = True

        _idle_lifetime = float(
            getattr(
                _settings_init,
                "postgres_max_inactive_connection_lifetime",
                60.0,
            )
            or 60.0
        )

        # HIGH fix (PgBouncer transaction-mode compat): asyncpg's default
        # client-side prepared-statement cache is keyed per physical
        # ``Connection``, but PgBouncer transaction-mode multiplexing can
        # replay a statement prepared on one backend connection against a
        # different one — producing intermittent "prepared statement does
        # not exist" / "prepared statement already exists" errors under
        # load. This module (see class docstring) explicitly targets
        # PgBouncer transaction mode, so default the cache off (0) via
        # ``settings.postgres_statement_cache_size``; only override via
        # ``POSTGRES_STATEMENT_CACHE_SIZE`` for a deployment known to run
        # session-mode pooling or no pooler at all.
        _statement_cache_size = int(
            getattr(_settings_init, "postgres_statement_cache_size", 0)
        )

        self._pool = await asyncpg.create_pool(
            host=self.config.host,
            port=self.config.port,
            database=self.config.database,
            user=self.config.user,
            password=self.config.password,
            min_size=self.config.min_size,
            max_size=self.config.max_size,
            # B-3 (Session 23) — bound the time a caller waits on
            # a pool slot and recycle idle connections so a leaked
            # connection can't keep a backend slot indefinitely.
            # ``timeout=10`` caps ``pool.acquire()``; asyncpg's
            # default is 30 s, which is longer than our upstream
            # API gateway tolerance. Idle lifetime defaults to 30s
            # (``POSTGRES_MAX_INACTIVE_CONNECTION_LIFETIME``) so Neon
            # autosuspend (~5 min) can observe a quiet TCP plane.
            timeout=10,
            command_timeout=60,
            init=_init_connection,
            ssl=ssl,
            max_inactive_connection_lifetime=_idle_lifetime,
            statement_cache_size=_statement_cache_size,
        )
        logger.info(f"PostgreSQL pool initialized: {self.config.host}:{self.config.port}/{self.config.database}")

    async def close(self) -> None:
        """Close the connection pool."""
        if self._pool:
            await self._pool.close()
            self._pool = None
            logger.info("PostgreSQL pool closed")

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[Connection]:
        """Acquire a connection from the pool (or the RLS-pinned request conn)."""
        bound = _request_pg_conn.get()
        if bound is not None:
            # Same connection that holds SET LOCAL app.current_org_id.
            # Do not release — middleware owns the lifetime.
            yield bound
            return

        if not self._pool:
            await self.initialize()

        async with self._pool.acquire() as connection:
            yield connection

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[Transaction]:
        """Execute within a transaction (autocommit=False for PgBouncer)."""
        async with self.acquire() as conn, conn.transaction():
            yield conn

    async def execute(self, query: str, *args: Any) -> str:
        """Execute a query and return status."""
        async with self.acquire() as conn:
            return cast(str, await conn.execute(query, *args))

    async def executemany(
        self,
        query: str,
        args_iter: Iterable[Sequence[Any]],
    ) -> str:
        """Run the same parameterised query for many row-tuples.

        ``args_iter`` is a sequence of tuples; each becomes one row
        insert / update. Returns the raw asyncpg status string from
        the final statement (use ``fetch`` for SELECTs).
        """
        async with self.acquire() as conn:
            return cast(
                str,
                await conn.executemany(query, list(args_iter)),
            )

    async def fetch(self, query: str, *args: Any) -> list[dict]:
        """Fetch all rows as dicts."""
        async with self.acquire() as conn:
            rows = await conn.fetch(query, *args)
            return [dict(row) for row in rows]

    async def fetchrow(self, query: str, *args: Any) -> dict | None:
        """Fetch a single row as dict."""
        async with self.acquire() as conn:
            row = await conn.fetchrow(query, *args)
            return dict(row) if row else None

    async def insert_usage_event(
        self,
        *,
        org_id: str,
        event_type: str,
        resource: str,
        quantity: float,
        unit: str,
        user_id: str | None = None,
        model: str | None = None,
        cost_usd: float | None = None,
        metadata: dict | None = None,
        correlation_id: str | None = None,
    ) -> str | None:
        """Persist a usage event row and return the event UUID.

        ``metadata`` and ``correlation_id`` are stored as JSONB /
        separate columns respectively. ``None`` for either is
        encoded as a NULL.
        """
        import uuid

        event_id = str(uuid.uuid4())
        try:
            row = await self.fetchrow(
                """
                INSERT INTO usage_events (
                    event_id, org_id, event_type, resource, quantity, unit,
                    user_id, model, cost_usd, metadata, correlation_id, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
                RETURNING event_id
                """,
                event_id,
                org_id,
                event_type,
                resource,
                quantity,
                unit,
                user_id,
                model,
                cost_usd,
                _dump_jsonb(metadata),
                correlation_id,
            )
            return str(row["event_id"]) if row else None
        except Exception:
            # Surface the failure to the caller (the service layer
            # logs + swallows) so we don't hide DB outages.
            raise

    async def get_org_resource_limits(
        self,
        org_id: str,
    ) -> dict[str, int] | None:
        """Return the per-org resource-limit overrides, if any.

        Logs and swallows on exception. The fail-closed staleness
        gate lives in the RLSOrgContextMiddleware (DL-14); here we
        just emit enough detail for ops to see why the override
        lookup went sideways (was a silent ``return None`` before
        Session 23 B-2).
        """
        try:
            row = await self.fetchrow(
                """
                SELECT jobs_soft_limit, jobs_hard_limit,
                       tokens_soft_limit, tokens_hard_limit,
                       storage_mb_soft_limit, storage_mb_hard_limit,
                       sandbox_seconds_soft_limit, sandbox_seconds_hard_limit
                FROM org_resource_limits
                WHERE org_id = $1
                """,
                org_id,
            )
            return row
        except Exception as exc:
            logger.warning(
                "org_resource_limits lookup failed (org_id=%s): %s",
                org_id, exc, exc_info=True,
            )
            return None

    async def set_org_resource_limits(
        self,
        org_id: str,
        *,
        jobs_soft_limit: int | None = None,
        jobs_hard_limit: int | None = None,
        tokens_soft_limit: int | None = None,
        tokens_hard_limit: int | None = None,
        storage_mb_soft_limit: int | None = None,
        storage_mb_hard_limit: int | None = None,
        sandbox_seconds_soft_limit: int | None = None,
        sandbox_seconds_hard_limit: int | None = None,
        plan_name: str | None = None,
    ) -> None:
        """Upsert the per-org resource-limit overrides.

        ``plan_name`` is supported (June 2026 — Cat 23 audit):
        the call site in :mod:`eden.services.usage_service` writes
        ``"org_free"`` when no row exists, so the migration
        ``046_free_only_default_plan`` backfill can be skipped for
        genuinely new orgs. Older signatures rejected the kwarg
        with a TypeError that surfaced as a 5xx in the quota
        header middleware.
        """
        await self.execute(
            """
            INSERT INTO org_resource_limits (
                org_id, jobs_soft_limit, jobs_hard_limit,
                tokens_soft_limit, tokens_hard_limit,
                storage_mb_soft_limit, storage_mb_hard_limit,
                sandbox_seconds_soft_limit, sandbox_seconds_hard_limit,
                plan_name, effective_from, updated_at
            ) VALUES (
                $1,
                COALESCE($2, 100), COALESCE($3, 200),
                COALESCE($4, 1000000), COALESCE($5, 2000000),
                COALESCE($6, 1024), COALESCE($7, 5120),
                COALESCE($8, 3600), COALESCE($9, 7200),
                COALESCE($10, 'org_free'),
                'epoch'::timestamptz, NOW()
            )
            -- The unique constraint on this table is (org_id,
            -- effective_from), not (org_id) alone (see the
            -- ``org_resource_limits_org_id_effective_from_key``
            -- UNIQUE index). We pin effective_from to 'epoch'
            -- so the conflict target is stable across calls;
            -- the "default current" plan for the org is always
            -- stored at effective_from = 'epoch' and subsequent
            -- override windows live in their own distinct rows.
            ON CONFLICT (org_id, effective_from) DO UPDATE SET
                jobs_soft_limit = EXCLUDED.jobs_soft_limit,
                jobs_hard_limit = EXCLUDED.jobs_hard_limit,
                tokens_soft_limit = EXCLUDED.tokens_soft_limit,
                tokens_hard_limit = EXCLUDED.tokens_hard_limit,
                storage_mb_soft_limit = EXCLUDED.storage_mb_soft_limit,
                storage_mb_hard_limit = EXCLUDED.storage_mb_hard_limit,
                sandbox_seconds_soft_limit = EXCLUDED.sandbox_seconds_soft_limit,
                sandbox_seconds_hard_limit = EXCLUDED.sandbox_seconds_hard_limit,
                plan_name = COALESCE(EXCLUDED.plan_name, org_resource_limits.plan_name),
                updated_at = NOW()
            """,
            org_id,
            jobs_soft_limit,
            jobs_hard_limit,
            tokens_soft_limit,
            tokens_hard_limit,
            storage_mb_soft_limit,
            storage_mb_hard_limit,
            sandbox_seconds_soft_limit,
            sandbox_seconds_hard_limit,
            plan_name,
        )

    async def fetchval(self, query: str, *args: Any) -> Any:
        """Fetch a single value."""
        async with self.acquire() as conn:
            return await conn.fetchval(query, *args)

    async def fetchiter(
        self,
        query: str,
        *args: Any,
        batch_size: int = 500,
    ) -> AsyncIterator[dict]:
        """Stream rows via a server-side cursor. Yields one dict at a time.

        Use for very large result sets (≥ ~50k rows) where loading the
        full result into memory is undesirable. Each row is yielded
        as soon as it is decoded — the cursor pulls ``batch_size`` rows
        per round-trip from Postgres. The caller MUST fully consume the
        iterator (or cancel it) before the connection is returned to
        the pool; the surrounding ``async with self.acquire()`` enforces
        this.
        """
        async with self.acquire() as conn, conn.transaction():
            async for record in conn.cursor(query, *args, prefetch=batch_size):
                yield dict(record)

    # ========================================================================
    # Job Persistence
    # ========================================================================

    async def upsert_job(
        self,
        job_id: str,
        request: dict,
        status: str = "pending",
        current_stage: str = "planning",
        created_at: str | None = None,
        user_id: str | None = None,
    ) -> bool:
        """Insert or update a job record."""
        if created_at is None:
            from datetime import datetime
            created_at = datetime.now(UTC).isoformat()

        query = """
            INSERT INTO jobs (job_id, request, status, current_stage, created_at, updated_at, user_id)
            VALUES ($1, $2, $3, $4, $5, $5, $6)
            ON CONFLICT (job_id) DO UPDATE SET
                status = EXCLUDED.status,
                current_stage = EXCLUDED.current_stage,
                updated_at = EXCLUDED.updated_at
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, _dump_jsonb(request), status, current_stage, created_at, user_id)
        return result is not None

    async def get_job(self, job_id: str, user_id: str | None = None) -> dict | None:
        """Fetch a job by ID, optionally verifying ownership."""
        query = """
            SELECT job_id, request, status, current_stage, outcome_tier,
                   created_at, updated_at, edp_history, code_history, user_id
            FROM jobs
            WHERE job_id = $1
        """
        params = [job_id]

        if user_id:
            query += " AND user_id = $2"
            params.append(user_id)

        return await self.fetchrow(query, *params)

    async def update_job_status(
        self,
        job_id: str,
        status: str,
        current_stage: str,
        outcome_tier: str | None = None,
        updated_at: str | None = None,
    ) -> bool:
        """Update job status and stage."""
        if updated_at is None:
            from datetime import datetime
            updated_at = datetime.now(UTC).isoformat()

        query = """
            UPDATE jobs
            SET status = $2, current_stage = $3, outcome_tier = $4, updated_at = $5
            WHERE job_id = $1
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, status, current_stage, outcome_tier, updated_at)
        if result is not None:
            # A6: wake job WS / mobile SSE waiters (fire-and-forget).
            with contextlib.suppress(Exception):
                from eden.api.routes.websocket import publish_job_event

                asyncio.create_task(
                    publish_job_event(
                        job_id,
                        {
                            "job_id": job_id,
                            "status": status,
                            "current_stage": current_stage,
                            "outcome_tier": outcome_tier,
                        },
                    )
                )
        return result is not None

    async def list_jobs(
        self,
        user_id: str | None = None,
        status: str | None = None,
        outcome_tier: str | None = None,
        q: str | None = None,
        sort: str = "created_at:desc",
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        """List jobs with pagination and optional filters."""
        conditions = []
        params = []
        param_idx = 1

        if user_id:
            conditions.append(f"user_id = ${param_idx}")
            params.append(user_id)
            param_idx += 1

        if status:
            conditions.append(f"status = ${param_idx}")
            params.append(status)
            param_idx += 1

        if outcome_tier:
            conditions.append(f"outcome_tier = ${param_idx}")
            params.append(outcome_tier)
            param_idx += 1

        if q:
            # Prefer expression-index-friendly predicates (migration 113
            # adds gin_trgm on job_id and request::text).
            conditions.append(
                f"(job_id ILIKE ${param_idx} OR request::text ILIKE ${param_idx})"
            )
            params.append(f"%{q}%")
            param_idx += 1

        # Parse sort parameter (field:direction)
        sort_field, sort_dir = "created_at", "DESC"
        if sort and ":" in sort:
            sort_field, sort_dir = sort.split(":", 1)
            sort_dir = sort_dir.upper()
            if sort_dir not in ("ASC", "DESC"):
                sort_dir = "DESC"
            # Whitelist allowed sort fields to prevent SQL injection
            allowed_fields = ("created_at", "updated_at", "status", "outcome_tier")
            if sort_field not in allowed_fields:
                sort_field = "created_at"
        elif sort:
            allowed_fields = ("created_at", "updated_at", "status", "outcome_tier")
            if sort in allowed_fields:
                sort_field = sort

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        query = f"""
            SELECT job_id, request, status, current_stage, outcome_tier, created_at, updated_at
            FROM jobs
            {where_clause}
            ORDER BY {sort_field} {sort_dir}
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """
        params.extend([limit, offset])
        return await self.fetch(query, *params)

    async def count_jobs(
        self,
        user_id: str | None = None,
        status: str | None = None,
        outcome_tier: str | None = None,
    ) -> int:
        """Count jobs with optional filters."""
        conditions = []
        params = []
        param_idx = 1

        if user_id:
            conditions.append(f"user_id = ${param_idx}")
            params.append(user_id)
            param_idx += 1

        if status:
            conditions.append(f"status = ${param_idx}")
            params.append(status)
            param_idx += 1

        if outcome_tier:
            conditions.append(f"outcome_tier = ${param_idx}")
            params.append(outcome_tier)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        query = f"SELECT COUNT(*) FROM jobs {where_clause}"
        return await self.fetchval(query, *params) or 0

    async def update_job_stage_history(self, job_id: str, stage_history: list[dict]) -> bool:
        """Update job stage history."""
        query = """
            UPDATE jobs
            SET stage_history = $2, updated_at = NOW()
            WHERE job_id = $1
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, _dump_jsonb(stage_history))
        return result is not None

    # ========================================================================
    # Checkpoint Blobs (LangGraph state offloading)
    # ========================================================================

    async def insert_checkpoint_blob(self, job_id: str, field: str, value: dict) -> bool:
        """Store a checkpoint blob for a job."""
        query = """
            INSERT INTO checkpoint_blobs (job_id, field, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (job_id, field) DO UPDATE SET
                value = EXCLUDED.value,
                created_at = NOW()
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, field, _dump_jsonb(value))
        if result is not None:
            with contextlib.suppress(Exception):
                from eden.api.routes.websocket import publish_job_event

                asyncio.create_task(
                    publish_job_event(
                        job_id,
                        {"job_id": job_id, "blob_field": field},
                    )
                )
        return result is not None

    async def get_checkpoint_blob(self, job_id: str, field: str) -> dict | None:
        """Get a specific checkpoint blob."""
        query = "SELECT value FROM checkpoint_blobs WHERE job_id = $1 AND field = $2"
        row = await self.fetchrow(query, job_id, field)
        return json.loads(row["value"]) if row else None

    async def get_checkpoint_blobs(self, job_id: str) -> list[dict]:
        """Get all checkpoint blobs for a job."""
        query = """
            SELECT field, value, created_at
            FROM checkpoint_blobs
            WHERE job_id = $1
            ORDER BY created_at ASC
        """
        rows = await self.fetch(query, job_id)
        return [{"field": r["field"], "value": json.loads(r["value"]), "created_at": r["created_at"]} for r in rows]

    async def delete_checkpoint_blobs(self, job_id: str) -> bool:
        """Delete all checkpoint blobs for a job."""
        await self.execute("DELETE FROM checkpoint_blobs WHERE job_id = $1", job_id)
        return True

    # ========================================================================
    # Agent Uploads (Phase 3: web upload + sim/test runner)
    # ========================================================================

    async def create_agent_upload(
        self,
        *,
        org_id: str,
        agent_id: str,
        code_path: str,
        entry_point: str | None = None,
        framework: str | None = None,
        language: str | None = None,
        file_count: int | None = None,
        total_bytes: int | None = None,
        eval_yaml: dict | None = None,
        uploaded_by: str | None = None,
    ) -> dict | None:
        """Create a new agent upload row. The DB trigger handles
        supersession of prior uploads (is_active flag).

        Returns the inserted row (with the auto-generated id and
        uploaded_at).
        """
        row = await self.fetchrow(
            """
            INSERT INTO agent_uploads (
                org_id, agent_id, code_path, entry_point, framework,
                language, file_count, total_bytes, eval_yaml, uploaded_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id, org_id, agent_id, upload_version, code_path,
                      entry_point, framework, language, file_count,
                      total_bytes, eval_yaml, uploaded_by, uploaded_at,
                      is_active
            """,
            org_id, agent_id, code_path, entry_point, framework, language,
            file_count, total_bytes,
            _dump_jsonb(eval_yaml),
            uploaded_by,
        )
        if row and row.get("eval_yaml") is not None:  # noqa: SIM102
            # asyncpg returns JSONB as a Python value already; only
            # decode if it's still a string (older paths).
            # The nested `if` is intentional — it documents the
            # legacy-vs-modern JSONB path; combining would lose that.
            if isinstance(row["eval_yaml"], str):  # noqa: SIM102
                row["eval_yaml"] = json.loads(row["eval_yaml"])
        return row

    async def list_agent_uploads(
        self,
        *,
        org_id: str,
        agent_id: str,
        active_only: bool = False,
        limit: int = 50,
    ) -> list[dict]:
        """List uploads for an agent, most-recent first."""
        where = "org_id = $1 AND agent_id = $2"
        if active_only:
            where += " AND is_active = TRUE"
        rows = await self.fetch(
            f"""
            SELECT id, org_id, agent_id, upload_version, code_path,
                   entry_point, framework, language, file_count,
                   total_bytes, eval_yaml, uploaded_by, uploaded_at,
                   is_active
            FROM agent_uploads
            WHERE {where}
            ORDER BY uploaded_at DESC
            LIMIT $3
            """,
            org_id, agent_id, limit,
        )
        for r in rows:
            if isinstance(r.get("eval_yaml"), str):
                r["eval_yaml"] = json.loads(r["eval_yaml"])
        return rows

    async def get_agent_upload(
        self,
        upload_id: str,
    ) -> dict | None:
        """Fetch one upload row by id."""
        row = await self.fetchrow(
            """
            SELECT id, org_id, agent_id, upload_version, code_path,
                   entry_point, framework, language, file_count,
                   total_bytes, eval_yaml, uploaded_by, uploaded_at,
                   is_active
            FROM agent_uploads
            WHERE id = $1
            """,
            upload_id,
        )
        if row and isinstance(row.get("eval_yaml"), str):
            row["eval_yaml"] = json.loads(row["eval_yaml"])
        return row

    async def get_active_upload(
        self,
        *,
        org_id: str,
        agent_id: str,
    ) -> dict | None:
        """Fetch the active upload for an agent (None if none)."""
        row = await self.fetchrow(
            """
            SELECT id, org_id, agent_id, upload_version, code_path,
                   entry_point, framework, language, file_count,
                   total_bytes, eval_yaml, uploaded_by, uploaded_at,
                   is_active
            FROM agent_uploads
            WHERE org_id = $1 AND agent_id = $2 AND is_active = TRUE
            LIMIT 1
            """,
            org_id, agent_id,
        )
        if row and isinstance(row.get("eval_yaml"), str):
            row["eval_yaml"] = json.loads(row["eval_yaml"])
        return row

    # ========================================================================
    # Sim / Test Runs (Phase 3: server-side execution)
    # ========================================================================

    async def create_sim_run(
        self,
        *,
        org_id: str,
        agent_id: str,
        upload_id: str,
        kind: str,
        user_id: str | None = None,
        runner_kind: str | None = None,
    ) -> dict | None:
        """Insert a new sim/test run row in `pending` state.

        The actual execution happens in a background task; the caller
        immediately returns this row so the client can poll its id.
        """
        row = await self.fetchrow(
            """
            INSERT INTO sim_runs (org_id, agent_id, upload_id, kind, user_id, runner_kind)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, org_id, agent_id, upload_id, kind, status,
                      user_id, started_at, runner_kind
            """,
            org_id, agent_id, upload_id, kind, user_id, runner_kind,
        )
        return row

    async def update_sim_run_status(
        self,
        run_id: str,
        *,
        status: str,
        finished_at: str | None = None,
        duration_ms: int | None = None,
        error: str | None = None,
    ) -> bool:
        """Update the run's status. ``finished_at`` is set automatically
        when ``status`` is terminal (passed/failed/error).
        """
        import datetime as _dt
        if finished_at is None and status in ("passed", "failed", "error"):
            finished_at = _dt.datetime.now(_dt.UTC).isoformat()
        result = await self.fetchval(
            """
            UPDATE sim_runs
            SET status = $2,
                finished_at = COALESCE($3, finished_at),
                duration_ms = COALESCE($4, duration_ms),
                error = COALESCE($5, error)
            WHERE id = $1
            RETURNING id
            """,
            run_id, status, finished_at, duration_ms, error,
        )
        return result is not None

    async def update_sim_run_result(
        self,
        run_id: str,
        *,
        results: dict,
    ) -> bool:
        """Persist the structured run results (JSONB)."""
        result = await self.fetchval(
            """
            UPDATE sim_runs
            SET results = $2
            WHERE id = $1
            RETURNING id
            """,
            run_id, _dump_jsonb(results),
        )
        return result is not None

    async def get_sim_run(self, run_id: str) -> dict | None:
        row = await self.fetchrow(
            """
            SELECT id, org_id, agent_id, upload_id, kind, status,
                   user_id, started_at, finished_at, duration_ms,
                   results, error, runner_kind
            FROM sim_runs
            WHERE id = $1
            """,
            run_id,
        )
        if row and isinstance(row.get("results"), str):
            row["results"] = json.loads(row["results"])
        return row

    async def list_sim_runs(
        self,
        *,
        org_id: str,
        agent_id: str,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        where = "org_id = $1 AND agent_id = $2"
        params: list = [org_id, agent_id]
        if kind:
            params.append(kind)
            where += f" AND kind = ${len(params)}"
        if status:
            params.append(status)
            where += f" AND status = ${len(params)}"
        rows = await self.fetch(
            f"""
            SELECT id, org_id, agent_id, upload_id, kind, status,
                   user_id, started_at, finished_at, duration_ms,
                   results, error, runner_kind
            FROM sim_runs
            WHERE {where}
            ORDER BY started_at DESC
            LIMIT ${len(params) + 1}
            """,
            *params, limit,
        )
        for r in rows:
            if isinstance(r.get("results"), str):
                r["results"] = json.loads(r["results"])
        return rows


# Singleton instance
_postgres_client: PostgresClient | None = None


async def get_postgres_client() -> PostgresClient:
    """Get the singleton PostgreSQL client instance."""
    global _postgres_client
    if _postgres_client is None:
        _postgres_client = PostgresClient()
        await _postgres_client.initialize()
    return _postgres_client


async def set_session_org_context(client: PostgresClient, org_id: str) -> None:
    """Phase 7.3e — set the RLS GUC for the current request.

    The migration 015 RLS policies use
    ``current_setting('app.current_org_id', true)`` to filter rows
    on the observability/retention/audit tables to the
    authenticated tenant. The FastAPI middleware (or a route
    handler) should call this helper at the start of every
    request that touches a tenant-scoped table.

    The GUC is scoped to the current transaction (``SET LOCAL``)
    so the value doesn't leak between requests sharing the same
    connection-pool session.

    Audit 2026-07-03 — explicitly open a transaction before calling
    ``set_config(..., is_local=true)``. ``SET LOCAL`` has no effect
    outside a transaction; the previous "best-effort" comment was
    actually a silent no-op whenever the implicit transaction from
    ``client.execute`` already committed by the time the SET
    returned. ``async with conn.transaction()`` guarantees the SET
    runs inside an open tx; the transaction commits immediately on
    exit so the GUC reverts at function return (the intended
    scoping).

    LIMITATION — request-scoped connection: even with the
    transaction wrapper correct, the GUC is set on the connection
    the middleware acquired. Route handlers that call
    ``client.execute`` may get a *different* pooled connection,
    so the RLS policies on tables this query touches won't
    actually filter. Defence-in-depth now requires either (a)
    per-request connection pinning via ``request.state.pg_conn``,
    or (b) every tenant-scoped handler passing the connection from
    this helper through. Until that's wired, the migration-015
    RLS policies are "best-effort" — per-query ``WHERE org_id = $1``
    remains the primary defence.
    """
    if not org_id:
        return
    try:
        # ``client.execute`` opens an implicit transaction for the
        # single statement; asyncpg commits that transaction when
        # the statement returns, so ``SET LOCAL`` is correctly
        # scoped to that transaction and the GUC reverts before
        # the connection is returned to the pool. (Pre-fix this
        # was a hidden implicit transaction that sometimes
        # committed before the SET landed — the audit 2026-07-03
        # docstring above documents the request-scoped-connection
        # gap that this helper cannot bridge on its own.)
        await client.execute(
            "SELECT set_config('app.current_org_id', $1, true)",
            org_id,
        )
    except Exception:
        # The migration's RLS policies are written with
        # ``current_setting('app.current_org_id', true)`` so a
        # missing setting returns NULL — a no-op filter. Never
        # raise: a DB blip on the SET should not poison the
        # request.
        return


async def close_postgres_client() -> None:
    """Close the singleton PostgreSQL client."""
    global _postgres_client
    if _postgres_client:
        await _postgres_client.close()
        _postgres_client = None
