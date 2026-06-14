"""Audit log routes for Eden API."""

import logging
from datetime import datetime

import asyncpg
from fastapi import APIRouter, Cookie, Header, Query
from pydantic import BaseModel, field_validator

from eden.api.deps import require_org_permission
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs", tags=["audit"])


class ChainVerifyEntry(BaseModel):
    """One row in the chain-verify report."""
    seq: int
    id: str
    # asyncpg returns ``datetime`` for timestamp columns; the SQL
    # function may also return ISO text in some configurations. Accept
    # both and normalise to an ISO string so the response model is
    # always serialisable.
    created_at: str | None = None
    ok: bool
    expected_hash: str
    actual_hash: str

    @field_validator("created_at", mode="before")
    @classmethod
    def _coerce_created_at(cls, v):
        if isinstance(v, datetime):
            return v.isoformat()
        return v


class ChainVerifyResponse(BaseModel):
    """§6.4 — audit log chain verify report."""
    total_rows: int = 0
    ok_rows: int = 0
    broken_rows: int = 0
    entries: list[ChainVerifyEntry] = []


class AuditLogEntry(BaseModel):
    """Single audit log entry."""
    id: str
    org_id: str
    user_id: str
    action: str
    target_type: str | None
    target_id: str | None
    metadata: dict
    ip_address: str | None
    user_agent: str | None
    created_at: str


class AuditLogResponse(BaseModel):
    """Paginated audit log response."""
    entries: list[AuditLogEntry]
    total: int
    limit: int
    offset: int


@router.get("/{org_id}/audit-log", response_model=AuditLogResponse)
async def get_audit_log(
    org_id: str,
    action: str | None = Query(None, description="Filter by action type (e.g., 'member.invited')"),
    user_id: str | None = Query(None, description="Filter by user ID"),
    from_date: str | None = Query(None, description="Filter from date (ISO format)"),
    to_date: str | None = Query(None, description="Filter to date (ISO format)"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
):
    """Get audit log for an organization.

    Returns paginated audit log entries ordered by creation time (newest first).
    Requires audit:view permission (owner and admin only).
    """
    # Require audit:view permission
    await require_org_permission("audit:view", org_id, authorization)

    client = await get_postgres_client()

    # Build query with filters
    conditions = ["oal.org_id = $1"]
    params = [org_id]
    param_idx = 2

    if action:
        conditions.append(f"oal.action = ${param_idx}")
        params.append(action)
        param_idx += 1

    if user_id:
        conditions.append(f"oal.user_id = ${param_idx}")
        params.append(user_id)
        param_idx += 1

    if from_date:
        conditions.append(f"oal.created_at >= ${param_idx}")
        params.append(from_date)
        param_idx += 1

    if to_date:
        conditions.append(f"oal.created_at <= ${param_idx}")
        params.append(to_date)
        param_idx += 1

    where_clause = " AND ".join(conditions)

    # Get total count
    count_query = f"""
        SELECT COUNT(*) FROM org_audit_log oal
        WHERE {where_clause}
    """
    total = await client.fetchval(count_query, *params) or 0

    # Get entries with pagination
    query = f"""
        SELECT oal.id, oal.org_id, oal.user_id, oal.action,
               oal.target_type, oal.target_id, oal.metadata,
               oal.ip_address, oal.user_agent, oal.created_at,
               u.email as user_email, u.name as user_name
        FROM org_audit_log oal
        JOIN users u ON u.id = oal.user_id
        WHERE {where_clause}
        ORDER BY oal.created_at DESC
        LIMIT ${param_idx} OFFSET ${param_idx + 1}
    """
    params.extend([limit, offset])

    rows = await client.fetch(query, *params)

    entries = []
    for row in rows:
        entries.append(AuditLogEntry(
            id=str(row["id"]),
            org_id=str(row["org_id"]),
            user_id=str(row["user_id"]),
            action=row["action"],
            target_type=row.get("target_type"),
            target_id=row.get("target_id"),
            metadata=row.get("metadata", {}),
            ip_address=row.get("ip_address"),
            user_agent=row.get("user_agent"),
            created_at=row["created_at"].isoformat() if row.get("created_at") else "",
        ))

    return AuditLogResponse(
        entries=entries,
        total=total,
        limit=limit,
        offset=offset,
    )

@router.get("/{org_id}/audit-log/verify-chain", response_model=ChainVerifyResponse)
async def verify_audit_chain(
    org_id: str,
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
):
    """§6.4 — verify the audit-log hash chain for tamper-evidence.

    Returns a report with the total / ok / broken counts. If the
    migration creating the ``verify_audit_chain`` SQL function has
    not been applied, ``client.fetch`` will raise and we surface a
    zero-state so the portal can render a "needs migration" banner.
    """
    await require_org_permission("audit:view", org_id, authorization)
    client = await get_postgres_client()
    try:
        rows = await client.fetch(
            "SELECT seq, id, created_at, ok, expected_hash, actual_hash "
            "FROM verify_audit_chain($1) ORDER BY seq",
            org_id,
        )
    except asyncpg.exceptions.UndefinedFunctionError:
        # Migration not applied — surface zero state so the portal
        # can render a "needs migration" banner.
        return ChainVerifyResponse()
    except Exception:
        # Real DB failure (connection drop, permission, etc.) — log
        # and re-raise so it surfaces as a 500 rather than being
        # silently misreported as a missing migration.
        logger.exception("verify_audit_chain DB call failed for org=%s", org_id)
        raise
    entries = [ChainVerifyEntry(**r) for r in rows]
    ok = sum(1 for e in entries if e.ok)
    return ChainVerifyResponse(
        total_rows=len(entries),
        ok_rows=ok,
        broken_rows=len(entries) - ok,
        entries=entries,
    )


@router.get("/{org_id}/audit-log/export")
async def export_audit_log(
    org_id: str,
    format: str = Query("jsonl", pattern="^(jsonl|csv)$"),
    from_date: str | None = Query(None),
    to_date: str | None = Query(None),
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
):
    """§6.4 — streaming export of the audit log as JSONL or CSV.

    Returns a StreamingResponse whose ``body_iterator`` yields one
    record per chunk. JSONL writes one record per line; CSV writes
    a header row followed by one record per line.
    """
    import csv as _csv
    import io as _io
    import json as _json

    from fastapi.responses import StreamingResponse

    await require_org_permission("audit:view", org_id, authorization)
    client = await get_postgres_client()
    # NOTE: the canonical table is `org_audit_log` (aliased `oal`); a
    # previous revision of this query targeted a non-existent
    # `audit_log` and selected `user_email` as a base column instead
    # of joining `users`, so the export silently returned garbage.
    #
    # Use the server-side-cursor streamer so an org with millions of
    # audit rows doesn't OOM the API process — the previous
    # ``client.fetch(...)`` loaded the entire result set into memory
    # before yielding the first byte. ``fetchiter`` holds the
    # connection for the duration of the generator; FastAPI cancels
    # the generator when the client disconnects, which releases the
    # connection back to the pool.
    query = (
        "SELECT oal.id, oal.user_id, u.email AS user_email, oal.action, "
        "       oal.target_type, oal.target_id, oal.metadata, "
        "       oal.ip_address, oal.user_agent, oal.created_at, "
        "       oal.prev_hash, oal.entry_hash "
        "FROM org_audit_log oal "
        "JOIN users u ON u.id = oal.user_id "
        "WHERE oal.org_id = $1 "
        "ORDER BY oal.created_at"
    )

    csv_fields = [
        "id", "user_id", "user_email", "action", "target_type", "target_id",
        "metadata", "ip_address", "user_agent", "created_at", "prev_hash", "entry_hash",
    ]

    def _serialize(r: dict) -> str:
        if format == "jsonl":
            return _json.dumps(r, default=str) + "\n"
        # csv
        buf = _io.StringIO()
        writer = _csv.DictWriter(buf, fieldnames=csv_fields, extrasaction="ignore")
        writer.writerow(r)
        return buf.getvalue()

    async def _iter():
        if format == "csv":
            yield (",".join(csv_fields) + "\n").encode("utf-8")
        async for r in client.fetchiter(query, org_id):
            yield _serialize(r).encode("utf-8")

    return StreamingResponse(
        _iter(),
        media_type="application/jsonl" if format == "jsonl" else "text/csv",
    )
