"""Alert querying and acknowledgement REST API routes.

Provides endpoints for:

- Listing alerts for an organization
- Acknowledging single or batches of alerts
- Listing configured alert rules

The prior ``/jobs/{job_id}/trace/...`` and ``/jobs/{job_id}/hilt/...``
endpoints have been removed along with the jobs feature. Trace
replay now lives under ``/orgs/{org_id}/traces/{trace_id}/replay``
in :mod:`eden.api.routes.observability`.

All endpoints require authentication via Clerk session cookie
(or Clerk Bearer JWT for service-to-service callers).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user
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
    """List alerts for an organization.

    Query parameters:
      severity: Filter by severity (debug, info, warning, high, critical)
      acknowledged: Filter by acknowledged status
    """
    client = await get_postgres_client()
    orgs = await client.fetch(
        "SELECT org_id FROM org_members WHERE user_id = $1 AND org_id = $2",
        user["user_id"], org_id,
    )
    if not orgs:
        raise HTTPException(status_code=403, detail="Not a member of this organization")

    conditions = ["(metadata->>'is_alert')::boolean = true"]
    params: list[Any] = []
    param_idx = 1

    if severity:
        conditions.append(f"metadata->>'severity' = ${param_idx}")
        params.append(severity)
        param_idx += 1

    if acknowledged is not None:
        if acknowledged:
            conditions.append("read_at IS NOT NULL")
        else:
            conditions.append("read_at IS NULL")
        param_idx += 1

    where_clause = " AND ".join(conditions)

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
        SELECT id, user_id, type, title, body, data, read_at, created_at
        FROM notifications
        WHERE {where_clause}
        ORDER BY created_at DESC
        LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """,
        *params, limit, offset,
    )

    alerts = []
    for row in rows:
        metadata = row["data"]
        if isinstance(metadata, str):
            import json
            metadata = json.loads(metadata)
        alerts.append({
            "alert_id": row["id"],
            "title": row["title"],
            "message": row["body"] or "",
            "severity": metadata.get("severity", "info") if metadata else "info",
            "entity_id": metadata.get("entity_id", "") if metadata else "",
            "acknowledged": row["read_at"] is not None,
            "created_at": row["created_at"],
            "channels": metadata.get("channels", []) if metadata else [],
        })

    return AlertListResponse(alerts=alerts, total=total, unread_count=unread_count)


@router.post("/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(
    alert_id: str,
    user: dict[str, Any] = Depends(get_current_user),
):
    """Acknowledge an alert."""
    processor = await get_alert_processor()
    ok = await processor.acknowledge_alert(alert_id)

    client = await get_postgres_client()
    await client.execute(
        "UPDATE notifications SET read_at = NOW() WHERE id = $1",
        alert_id,
    )

    return {"status": "ok" if ok else "error", "alert_id": alert_id}


@router.post("/alerts/acknowledge-batch")
async def acknowledge_alerts_batch(
    req: AlertAcknowledgeRequest,
    user: dict[str, Any] = Depends(get_current_user),
):
    """Acknowledge multiple alerts at once."""
    processor = await get_alert_processor()
    client = await get_postgres_client()

    acknowledged = []
    for alert_id in req.alert_ids:
        ok = await processor.acknowledge_alert(alert_id)
        if ok:
            await client.execute(
                "UPDATE notifications SET read_at = NOW() WHERE id = $1",
                alert_id,
            )
            acknowledged.append(alert_id)

    return {"status": "ok", "acknowledged_count": len(acknowledged)}


@router.get("/orgs/{org_id}/alerts/rules")
async def list_alert_rules(
    org_id: str,
    user: dict[str, Any] = Depends(get_current_user),
):
    """List configured alert rules for an organization."""
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