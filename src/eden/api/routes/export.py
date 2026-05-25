"""Data export routes for GDPR compliance."""

import io
import json
import logging
import zipfile
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Cookie, Header
from fastapi.responses import StreamingResponse

from eden.api.deps import require_org_permission
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs", tags=["export"])


@router.get("/{org_id}/export")
async def export_org_data(
    org_id: str,
    authorization: Optional[str] = Cookie(None),
):
    """Export all organization data as a ZIP archive for GDPR compliance.

    Returns a ZIP file containing:
    - members.json: All organization members
    - references.json: All code references
    - jobs.json: All jobs (metadata only, not full results)
    - audit_log.json: Audit log entries
    - settings.json: Organization settings

    Requires audit:view permission (owner and admin only).
    """
    # Require audit:view permission
    await require_org_permission("audit:view", org_id)

    client = await get_postgres_client()

    # Create ZIP in memory
    zip_buffer = io.BytesIO()

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        # 1. Export members
        members_query = """
            SELECT om.user_id, om.role, om.joined_at, om.last_active_at,
                   u.email, u.name, u.created_at as user_created_at
            FROM org_members om
            JOIN users u ON u.id = om.user_id
            WHERE om.org_id = $1
            ORDER BY om.joined_at ASC
        """
        members_rows = await client.fetch(members_query, org_id)
        members_data = [
            {
                "user_id": str(r["user_id"]),
                "email": r["email"],
                "name": r["name"],
                "role": r["role"],
                "joined_at": r["joined_at"].isoformat() if r.get("joined_at") else None,
                "last_active_at": r["last_active_at"].isoformat() if r.get("last_active_at") else None,
                "user_created_at": r["user_created_at"].isoformat() if r.get("user_created_at") else None,
            }
            for r in members_rows
        ]
        zip_file.writestr(
            "members.json",
            json.dumps({"members": members_data, "exported_at": datetime.utcnow().isoformat()}, indent=2)
        )

        # 2. Export references
        references_query = """
            SELECT id, name, description, purpose, filename, language,
                   content, uploaded_by, created_at
            FROM code_references
            WHERE org_id = $1
            ORDER BY created_at DESC
        """
        ref_rows = await client.fetch(references_query, org_id)
        references_data = [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "description": r["description"],
                "purpose": r["purpose"],
                "filename": r["filename"],
                "language": r["language"],
                "content": r["content"],
                "uploaded_by": str(r["uploaded_by"]),
                "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
            }
            for r in ref_rows
        ]
        zip_file.writestr(
            "references.json",
            json.dumps({"references": references_data, "exported_at": datetime.utcnow().isoformat()}, indent=2)
        )

        # 3. Export jobs (metadata only)
        jobs_query = """
            SELECT job_id, request, status, current_stage, outcome_tier,
                   created_at, updated_at, completed_at
            FROM jobs
            WHERE org_id = $1
            ORDER BY created_at DESC
        """
        job_rows = await client.fetch(jobs_query, org_id)
        jobs_data = [
            {
                "job_id": r["job_id"],
                "request": r["request"],
                "status": r["status"],
                "current_stage": r["current_stage"],
                "outcome_tier": r.get("outcome_tier"),
                "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
                "updated_at": r["updated_at"].isoformat() if r.get("updated_at") else None,
                "completed_at": r["completed_at"].isoformat() if r.get("completed_at") else None,
            }
            for r in job_rows
        ]
        zip_file.writestr(
            "jobs.json",
            json.dumps({"jobs": jobs_data, "exported_at": datetime.utcnow().isoformat()}, indent=2)
        )

        # 4. Export audit log
        audit_query = """
            SELECT oal.id, oal.user_id, oal.action,
                   oal.target_type, oal.target_id, oal.metadata,
                   oal.ip_address, oal.user_agent, oal.created_at,
                   u.email as user_email, u.name as user_name
            FROM org_audit_log oal
            JOIN users u ON u.id = oal.user_id
            WHERE oal.org_id = $1
            ORDER BY oal.created_at DESC
            LIMIT 10000
        """
        audit_rows = await client.fetch(audit_query, org_id)
        audit_data = [
            {
                "id": str(r["id"]),
                "user_id": str(r["user_id"]),
                "user_email": r["user_email"],
                "user_name": r["user_name"],
                "action": r["action"],
                "target_type": r.get("target_type"),
                "target_id": r.get("target_id"),
                "metadata": r.get("metadata", {}),
                "ip_address": r.get("ip_address"),
                "user_agent": r.get("user_agent"),
                "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
            }
            for r in audit_rows
        ]
        zip_file.writestr(
            "audit_log.json",
            json.dumps({"audit_log": audit_data, "exported_at": datetime.utcnow().isoformat()}, indent=2)
        )

        # 5. Export organization settings
        org_query = """
            SELECT id, name, slug, owner_id, settings, created_at
            FROM organizations
            WHERE id = $1
        """
        org_row = await client.fetchrow(org_query, org_id)
        if org_row:
            settings_data = {
                "id": str(org_row["id"]),
                "name": org_row["name"],
                "slug": org_row["slug"],
                "owner_id": str(org_row["owner_id"]),
                "settings": org_row.get("settings", {}),
                "created_at": org_row["created_at"].isoformat() if org_row.get("created_at") else None,
            }
            zip_file.writestr(
                "settings.json",
                json.dumps({"organization": settings_data, "exported_at": datetime.utcnow().isoformat()}, indent=2)
            )

    # Prepare response
    zip_buffer.seek(0)

    org_name = org_row["name"] if org_row else org_id
    filename = f"{org_name.replace(' ', '_')}_export_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.zip"

    return StreamingResponse(
        iter([zip_buffer.getvalue()]),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )