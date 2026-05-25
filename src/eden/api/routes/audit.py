"""Audit log routes for Eden API."""

import logging
from typing import Optional

from fastapi import APIRouter, Query, Cookie, Header
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_org_permission
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs", tags=["audit"])


class AuditLogEntry(BaseModel):
    """Single audit log entry."""
    id: str
    org_id: str
    user_id: str
    action: str
    target_type: Optional[str]
    target_id: Optional[str]
    metadata: dict
    ip_address: Optional[str]
    user_agent: Optional[str]
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
    action: Optional[str] = Query(None, description="Filter by action type (e.g., 'member.invited')"),
    user_id: Optional[str] = Query(None, description="Filter by user ID"),
    from_date: Optional[str] = Query(None, description="Filter from date (ISO format)"),
    to_date: Optional[str] = Query(None, description="Filter to date (ISO format)"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
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