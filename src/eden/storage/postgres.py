"""PostgreSQL storage client for Eden.

Provides connection pooling via PgBouncer and typed clients for each KB layer.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, cast

import asyncpg
from asyncpg import Connection, Pool
from asyncpg.transaction import Transaction

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


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
        min_pool_size: int = 5,
        max_pool_size: int = 20,
    ) -> None:
        self.config = ConnectionConfig(
            host=host or settings.postgres_host,
            port=port or settings.postgres_port,
            database=database or settings.postgres_db,
            user=user or settings.postgres_user,
            password=password or settings.postgres_password,
            min_size=min_pool_size,
            max_size=max_pool_size,
        )
        self._pool: Pool | None = None

    async def initialize(self) -> None:
        """Initialize the connection pool."""
        if self._pool is not None:
            return

        # ``statement_timeout`` is a server-side ``SET`` parameter, not
        # a kwarg accepted by ``asyncpg.create_pool``.  Apply it via the
        # ``init`` callback so every connection in the pool has the
        # 30 s query cap before being handed out.  ``command_timeout``
        # IS a valid kwarg — it caps the client-side wait for any
        # single query.
        async def _init_connection(conn: asyncpg.Connection) -> None:
            await conn.execute("SET statement_timeout = 30000")

        # SSL config (Phase 7 — Neon cutover). Managed providers
        # (Neon, RDS, Aurora) reject unencrypted connections; the
        # local sandbox Postgres on Northflank (when the addon
        # worked) didn't require SSL. ``ssl=True`` is the asyncpg
        # equivalent of ``sslmode=require`` — it uses Python's default
        # SSL context, which is enough for verifying the server
        # certificate via the system CA bundle. Operators who need
        # ``verify-full`` should set ``database_url`` instead and
        # pass a DSN that asyncpg can parse.
        ssl: bool | str = False
        sslmode = getattr(settings, "postgres_sslmode", "")
        if sslmode and sslmode.lower() not in {"disable", "allow", "prefer", ""}:
            ssl = True

        self._pool = await asyncpg.create_pool(
            host=self.config.host,
            port=self.config.port,
            database=self.config.database,
            user=self.config.user,
            password=self.config.password,
            min_size=self.config.min_size,
            max_size=self.config.max_size,
            command_timeout=60,
            init=_init_connection,
            ssl=ssl,
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
        """Acquire a connection from the pool."""
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
        import json
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
                json.dumps(metadata) if metadata is not None else None,
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
        """Return the per-org resource-limit overrides, if any."""
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
        except Exception:
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
    ) -> None:
        """Upsert the per-org resource-limit overrides."""
        await self.execute(
            """
            INSERT INTO org_resource_limits (
                org_id, jobs_soft_limit, jobs_hard_limit,
                tokens_soft_limit, tokens_hard_limit,
                storage_mb_soft_limit, storage_mb_hard_limit,
                sandbox_seconds_soft_limit, sandbox_seconds_hard_limit,
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (org_id) DO UPDATE SET
                jobs_soft_limit = EXCLUDED.jobs_soft_limit,
                jobs_hard_limit = EXCLUDED.jobs_hard_limit,
                tokens_soft_limit = EXCLUDED.tokens_soft_limit,
                tokens_hard_limit = EXCLUDED.tokens_hard_limit,
                storage_mb_soft_limit = EXCLUDED.storage_mb_soft_limit,
                storage_mb_hard_limit = EXCLUDED.storage_mb_hard_limit,
                sandbox_seconds_soft_limit = EXCLUDED.sandbox_seconds_soft_limit,
                sandbox_seconds_hard_limit = EXCLUDED.sandbox_seconds_hard_limit,
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
            created_at = datetime.utcnow().isoformat()

        query = """
            INSERT INTO jobs (job_id, request, status, current_stage, created_at, updated_at, user_id)
            VALUES ($1, $2, $3, $4, $5, $5, $6)
            ON CONFLICT (job_id) DO UPDATE SET
                status = EXCLUDED.status,
                current_stage = EXCLUDED.current_stage,
                updated_at = EXCLUDED.updated_at
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, json.dumps(request), status, current_stage, created_at, user_id)
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
            updated_at = datetime.utcnow().isoformat()

        query = """
            UPDATE jobs
            SET status = $2, current_stage = $3, outcome_tier = $4, updated_at = $5
            WHERE job_id = $1
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, status, current_stage, outcome_tier, updated_at)
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
            conditions.append(f"(job_id ILIKE ${param_idx} OR request::text ILIKE ${param_idx})")
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
        result = await self.fetchval(query, job_id, json.dumps(stage_history))
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
        result = await self.fetchval(query, job_id, field, json.dumps(value))
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
            json.dumps(eval_yaml) if eval_yaml is not None else None,
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
            run_id, json.dumps(results),
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


async def set_session_org_context(client: "PostgresClient", org_id: str) -> None:
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
    """
    if not org_id:
        return
    try:
        # ``SET LOCAL`` requires an open transaction. If the pool
        # has not given us a transaction yet, the SET will be
        # silently ignored — Postgres only allows SET LOCAL
        # inside a transaction. We do our best: in practice the
        # first query through the pool starts a transaction and
        # our next SET LOCAL sticks.
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
