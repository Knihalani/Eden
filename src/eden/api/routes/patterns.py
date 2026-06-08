"""API routes for the Patterns page (Phase 7.2 C5).

GET  /orgs/{org_id}/observability/patterns — list clusters
GET  /orgs/{org_id}/observability/patterns/{pattern_id} — pattern detail
POST /orgs/{org_id}/observability/patterns/{pattern_id}/generate-env
                                                — kick off env generation
                                                for a coverage gap
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


@router.post("/{pattern_id}/generate-env")
async def generate_env_for_pattern(
    org_id: str = Path(...),
    pattern_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Kick off environment generation for a pattern's coverage gap.

    Reuses the existing Eden pipeline: the pattern's representative
    traces are summarized, the summary is fed to the spec generator,
    and a new environment is published to the marketplace.

    This is a thin wrapper today — the heavy lifting happens
    asynchronously via the existing job system. We return the new
    job_id immediately so the portal can show progress.
    """
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    # Look up the pattern
    row = await client.fetchrow(
        """
        SELECT topic_label, sample_count, representative_trace_ids
        FROM trace_patterns
        WHERE tenant_id = $1 AND pattern_id = $2
        """,
        org_id, pattern_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Pattern not found")
    # Create a job. The actual pipeline runs in the background.
    try:
        job_id = await client.fetchval(
            """
            INSERT INTO jobs (job_id, tenant_id, kind, status, payload, created_at)
            VALUES (gen_random_uuid()::text, $1, 'env_from_pattern', 'pending',
                    jsonb_build_object('pattern_id', $2::text, 'topic_label', $3, 'sample_traces', $4::text[]),
                    NOW())
            RETURNING job_id
            """,
            org_id, pattern_id, str(row["topic_label"]), list(row["representative_trace_ids"] or []),
        )
    except Exception as exc:
        logger.warning(f"generate_env failed to create job: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
    return {
        "job_id": str(job_id),
        "pattern_id": pattern_id,
        "status": "pending",
    }
