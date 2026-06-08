"""Trace Replay and Human-in-the-Loop REST API routes.

Phase 6.2: Provides endpoints for:
- Retrieving and replaying trace events
- HILT command submission
- Alert querying and management

All endpoints require authentication via cookie.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user
from eden.realtime.trace_store import TraceEventStore, get_trace_store, TraceEvent
from eden.realtime.human_in_the_loop import HILTController, get_hilt_controller
from eden.realtime.alert_stream import AlertStreamProcessor, get_alert_processor, GeneratedAlert
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(tags=["realtime"])


# ── Pydantic schemas ──────────────────────────────────────────────────────

class TraceReplayResponse(BaseModel):
    entity_id: str
    events: list[dict[str, Any]]
    total_events: int
    from_sequence: int = 0
    summary: Optional[dict[str, Any]] = None


class HILTCommandRequest(BaseModel):
    command: str = Field(..., description="One of: pause, resume, step, inject, approve, reject, rewind, status")
    payload: dict[str, Any] = Field(default_factory=dict)


class HILTCommandResponse(BaseModel):
    status: str
    message: str
    state: Optional[dict[str, Any]] = None


class AlertListResponse(BaseModel):
    alerts: list[dict[str, Any]]
    total: int
    unread_count: int


class AlertAcknowledgeRequest(BaseModel):
    alert_ids: list[str]


# ── Trace Replay endpoints ───────────────────────────────────────────────

@router.get("/jobs/{job_id}/trace/replay")
async def get_trace_replay(
    job_id: str,
    from_sequence: int = Query(0, ge=0),
    to_sequence: Optional[int] = Query(None),
    limit: int = Query(1000, ge=1, le=5000),
    include_summary: bool = Query(False),
    user: dict[str, Any] = Depends(get_current_user),
):
    """Retrieve trace events for a job in replay order.

    Returns events from Redis (hot) and PostgreSQL (cold) merged in
    sequence order. Use `from_sequence` for pagination / resume.
    """
    client = await get_postgres_client()
    job = await client.get_job(job_id, user_id=user["user_id"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    store = await get_trace_store()
    events = await store.get_trace(
        entity_id=job_id,
        from_sequence=from_sequence,
        to_sequence=to_sequence,
        limit=limit,
    )

    summary = None
    if include_summary:
        summary = await store.get_trace_summary(job_id)

    return TraceReplayResponse(
        entity_id=job_id,
        events=[e.to_dict() for e in events],
        total_events=len(events),
        from_sequence=from_sequence,
        summary=summary,
    )


@router.get("/jobs/{job_id}/trace/summary")
async def get_trace_summary(
    job_id: str,
    user: dict[str, Any] = Depends(get_current_user),
):
    """Get a summary of a job trace: event count, duration, event types."""
    client = await get_postgres_client()
    job = await client.get_job(job_id, user_id=user["user_id"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    store = await get_trace_store()
    summary = await store.get_trace_summary(job_id)
    return summary


@router.delete("/jobs/{job_id}/trace")
async def delete_trace(
    job_id: str,
    user: dict[str, Any] = Depends(get_current_user),
):
    """Delete a job trace from Redis and PostgreSQL."""
    client = await get_postgres_client()
    job = await client.get_job(job_id, user_id=user["user_id"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    store = await get_trace_store()
    await store.delete_trace(job_id)
    return {"status": "ok", "message": "Trace deleted"}


# ── Human-in-the-Loop endpoints ──────────────────────────────────────────

@router.post("/jobs/{job_id}/hilt/command")
async def hilt_command(
    job_id: str,
    req: HILTCommandRequest,
    user: dict[str, Any] = Depends(get_current_user),
):
    """Submit a Human-in-the-Loop command for a running job.

    Commands:
      pause  – Pause pipeline execution
      resume – Resume from paused state
      step   – Execute one step then auto-pause
      inject – Inject a message into agent context
      approve/reject – Approve or reject a pending decision
      rewind – Rewind to a checkpoint
      status – Query current HILT state
    """
    client = await get_postgres_client()
    job = await client.get_job(job_id, user_id=user["user_id"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    controller = await get_hilt_controller()
    result = await controller.handle_command(
        job_id=job_id,
        user=user,
        command_type=req.command,
        payload=req.payload,
    )

    return HILTCommandResponse(
        status=result.get("status", "unknown"),
        message=result.get("message", ""),
        state=result.get("state"),
    )


@router.get("/jobs/{job_id}/hilt/state")
async def hilt_get_state(
    job_id: str,
    user: dict[str, Any] = Depends(get_current_user),
):
    """Get the current HILT state for a job."""
    client = await get_postgres_client()
    job = await client.get_job(job_id, user_id=user["user_id"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    controller = await get_hilt_controller()
    state = await controller.get_state(job_id)
    return state.to_dict()


@router.post("/jobs/{job_id}/hilt/cleanup")
async def hilt_cleanup(
    job_id: str,
    user: dict[str, Any] = Depends(get_current_user),
):
    """Clean up HILT state for a completed job."""
    client = await get_postgres_client()
    job = await client.get_job(job_id, user_id=user["user_id"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    controller = await get_hilt_controller()
    await controller.cleanup(job_id)
    return {"status": "ok", "message": "HILT state cleaned up"}


# ── Alert endpoints ────────────────────────────────────────────────────────

@router.get("/orgs/{org_id}/alerts")
async def list_alerts(
    org_id: str,
    severity: Optional[str] = Query(None),
    acknowledged: Optional[bool] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict[str, Any] = Depends(get_current_user),
):
    """List alerts for an organization.

    Query parameters:
      severity: Filter by severity (debug, info, warning, high, critical)
      acknowledged: Filter by acknowledged status
    """
    # Verify org membership
    client = await get_postgres_client()
    orgs = await client.fetch(
        "SELECT org_id FROM org_members WHERE user_id = $1 AND org_id = $2",
        user["user_id"], org_id,
    )
    if not orgs:
        raise HTTPException(status_code=403, detail="Not a member of this organization")

    # Query alerts from notifications table (alerts are stored as notifications)
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

    # Also mark notification as read
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
