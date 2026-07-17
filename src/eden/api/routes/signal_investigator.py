"""F06 — signal investigator API (definitions events, clusters, backfill)."""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user
from eden.api.utils.safe_error import safe_detail
from eden.signals.backfill import (
    enqueue_backfill,
    estimate_backfill_cost,
    get_backfill_job,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["signal-investigator"],
    dependencies=[Depends(get_current_user)],
)


class BackfillRequest(BaseModel):
    window_days: int = Field(default=7, ge=1, le=30)


class ResolveClusterRequest(BaseModel):
    status: str = Field(default="resolved", pattern="^(resolved|reopened)$")


@router.get("/signals/{signal_id}/events")
async def list_signal_events(
    org_id: str = Path(...),
    signal_id: str = Path(...),
    matched: bool | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    pg = await get_postgres_client()
    if pg is None:
        raise HTTPException(status_code=503, detail="database unavailable")
    clauses = ["org_id = $1", "signal_id = $2"]
    args: list[Any] = [org_id, signal_id]
    if matched is not None:
        args.append(matched)
        clauses.append(f"matched = ${len(args)}")
    try:
        rows = await pg.fetch(
            f"""
            SELECT id, trace_id, matched, payload, investigator_confidence,
                   detected_at
            FROM signal_events
            WHERE {' AND '.join(clauses)}
            ORDER BY detected_at DESC
            LIMIT ${len(args) + 1}
            """,
            *args,
            limit,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503, detail=safe_detail(exc, fallback="events unavailable")
        ) from None
    events = []
    for r in rows:
        payload = r["payload"]
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except (TypeError, ValueError):
                payload = {}
        events.append(
            {
                "id": str(r["id"]),
                "trace_id": str(r["trace_id"]),
                "matched": bool(r["matched"]),
                "payload": payload,
                "confidence": float(r["investigator_confidence"] or 0.0),
                "detected_at": r["detected_at"].isoformat()
                if hasattr(r["detected_at"], "isoformat")
                else str(r["detected_at"]),
            }
        )
    return {"status": "ok", "events": events, "count": len(events)}


@router.get("/signal-clusters")
async def list_signal_clusters(
    org_id: str = Path(...),
    signal_id: str | None = Query(None),
    status: str = Query("open"),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    pg = await get_postgres_client()
    if pg is None:
        raise HTTPException(status_code=503, detail="database unavailable")
    clauses = ["org_id = $1"]
    args: list[Any] = [org_id]
    if signal_id:
        args.append(signal_id)
        clauses.append(f"signal_id = ${len(args)}")
    if status != "all":
        args.append(status)
        clauses.append(f"status = ${len(args)}")
    try:
        rows = await pg.fetch(
            f"""
            SELECT id, signal_id, name, status, event_count, first_seen,
                   last_seen, sample_trace_ids
            FROM signal_clusters
            WHERE {' AND '.join(clauses)}
            ORDER BY last_seen DESC NULLS LAST
            LIMIT 200
            """,
            *args,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503, detail=safe_detail(exc, fallback="clusters unavailable")
        ) from None
    clusters = [
        {
            "id": str(r["id"]),
            "signal_id": str(r["signal_id"]),
            "name": r["name"],
            "status": r["status"],
            "event_count": int(r["event_count"] or 0),
            "first_seen": r["first_seen"].isoformat()
            if r.get("first_seen") and hasattr(r["first_seen"], "isoformat")
            else None,
            "last_seen": r["last_seen"].isoformat()
            if r.get("last_seen") and hasattr(r["last_seen"], "isoformat")
            else None,
            "sample_trace_ids": list(r["sample_trace_ids"] or []),
        }
        for r in rows
    ]
    return {"status": "ok", "clusters": clusters}


@router.post("/signal-clusters/{cluster_id}/resolve")
async def resolve_signal_cluster(
    body: ResolveClusterRequest,
    org_id: str = Path(...),
    cluster_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    pg = await get_postgres_client()
    if pg is None:
        raise HTTPException(status_code=503, detail="database unavailable")
    try:
        res = await pg.execute(
            """
            UPDATE signal_clusters
            SET status = $3, updated_at = NOW()
            WHERE org_id = $1 AND id = $2
            """,
            org_id,
            cluster_id,
            body.status,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503, detail=safe_detail(exc, fallback="resolve failed")
        ) from None
    if int(str(res).strip().split()[-1] or 0) == 0:
        raise HTTPException(status_code=404, detail="cluster not found")
    return {"status": "ok", "cluster_id": cluster_id, "new_status": body.status}


@router.post("/signals/{signal_id}/backfill")
async def start_signal_backfill(
    body: BackfillRequest,
    org_id: str = Path(...),
    signal_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    try:
        job = await enqueue_backfill(
            org_id, signal_id, window_days=body.window_days
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503, detail=safe_detail(exc, fallback="backfill unavailable")
        ) from None
    return {"status": "ok", "backfill": job}


@router.get("/signals/{signal_id}/backfill/{job_id}")
async def get_signal_backfill_status(
    org_id: str = Path(...),
    signal_id: str = Path(...),
    job_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    job = await get_backfill_job(org_id, signal_id, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="backfill job not found")
    return {"status": "ok", "backfill": job}


@router.get("/signals/{signal_id}/backfill-estimate")
async def signal_backfill_estimate(
    org_id: str = Path(...),
    signal_id: str = Path(...),
    window_days: int = Query(7, ge=1, le=30),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    _ = (user, signal_id)
    from eden.signals.backfill import count_traces_in_window

    count = await count_traces_in_window(org_id, window_days=window_days)
    return {
        "status": "ok",
        "backfill_estimate": count,
        "window_days": window_days,
        "estimated_cost_usd": estimate_backfill_cost(count),
    }
