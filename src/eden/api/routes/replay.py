"""Alert querying and acknowledgement REST API routes.

Provides endpoints for:

- Listing alerts for an organization
- Acknowledging single or batches of alerts
- Listing configured alert rules

All endpoints require authentication via Clerk session cookie
(or Clerk Bearer JWT for service-to-service callers).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from eden.api.deps import (
    eden_user_id_from_auth,
    get_current_user,
    resolve_eden_org_id,
)
from eden.realtime.alert_stream import get_alert_processor
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(tags=["alerts"])


# ── Pydantic schemas ──────────────────────────────────────────────────────

class AlertListResponse(BaseModel):
    alerts: list[dict[str, Any]]
    total: int
    unread_count: int


class AlertAcknowledgeRequest(BaseModel):
    alert_ids: list[str]


# ── Alert endpoints ────────────────────────────────────────────────────────

@router.get("/orgs/{org_id}/alerts")
async def list_alerts(
    org_id: str,
    severity: str | None = Query(None),
    acknowledged: bool | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict[str, Any] = Depends(get_current_user),
):
    """List in-app alerts for an organization (scoped to the caller)."""
    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Database unavailable")

    try:
        user_id = await eden_user_id_from_auth(user)
    except Exception as exc:
        logger.warning("list_alerts user resolve failed: %s", exc)
        raise HTTPException(status_code=503, detail="User lookup failed") from exc
    if not user_id:
        raise HTTPException(status_code=404, detail="User not found")

    # Resolve org in-line so DB blips become 503, not a fake "Organization not found".
    try:
        org_row = await client.fetchrow(
            """
            SELECT id FROM organizations
            WHERE id::text = $1 OR clerk_org_id::text = $1
            LIMIT 1
            """,
            org_id,
        )
    except Exception as exc:
        logger.warning("list_alerts org resolve failed org=%s: %s", org_id, exc)
        raise HTTPException(
            status_code=503, detail="Organization lookup failed"
        ) from exc
    if not org_row:
        raise HTTPException(status_code=404, detail="Organization not found")
    eden_org_id = str(org_row["id"])

    try:
        membership = await client.fetchrow(
            "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
            eden_org_id,
            user_id,
        )
    except Exception as exc:
        logger.warning("list_alerts membership query failed: %s", exc)
        raise HTTPException(status_code=503, detail="Membership lookup failed") from exc
    if not membership:
        raise HTTPException(status_code=403, detail="Not a member of this organization")

    conditions = [
        "user_id = $1",
        "org_id = $2",
        "(data->>'is_alert')::boolean = true",
    ]
    params: list[Any] = [user_id, eden_org_id]
    param_idx = 3

    if severity:
        conditions.append(f"data->>'severity' = ${param_idx}")
        params.append(severity)
        param_idx += 1

    if acknowledged is not None:
        if acknowledged:
            conditions.append("read_at IS NOT NULL")
        else:
            conditions.append("read_at IS NULL")

    where_clause = " AND ".join(conditions)

    try:
        count_row = await client.fetchrow(
            f"SELECT COUNT(*) as total FROM notifications WHERE {where_clause}",
            *params,
        )
        total = count_row["total"] if count_row else 0

        unread_row = await client.fetchrow(
            f"SELECT COUNT(*) as unread FROM notifications WHERE {where_clause} AND read_at IS NULL",
            *params,
        )
        unread_count = unread_row["unread"] if unread_row else 0

        rows = await client.fetch(
            f"""
            SELECT id, user_id, org_id, type, title, body, data, read_at, created_at
            FROM notifications
            WHERE {where_clause}
            ORDER BY created_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
            """,
            *params,
            limit,
            offset,
        )
    except Exception as exc:
        # Missing notifications table / schema drift → empty feed, not a hard 500/404.
        logger.warning("list_alerts query failed org=%s: %s", eden_org_id, exc)
        return {
            "alerts": [],
            "total": 0,
            "unread_count": 0,
            "limit": limit,
            "offset": offset,
        }

    alerts = []
    for row in rows:
        data = row["data"]
        if isinstance(data, str):
            data = json.loads(data)
        if not isinstance(data, dict):
            data = {}
        alerts.append({
            "alert_id": str(row["id"]),
            "title": row["title"],
            "message": row["body"] or "",
            "severity": data.get("severity", "info"),
            "entity_id": data.get("entity_id", ""),
            "acknowledged": row["read_at"] is not None,
            "acknowledged_at": row["read_at"].isoformat() if row["read_at"] else None,
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "channels": data.get("channels", []),
            "metadata": data,
        })

    return AlertListResponse(alerts=alerts, total=total, unread_count=unread_count)


@router.post("/orgs/{org_id}/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(
    org_id: str,
    alert_id: str,
    user: dict[str, Any] = Depends(get_current_user),
):
    """Acknowledge a single alert (IDOR-safe)."""
    client = await get_postgres_client()
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        raise HTTPException(status_code=404, detail="User not found")

    eden_org_id = await resolve_eden_org_id(org_id)
    if not eden_org_id:
        raise HTTPException(status_code=404, detail="Organization not found")

    result = await client.execute(
        """
        UPDATE notifications
        SET read_at = NOW()
        WHERE id = $1
          AND user_id = $2
          AND org_id = $3
          AND (data->>'is_alert')::boolean = true
          AND read_at IS NULL
        """,
        alert_id,
        user_id,
        eden_org_id,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Alert not found")

    processor = await get_alert_processor()
    await processor.acknowledge_alert(alert_id)

    return {"status": "ok", "alert_id": alert_id, "acknowledged": True}


@router.post("/orgs/{org_id}/alerts/acknowledge-batch")
async def acknowledge_alerts_batch(
    org_id: str,
    req: AlertAcknowledgeRequest,
    user: dict[str, Any] = Depends(get_current_user),
):
    """Acknowledge multiple alerts at once (IDOR-safe)."""
    client = await get_postgres_client()
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        raise HTTPException(status_code=404, detail="User not found")

    eden_org_id = await resolve_eden_org_id(org_id)
    if not eden_org_id:
        raise HTTPException(status_code=404, detail="Organization not found")

    processor = await get_alert_processor()
    acknowledged: list[str] = []

    for alert_id in req.alert_ids:
        result = await client.execute(
            """
            UPDATE notifications
            SET read_at = NOW()
            WHERE id = $1
              AND user_id = $2
              AND org_id = $3
              AND (data->>'is_alert')::boolean = true
              AND read_at IS NULL
            """,
            alert_id,
            user_id,
            eden_org_id,
        )
        if result != "UPDATE 0":
            await processor.acknowledge_alert(alert_id)
            acknowledged.append(alert_id)

    return {"status": "ok", "acknowledged_count": len(acknowledged), "alert_ids": acknowledged}


@router.get("/orgs/{org_id}/alerts/rules")
async def list_alert_rules(
    org_id: str,
    user: dict[str, Any] = Depends(get_current_user),
):
    """List configured alert rules for an organization."""
    client = await get_postgres_client()
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        raise HTTPException(status_code=404, detail="User not found")

    eden_org_id = await resolve_eden_org_id(org_id)
    if not eden_org_id:
        raise HTTPException(status_code=404, detail="Organization not found")

    membership = await client.fetchrow(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        eden_org_id,
        user_id,
    )
    if not membership:
        raise HTTPException(status_code=403, detail="Not a member of this organization")

    processor = await get_alert_processor()
    rules = processor.get_rules()
    return {"rules": [{
        "rule_id": r.rule_id,
        "name": r.name,
        "description": r.description,
        "event_types": r.event_types,
        "severity_threshold": r.severity_threshold.value,
        "channels": [c.value for c in r.channels],
        "enabled": r.enabled,
    } for r in rules]}
