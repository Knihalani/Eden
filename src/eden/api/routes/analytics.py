"""Organization analytics routes for Eden API."""

import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query

from eden.api.deps import get_current_user, require_org_permission
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/analytics", tags=["analytics"])


@router.get("", response_model=dict)
async def get_org_analytics(
    org_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
):
    """Get analytics for an organization.

    Returns usage statistics including job counts over time, reference upload
    trends, member activity, and storage usage.
    """
    # Require audit:view permission (owner/admin)
    await require_org_permission("audit:view", org_id)

    client = await get_postgres_client()
    now = datetime.utcnow()
    start_date = now - timedelta(days=days)

    # Job counts by day
    job_counts_query = """
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM jobs
        WHERE org_id = $1 AND created_at >= $2
        GROUP BY DATE(created_at)
        ORDER BY day ASC
    """
    job_counts_rows = await client.fetch(job_counts_query, org_id, start_date)
    job_counts_by_day = [
        {"date": row["day"].isoformat(), "count": row["count"]}
        for row in job_counts_rows
    ]

    # Reference uploads by day
    ref_uploads_query = """
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM code_references
        WHERE org_id = $1 AND created_at >= $2
        GROUP BY DATE(created_at)
        ORDER BY day ASC
    """
    ref_uploads_rows = await client.fetch(ref_uploads_query, org_id, start_date)
    reference_uploads_by_day = [
        {"date": row["day"].isoformat(), "count": row["count"]}
        for row in ref_uploads_rows
    ]

    # Active members count (members with activity in the period)
    active_members_query = """
        SELECT COUNT(DISTINCT user_id) as count
        FROM org_members
        WHERE org_id = $1 AND last_active_at >= $2
    """
    active_members_count = await client.fetchval(active_members_query, org_id, start_date) or 0

    # Total references count
    total_references_query = """
        SELECT COUNT(*) as count
        FROM code_references
        WHERE org_id = $1
    """
    total_references = await client.fetchval(total_references_query, org_id) or 0

    # Storage bytes used (estimated from content length)
    storage_query = """
        SELECT COALESCE(SUM(LENGTH(content)), 0) as bytes
        FROM code_references
        WHERE org_id = $1
    """
    storage_bytes_used = await client.fetchval(storage_query, org_id) or 0

    # Member activity (last_active_at for all members)
    member_activity_query = """
        SELECT om.user_id, om.role, om.joined_at, om.last_active_at,
               u.email, u.name
        FROM org_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1
        ORDER BY om.last_active_at DESC NULLS LAST
    """
    member_activity_rows = await client.fetch(member_activity_query, org_id)
    member_activity = [
        {
            "user_id": str(row["user_id"]),
            "email": row["email"],
            "name": row["name"],
            "role": row["role"],
            "joined_at": row["joined_at"].isoformat() if row.get("joined_at") else None,
            "last_active_at": row["last_active_at"].isoformat() if row.get("last_active_at") else None,
        }
        for row in member_activity_rows
    ]

    return {
        "job_counts_by_day": job_counts_by_day,
        "reference_uploads_by_day": reference_uploads_by_day,
        "active_members_count": active_members_count,
        "total_references": total_references,
        "storage_bytes_used": storage_bytes_used,
        "member_activity": member_activity,
    }
