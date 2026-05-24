"""PostgreSQL storage client for Eden.

Provides connection pooling via PgBouncer and typed clients for each KB layer.
"""

import json
import logging
from contextlib import asynccontextmanager
from typing import Optional, AsyncIterator
from dataclasses import dataclass
from uuid import UUID

import asyncpg
from asyncpg import Pool, Connection
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
        host: Optional[str] = None,
        port: Optional[int] = None,
        database: Optional[str] = None,
        user: Optional[str] = None,
        password: Optional[str] = None,
        min_pool_size: int = 5,
        max_pool_size: int = 20,
    ):
        self.config = ConnectionConfig(
            host=host or settings.postgres_host,
            port=port or settings.postgres_port,
            database=database or settings.postgres_db,
            user=user or settings.postgres_user,
            password=password or settings.postgres_password,
            min_size=min_pool_size,
            max_size=max_pool_size,
        )
        self._pool: Optional[Pool] = None

    async def initialize(self) -> None:
        """Initialize the connection pool."""
        if self._pool is not None:
            return

        self._pool = await asyncpg.create_pool(
            host=self.config.host,
            port=self.config.port,
            database=self.config.database,
            user=self.config.user,
            password=self.config.password,
            min_size=self.config.min_size,
            max_size=self.config.max_size,
            command_timeout=60,
            statement_timeout=30000,  # 30 second query timeout
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
        async with self.acquire() as conn:
            async with conn.transaction():
                yield conn

    async def execute(self, query: str, *args) -> str:
        """Execute a query and return status."""
        async with self.acquire() as conn:
            return await conn.execute(query, *args)

    async def fetch(self, query: str, *args) -> list[dict]:
        """Fetch all rows as dicts."""
        async with self.acquire() as conn:
            rows = await conn.fetch(query, *args)
            return [dict(row) for row in rows]

    async def fetchrow(self, query: str, *args) -> Optional[dict]:
        """Fetch a single row as dict."""
        async with self.acquire() as conn:
            row = await conn.fetchrow(query, *args)
            return dict(row) if row else None

    async def fetchval(self, query: str, *args):
        """Fetch a single value."""
        async with self.acquire() as conn:
            return await conn.fetchval(query, *args)

    # ========================================================================
    # Job Persistence
    # ========================================================================

    async def upsert_job(
        self,
        job_id: str,
        request: dict,
        status: str = "pending",
        current_stage: str = "planning",
        created_at: Optional[str] = None,
    ) -> bool:
        """Insert or update a job record."""
        if created_at is None:
            from datetime import datetime
            created_at = datetime.utcnow().isoformat()

        query = """
            INSERT INTO jobs (job_id, request, status, current_stage, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $5)
            ON CONFLICT (job_id) DO UPDATE SET
                status = EXCLUDED.status,
                current_stage = EXCLUDED.current_stage,
                updated_at = EXCLUDED.updated_at
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, json.dumps(request), status, current_stage, created_at)
        return result is not None

    async def get_job(self, job_id: str) -> Optional[dict]:
        """Fetch a job by ID."""
        query = """
            SELECT job_id, request, status, current_stage, outcome_tier,
                   created_at, updated_at, edp_history, code_history
            FROM jobs
            WHERE job_id = $1
        """
        return await self.fetchrow(query, job_id)

    async def update_job_status(
        self,
        job_id: str,
        status: str,
        current_stage: str,
        outcome_tier: Optional[str] = None,
        updated_at: Optional[str] = None,
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

    async def list_jobs(self, limit: int = 50, offset: int = 0) -> list[dict]:
        """List jobs with pagination."""
        query = """
            SELECT job_id, status, current_stage, outcome_tier, created_at, updated_at
            FROM jobs
            ORDER BY created_at DESC
            LIMIT $1 OFFSET $2
        """
        return await self.fetch(query, limit, offset)

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

    async def get_checkpoint_blob(self, job_id: str, field: str) -> Optional[dict]:
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


# Singleton instance
_postgres_client: Optional[PostgresClient] = None


async def get_postgres_client() -> PostgresClient:
    """Get the singleton PostgreSQL client instance."""
    global _postgres_client
    if _postgres_client is None:
        _postgres_client = PostgresClient()
        await _postgres_client.initialize()
    return _postgres_client


async def close_postgres_client() -> None:
    """Close the singleton PostgreSQL client."""
    global _postgres_client
    if _postgres_client:
        await _postgres_client.close()
        _postgres_client = None