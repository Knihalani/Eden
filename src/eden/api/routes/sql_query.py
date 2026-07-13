"""Phase M — read-only SQL query surface.

Three routes:

  * ``POST /orgs/{org}/sql/execute`` — run a query
  * ``GET  /orgs/{org}/sql/schema``   — list allowed tables
  * ``GET  /orgs/{org}/sql/limits``  — current org's row + time caps

The executor (:class:`eden.observability.sql_executor.SqlExecutor`)
is the real surface; this module is the FastAPI wiring.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.routes.auth import get_current_user
from eden.observability.sql_executor import (
    DEFAULT_MAX_ROWS,
    DEFAULT_MAX_SECONDS,
    MAX_MAX_ROWS,
    MAX_MAX_SECONDS,
    SqlExecutor,
    SqlForbiddenStatementError,
    SqlMultiStatementError,
    SqlTenantViolationError,
    SqlTimeoutError,
    SqlUnknownTableError,
    get_schema_summary,
)
from eden.storage.postgres import get_postgres_client
from eden.storage.redis import Cache

logger = logging.getLogger(__name__)

_schema_cache = Cache(prefix="eden:sql:schema", default_ttl=300)
_SCHEMA_CACHE_TTL = 300


router = APIRouter(
    prefix="/orgs/{org_id}/sql",
    tags=["sql"],
)


# ── Schemas ────────────────────────────────────────────────────────


class SqlExecuteRequest(BaseModel):
    sql: str = Field(
        ...,
        min_length=1, max_length=50_000,
        description="A single SELECT statement. No writes; no multi-statements.",
    )
    params: dict[str, Any] = Field(
        default_factory=dict,
        description="Named params for :name placeholders.",
    )
    max_rows: int | None = Field(
        default=None,
        ge=1, le=MAX_MAX_ROWS,
        description="Override the per-query row cap (max 10000).",
    )
    max_seconds: int | None = Field(
        default=None,
        ge=1, le=MAX_MAX_SECONDS,
        description="Override the per-query time cap (max 120s).",
    )


class SqlExecuteResponse(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    execution_ms: float
    cap_hit: str | None = None


class SqlErrorResponse(BaseModel):
    error: str
    kind: str
    detail: str | None = None


class SqlSchemaResponse(BaseModel):
    tables: list[dict[str, Any]]


class SqlLimitsResponse(BaseModel):
    max_rows: int
    max_seconds: int
    hard_cap_rows: int = MAX_MAX_ROWS
    hard_cap_seconds: int = MAX_MAX_SECONDS


# ── Routes ─────────────────────────────────────────────────────────


@router.post(
    "/execute",
    response_model=SqlExecuteResponse,
    responses={
        400: {"model": SqlErrorResponse, "description": "Forbidden / malformed SQL"},
        403: {"model": SqlErrorResponse, "description": "Tenant violation"},
        408: {"model": SqlErrorResponse, "description": "Query timeout"},
    },
    summary="Run a read-only SQL query against the analytics tables",
)
async def execute_sql(
    body: SqlExecuteRequest,
    org_id: str = Path(..., description="Organization ID"),
    user: dict = Depends(get_current_user),
) -> SqlExecuteResponse:
    """Execute a single SELECT against the allowlisted tables.

    The executor enforces:

      * SELECT-only (no INSERT/UPDATE/DELETE/DDL/EXPLAIN/...)
      * Single statement (no `;` followed by another statement)
      * Table allowlist (rejects any FROM/JOIN outside the list)
      * Per-tenant injection (``org_id = ...`` is appended)
      * Row cap (default 1000, max 10000)
      * Statement timeout (default 30s, max 120s)

    Returns rows + columns + timing. If the result was truncated
    at the row cap, ``truncated=true`` and ``cap_hit="row_limit"``.
    """
    pg = await get_postgres_client()
    executor = SqlExecutor(
        pg,
        max_rows=body.max_rows or DEFAULT_MAX_ROWS,
        max_seconds=body.max_seconds or DEFAULT_MAX_SECONDS,
    )
    try:
        result = await executor.execute(
            body.sql,
            org_id=org_id,
            params=body.params,
        )
    except SqlForbiddenStatementError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "forbidden_statement",
                "kind": "forbidden_statement",
                "detail": str(exc),
            },
        ) from exc
    except SqlMultiStatementError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "multi_statement",
                "kind": "multi_statement",
                "detail": str(exc),
            },
        ) from exc
    except SqlUnknownTableError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "unknown_table",
                "kind": "unknown_table",
                "detail": str(exc),
            },
        ) from exc
    except SqlTenantViolationError as exc:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "tenant_violation",
                "kind": "tenant_violation",
                "detail": str(exc),
            },
        ) from exc
    except SqlTimeoutError as exc:
        raise HTTPException(
            status_code=408,
            detail={
                "error": "timeout",
                "kind": "timeout",
                "detail": str(exc),
            },
        ) from exc

    return SqlExecuteResponse(
        columns=result.columns,
        rows=result.rows,
        row_count=result.row_count,
        truncated=result.truncated,
        execution_ms=result.execution_ms,
        cap_hit=result.cap_hit,
    )


@router.get(
    "/schema",
    response_model=SqlSchemaResponse,
    summary="List the tables + columns available to the SQL executor",
)
async def get_sql_schema(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> SqlSchemaResponse:
    """Return the schema of every allowlisted table.

    Reads from ``information_schema.columns`` so the response
    always matches the live schema. The result is cached per-org
    for 5 minutes in Redis (L0 in-process + L1 Redis).
    """
    cache_key = f"schema:{org_id}"
    cached = await _schema_cache.get(cache_key)
    if cached is not None and isinstance(cached, list):
        return SqlSchemaResponse(tables=cached)

    pg = await get_postgres_client()
    tables = await get_schema_summary(pg)
    await _schema_cache.set(cache_key, tables, ttl=_SCHEMA_CACHE_TTL)
    return SqlSchemaResponse(tables=tables)


@router.get(
    "/limits",
    response_model=SqlLimitsResponse,
    summary="Return the per-query row + time caps",
)
async def get_sql_limits(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> SqlLimitsResponse:
    """Surface the current org's caps. Admins can override
    these via Settings (``sql_max_rows`` / ``sql_max_seconds``)
    — when they do, this endpoint returns the override."""
    # pre-release: per-org Settings overrides are not yet wired;
    # the response always reflects the platform defaults until
    # the per-org override store ships.
    return SqlLimitsResponse(
        max_rows=DEFAULT_MAX_ROWS,
        max_seconds=DEFAULT_MAX_SECONDS,
        hard_cap_rows=MAX_MAX_ROWS,
        hard_cap_seconds=MAX_MAX_SECONDS,
    )
