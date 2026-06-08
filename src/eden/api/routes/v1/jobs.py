"""Eden Public API v1 — Job routes.

All responses are wrapped in the standard API envelope:
    {"data": <payload>, "meta": {"api_version": "...", "request_id": "...", "timestamp": "..."}}
"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from eden.api.schemas.envelope import APIEnvelope, PaginatedAPIEnvelope
from eden.api.middleware.api_version import CURRENT_VERSION
from eden.api.middleware.correlation_id import get_correlation_id
from eden.api.routes.v1.common import get_v1_caller
from eden.api.routes.jobs import (
    JobRequest as InternalJobRequest,
    _run_pipeline,
    stream_job_status,
    cancel_job,
)
from eden.storage.postgres import get_postgres_client


def _extract_user_id(caller: dict) -> str:
    """Extract a real user_id from the v1 caller for DB filtering.

    Cookie auth provides a real user UUID. API key auth provides a synthetic
    identifier (``apikey:<key_id>``) which will not match any existing jobs
    until the jobs table supports org-level scoping.
    """
    return caller["user_id"]

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/jobs", tags=["v1-jobs"])

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class V1JobCreateRequest(BaseModel):
    """Request schema for creating a job via v1 API."""

    description: str = Field(..., description="Natural language description of the environment")
    tags: list[str] = Field(default_factory=list, description="Optional tags to guide the Planner")
    difficulty_parameters: dict = Field(default_factory=dict)


class V1JobItem(BaseModel):
    """Job list item for v1 API."""

    job_id: str
    status: str
    current_stage: str
    outcome_tier: Optional[str] = None
    created_at: str
    updated_at: str


class V1JobStatus(BaseModel):
    """Job status for v1 API."""

    job_id: str
    status: str
    current_stage: str
    outcome_tier: Optional[str] = None
    created_at: str
    updated_at: str
    stage_history: list[dict] = Field(default_factory=list)


class V1JobResult(BaseModel):
    """Job result for v1 API."""

    job_id: str
    status: str
    outcome_tier: Optional[str] = None
    environment_code: Optional[str] = None
    test_results: Optional[dict] = None
    quality_report: Optional[dict] = None
    archivist_summary: Optional[dict] = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("", response_model=APIEnvelope)
async def v1_create_job(
    request: V1JobCreateRequest,
    background_tasks: BackgroundTasks,
    caller: dict = Depends(get_v1_caller),
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
):
    """Create a new environment generation job."""
    if caller["auth_method"] == "api_key":
        raise HTTPException(
            status_code=403,
            detail="Job creation via API key requires org-level scoping, which will be enabled in a future update. Please use cookie-based authentication.",
        )

    job_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    user_id = caller["user_id"]
    org_id = x_org_id or caller.get("current_org_id")

    client = await get_postgres_client()
    await client.upsert_job(
        job_id=job_id,
        request=request.model_dump(),
        status="pending",
        current_stage="planning",
        created_at=created_at,
        user_id=user_id,
    )

    internal_request = InternalJobRequest(
        description=request.description,
        tags=request.tags,
        difficulty_parameters=request.difficulty_parameters,
    )
    background_tasks.add_task(_run_pipeline, job_id, internal_request, user_id=user_id, org_id=org_id)

    data = V1JobItem(
        job_id=job_id,
        status="pending",
        current_stage="planning",
        created_at=created_at,
        updated_at=created_at,
    )

    return APIEnvelope.wrap(
        data=data.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.get("", response_model=PaginatedAPIEnvelope)
async def v1_list_jobs(
    status: Optional[str] = Query(None),
    outcome_tier: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="Search jobs by ID or description"),
    sort: Optional[str] = Query("created_at:desc"),
    created_after: Optional[str] = Query(None, description="ISO datetime"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    caller: dict = Depends(get_v1_caller),
):
    """List jobs for the authenticated user."""
    client = await get_postgres_client()
    user_id = _extract_user_id(caller)

    created_after_dt = None
    if created_after:
        try:
            created_after_dt = datetime.fromisoformat(created_after.replace("Z", "+00:00"))
        except ValueError:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail="Invalid created_after datetime format")

    jobs = await client.list_jobs(
        user_id=user_id,
        status=status,
        outcome_tier=outcome_tier,
        q=q,
        sort=sort,
        limit=limit,
        offset=offset,
        created_after=created_after_dt,
    )
    total = await client.count_jobs(
        user_id=user_id,
        status=status,
        outcome_tier=outcome_tier,
        q=q,
        created_after=created_after_dt,
    )

    data = [
        V1JobItem(
            job_id=j["job_id"],
            status=j["status"],
            current_stage=j["current_stage"],
            outcome_tier=j.get("outcome_tier"),
            created_at=j.get("created_at", ""),
            updated_at=j.get("updated_at", ""),
        )
        for j in jobs
    ]

    return PaginatedAPIEnvelope.wrap(
        data=[d.model_dump() for d in data],
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
        total=total,
        page=(offset // limit) + 1,
        per_page=limit,
    )


@router.get("/{job_id}", response_model=APIEnvelope)
async def v1_get_job(
    job_id: str,
    caller: dict = Depends(get_v1_caller),
):
    """Get job status."""
    client = await get_postgres_client()
    user_id = _extract_user_id(caller)

    job = await client.get_job(job_id, user_id=user_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    data = V1JobStatus(
        job_id=job["job_id"],
        status=job["status"],
        current_stage=job["current_stage"],
        outcome_tier=job.get("outcome_tier"),
        created_at=job.get("created_at", ""),
        updated_at=job.get("updated_at", ""),
        stage_history=job.get("stage_history", []),
    )

    return APIEnvelope.wrap(
        data=data.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.get("/{job_id}/result", response_model=APIEnvelope)
async def v1_get_job_result(
    job_id: str,
    caller: dict = Depends(get_v1_caller),
):
    """Get job result."""
    client = await get_postgres_client()
    user_id = _extract_user_id(caller)

    job = await client.get_job(job_id, user_id=user_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job["status"] not in ("completed", "failed", "human_review"):
        from fastapi import HTTPException
        raise HTTPException(
            status_code=202,
            detail=f"Job not yet completed. Current status: {job['status']}",
        )

    blobs = await client.get_checkpoint_blobs(job_id)
    blob_data = {b["field"]: b["value"] for b in blobs}

    data = V1JobResult(
        job_id=job["job_id"],
        status=job["status"],
        outcome_tier=job.get("outcome_tier"),
        environment_code=blob_data.get("final_res", {}).get("code"),
        test_results=blob_data.get("tester_results"),
        quality_report=blob_data.get("quality_report"),
        archivist_summary=blob_data.get("archivist_summary"),
    )

    return APIEnvelope.wrap(
        data=data.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.get("/{job_id}/stream")
async def v1_stream_job_status(job_id: str, caller: dict = Depends(get_v1_caller)):
    """Server-Sent Events stream of job status updates (v1).

    Streams job status changes until the job reaches a terminal state.
    """
    if caller["auth_method"] == "api_key":
        raise HTTPException(
            status_code=403,
            detail="SSE streaming via API key is not yet supported. Please use cookie-based authentication.",
        )
    return await stream_job_status(job_id, caller)


@router.post("/{job_id}/cancel", response_model=APIEnvelope)
async def v1_cancel_job(
    job_id: str,
    caller: dict = Depends(get_v1_caller),
):
    """Cancel an in-progress job."""
    if caller["auth_method"] == "api_key":
        raise HTTPException(
            status_code=403,
            detail="Job cancellation via API key is not yet supported. Please use cookie-based authentication.",
        )
    result = await cancel_job(job_id, caller)

    return APIEnvelope.wrap(
        data=result,
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )
