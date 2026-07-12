"""API routes for the Patterns page (Phase 7.2 C5).

GET  /orgs/{org_id}/observability/patterns — list clusters
GET  /orgs/{org_id}/observability/patterns/{pattern_id} — pattern detail
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel

from eden.api.deps import get_current_user
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/observability/patterns", tags=["patterns"])


class PatternOut(BaseModel):
    pattern_id: str
    name: str
    description: str | None = None
    topic_label: str
    coherence_score: float | None
    sample_count: int
    representative_trace_ids: list[str]
    first_seen: str
    last_seen: str
    status: str
    coverage: str  # "covered" | "partial" | "none"


def _coverage_from_metadata(metadata: dict | None) -> str:
    """Best-effort coverage classification. The metadata may include
    a ``coverage`` key set by the clusterer; fall back to 'unknown'
    if absent."""
    if not metadata:
        return "none"
    return str(metadata.get("coverage", "none"))


@router.get("", response_model=list[PatternOut])
async def list_patterns(
    org_id: str = Path(...),
    status: str = Query("active", description="active, archived, all"),
    user: dict = Depends(get_current_user),
) -> list[PatternOut]:
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    where_status = "AND status = 'active'" if status == "active" else ""
    rows = await client.fetch(
        f"""
        SELECT pattern_id, name, description, topic_label,
               coherence_score, sample_count, representative_trace_ids,
               first_seen, last_seen, status, metadata
        FROM trace_patterns
        WHERE tenant_id = $1 {where_status}
        ORDER BY sample_count DESC
        LIMIT 200
        """,
        org_id,
    )
    out: list[PatternOut] = []
    for r in rows:
        out.append(PatternOut(
            pattern_id=str(r["pattern_id"]),
            name=str(r["name"]),
            description=r["description"],
            topic_label=str(r["topic_label"]),
            coherence_score=float(r["coherence_score"]) if r["coherence_score"] is not None else None,
            sample_count=int(r["sample_count"]),
            representative_trace_ids=list(r["representative_trace_ids"] or []),
            first_seen=r["first_seen"].isoformat() if hasattr(r["first_seen"], "isoformat") else str(r["first_seen"]),
            last_seen=r["last_seen"].isoformat() if hasattr(r["last_seen"], "isoformat") else str(r["last_seen"]),
            status=str(r["status"]),
            coverage=_coverage_from_metadata(r.get("metadata")),
        ))
    return out


@router.get("/{pattern_id}", response_model=PatternOut)
async def get_pattern(
    org_id: str = Path(...),
    pattern_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> PatternOut:
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    r = await client.fetchrow(
        """
        SELECT pattern_id, name, description, topic_label,
               coherence_score, sample_count, representative_trace_ids,
               first_seen, last_seen, status, metadata
        FROM trace_patterns
        WHERE tenant_id = $1 AND pattern_id = $2
        """,
        org_id, pattern_id,
    )
    if not r:
        raise HTTPException(status_code=404, detail="Pattern not found")
    return PatternOut(
        pattern_id=str(r["pattern_id"]),
        name=str(r["name"]),
        description=r["description"],
        topic_label=str(r["topic_label"]),
        coherence_score=float(r["coherence_score"]) if r["coherence_score"] is not None else None,
        sample_count=int(r["sample_count"]),
        representative_trace_ids=list(r["representative_trace_ids"] or []),
        first_seen=r["first_seen"].isoformat() if hasattr(r["first_seen"], "isoformat") else str(r["first_seen"]),
        last_seen=r["last_seen"].isoformat() if hasattr(r["last_seen"], "isoformat") else str(r["last_seen"]),
        status=str(r["status"]),
        coverage=_coverage_from_metadata(r.get("metadata")),
    )
