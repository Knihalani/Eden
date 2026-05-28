"""Job management routes for Eden API."""

import asyncio
import json
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks, Query, Depends
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from eden.api.deps import get_current_user, get_current_org_api_key
from eden.api.routes.billing import check_limit
from eden.config import get_settings
from eden.pipeline.state import create_initial_state
from eden.pipeline.graph import compile_eden_graph
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/jobs", tags=["jobs"])

# Global graph reference (set on startup)
eden_graph = None


def set_eden_graph(graph):
    """Set the global eden_graph reference."""
    global eden_graph
    eden_graph = graph


class JobRequest(BaseModel):
    """Request schema for job submission."""

    description: str = Field(..., description="Natural language description of the environment")
    tags: list[str] = Field(default_factory=list, description="Optional tags to guide the Planner")
    difficulty_parameters: dict = Field(default_factory=dict)


class JobResponse(BaseModel):
    """Response schema for job submission."""

    job_id: str
    status: str
    message: str


class JobStatusResponse(BaseModel):
    """Response schema for job status."""

    job_id: str
    status: str
    current_stage: str
    outcome_tier: Optional[str] = None
    created_at: str
    updated_at: str
    stage_history: list[dict] = Field(default_factory=list)


class JobResultResponse(BaseModel):
    """Response schema for job result."""

    job_id: str
    status: str
    outcome_tier: Optional[str] = None
    environment_code: Optional[str] = None
    test_results: Optional[dict] = None
    quality_report: Optional[dict] = None
    archivist_summary: Optional[dict] = None


class JobListResponse(BaseModel):
    """Response schema for job listing."""

    jobs: list[dict]
    total: int
    limit: int
    offset: int


# Track last-seen checkpoint blobs per job for SSE streaming
_job_stream_blobs: dict[str, set[tuple[str, str]]] = {}


TERMINAL_STATUSES = {"completed", "failed", "cancelled", "human_review"}


@router.post("", response_model=JobResponse)
async def submit_job(
    request: JobRequest,
    background_tasks: BackgroundTasks,
    user: dict = get_current_user,
):
    """Submit a new environment generation job."""
    import uuid

    # Get org_id from user context (if available via header)
    from fastapi import Header
    x_org_id = None  # Would need to get from header in actual implementation

    # Note: Job limits are checked per-org when org context is available
    # For user-level jobs, we use user_id directly

    job_id = str(uuid.uuid4())
    created_at = datetime.utcnow().isoformat()
    user_id = user["user_id"]

    client = await get_postgres_client()
    await client.upsert_job(
        job_id=job_id,
        request=request.model_dump(),
        status="pending",
        current_stage="planning",
        created_at=created_at,
        user_id=user_id,
    )

    background_tasks.add_task(_run_pipeline, job_id, request)

    return JobResponse(
        job_id=job_id,
        status="pending",
        message="Job submitted successfully. Use GET /jobs/{job_id} to check status.",
    )


async def _run_pipeline(job_id: str, request: JobRequest) -> None:
    """Run the Eden pipeline for a job (background task)."""
    global eden_graph

    client = await get_postgres_client()

    try:
        await client.update_job_status(job_id, "running", "planning")
    except Exception as e:
        logger.warning(f"Failed to update job status to running: {e}")

    if eden_graph is None:
        logger.warning(f"Pipeline not available for job {job_id}")
        await client.update_job_status(job_id, "failed", "planning")
        return

    try:
        state = create_initial_state(job_id, request.model_dump())
        config = {"configurable": {"thread_id": job_id}}
        final_state = await eden_graph.ainvoke(state, config)

        outcome_tier = final_state.get("outcome_tier")
        current_stage = final_state.get("current_stage", "completed")

        # Determine final status
        if current_stage == "human_review":
            final_status = "human_review"
        elif outcome_tier:
            final_status = "completed"
        else:
            final_status = current_stage

        await client.update_job_status(job_id, final_status, current_stage, outcome_tier)

        # Store stage history
        routing_history = final_state.get("routing_history", [])
        if routing_history:
            await client.update_job_stage_history(job_id, routing_history)

        # Store final code and results as checkpoint blobs
        if final_state.get("res"):
            await client.insert_checkpoint_blob(job_id, "final_res", final_state["res"])
        if final_state.get("archivist_summary"):
            await client.insert_checkpoint_blob(job_id, "archivist_summary", final_state["archivist_summary"])

        logger.info(f"Job {job_id} completed: {final_status} / {outcome_tier}")

    except Exception as e:
        logger.error(f"Pipeline error for job {job_id}: {e}")
        await client.update_job_status(job_id, "failed", "planning")


@router.get("", response_model=JobListResponse)
async def list_jobs(
    status: Optional[str] = Query(None),
    outcome_tier: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="Search jobs by ID or description"),
    sort: Optional[str] = Query("created_at:desc", description="Sort field:direction, e.g. created_at:desc"),
    created_after: Optional[str] = Query(None, description="ISO datetime — only jobs created on or after this time"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: dict = get_current_user,
):
    """List jobs for the authenticated user."""
    client = await get_postgres_client()
    user_id = user["user_id"]

    created_after_dt = None
    if created_after:
        try:
            created_after_dt = datetime.fromisoformat(created_after.replace("Z", "+00:00"))
        except ValueError:
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

    return JobListResponse(
        jobs=[
            {
                "job_id": j["job_id"],
                "status": j["status"],
                "current_stage": j["current_stage"],
                "outcome_tier": j.get("outcome_tier"),
                "created_at": j.get("created_at"),
                "updated_at": j.get("updated_at"),
            }
            for j in jobs
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{job_id}", response_model=JobStatusResponse)
async def get_job_status(job_id: str, user: dict = get_current_user):
    """Get job status."""
    client = await get_postgres_client()
    user_id = user["user_id"]

    job = await client.get_job(job_id, user_id=user_id)

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    return JobStatusResponse(
        job_id=job["job_id"],
        status=job["status"],
        current_stage=job["current_stage"],
        outcome_tier=job.get("outcome_tier"),
        created_at=job.get("created_at", ""),
        updated_at=job.get("updated_at", ""),
        stage_history=job.get("stage_history", []),
    )


@router.get("/{job_id}/result", response_model=JobResultResponse)
async def get_job_result(job_id: str, user: dict = get_current_user):
    """Get job result."""
    client = await get_postgres_client()
    user_id = user["user_id"]

    job = await client.get_job(job_id, user_id=user_id)

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job["status"] not in ("completed", "failed", "human_review"):
        raise HTTPException(
            status_code=202,
            detail=f"Job not yet completed. Current status: {job['status']}",
        )

    # Retrieve checkpoint blobs for full result
    blobs = await client.get_checkpoint_blobs(job_id)
    blob_data = {b["field"]: b["value"] for b in blobs}

    return JobResultResponse(
        job_id=job["job_id"],
        status=job["status"],
        outcome_tier=job.get("outcome_tier"),
        environment_code=blob_data.get("final_res", {}).get("code"),
        test_results=blob_data.get("tester_results"),
        quality_report=blob_data.get("quality_report"),
        archivist_summary=blob_data.get("archivist_summary"),
    )


@router.get("/{job_id}/trace")
async def get_job_trace(job_id: str, user: dict = get_current_user):
    """Get full job trace from checkpoint history."""
    client = await get_postgres_client()
    user_id = user["user_id"]

    job = await client.get_job(job_id, user_id=user_id)

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    blobs = await client.get_checkpoint_blobs(job_id)

    # Build trace from checkpoint blobs
    trace_entries = []
    for blob in blobs:
        trace_entries.append({
            "field": blob["field"],
            "timestamp": blob.get("created_at"),
        })

    return {
        "job_id": job_id,
        "status": job["status"],
        "current_stage": job["current_stage"],
        "trace_entries": trace_entries,
        "checkpoint_count": len(blobs),
    }


class JobVersionResponse(BaseModel):
    """Response schema for a single code version."""

    iteration: int
    code: str
    timestamp: str
    trigger: Optional[str] = None


@router.get("/{job_id}/versions", response_model=list[JobVersionResponse])
async def get_job_versions(job_id: str, user: dict = get_current_user):
    """Get version history for a job from code_history and code: checkpoints.

    Returns code snapshots with metadata from job record and checkpoint blobs.
    """
    client = await get_postgres_client()
    user_id = user["user_id"]

    job = await client.get_job(job_id, user_id=user_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    blobs = await client.get_checkpoint_blobs(job_id)

    # Collect code:* checkpoints as versions
    code_blobs = [b for b in blobs if b["field"].startswith("code:")]
    job_created = job.get("created_at", "")
    code_history = job.get("code_history", [])

    # If code_history exists in job record, use it as fallback
    versions: list[JobVersionResponse] = []

    for i, blob in enumerate(code_blobs):
        versions.append(JobVersionResponse(
            iteration=i + 1,
            code=blob["value"] if isinstance(blob["value"], str) else json.dumps(blob["value"]),
            timestamp=blob.get("created_at", job_created),
            trigger="executor",
        ))

    # Fall back to job.code_history if no code: blobs found
    if not versions and code_history:
        for i, code in enumerate(code_history):
            versions.append(JobVersionResponse(
                iteration=i + 1,
                code=code,
                timestamp=job_created,
                trigger="executor",
            ))

    return versions


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str, user: dict = get_current_user):
    """Cancel an in-progress job."""
    client = await get_postgres_client()
    user_id = user["user_id"]

    job = await client.get_job(job_id, user_id=user_id)

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job["status"] in ("completed", "failed", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel job with status: {job['status']}",
        )

    # Store cancel flag as checkpoint blob
    await client.insert_checkpoint_blob(job_id, "_interrupt", {
        "requested": True,
        "at": datetime.utcnow().isoformat(),
    })

    await client.update_job_status(job_id, "cancelled", job["current_stage"])

    return {"job_id": job_id, "status": "cancelled", "message": "Cancel requested"}


@router.get("/{job_id}/stream")
async def stream_job_status(job_id: str, user: dict = get_current_user):
    """Server-Sent Events stream of job status updates.

    Streams job status changes until the job reaches a terminal state
    or the client disconnects.

    Emits events: status, stage_change, complete, error, code_fragment, message.
    """
    user_id = user["user_id"]

    async def event_generator():
        client = await get_postgres_client()
        last_stage = None
        last_status = None
        last_blob_keys: set[tuple[str, str]] = set()

        while True:
            job = await client.get_job(job_id, user_id=user_id)

            if not job:
                yield {
                    "event": "error",
                    "data": "Job not found",
                }
                break

            current_stage = job["current_stage"]
            current_status = job["status"]

            # Send status update if changed
            if current_stage != last_stage or current_status != last_status:
                yield {
                    "event": "status",
                    "data": {
                        "job_id": job_id,
                        "status": current_status,
                        "current_stage": current_stage,
                        "outcome_tier": job.get("outcome_tier"),
                        "stage_history": job.get("stage_history", []),
                    },
                }
                last_stage = current_stage
                last_status = current_status

            # Send stage change events
            if current_stage != last_stage and last_stage is not None:
                yield {
                    "event": "stage_change",
                    "data": {
                        "from": last_stage,
                        "to": current_stage,
                        "at": job.get("updated_at", datetime.utcnow().isoformat()),
                    },
                }

            # Detect new checkpoint blobs and emit code_fragment events
            try:
                blobs = await client.get_checkpoint_blobs(job_id)
                current_blob_keys = {(b["field"], b.get("created_at", "")) for b in blobs}
                new_blob_keys = current_blob_keys - last_blob_keys

                for field, ts in new_blob_keys:
                    blob_map = {b["field"]: b["value"] for b in blobs}
                    value = blob_map.get(field)

                    if field.startswith("code:"):
                        # Emit code fragment for code checkpoints
                        yield {
                            "event": "code_fragment",
                            "data": {
                                "field": field,
                                "code": value if isinstance(value, str) else "",
                                "timestamp": ts,
                            },
                        }
                    elif field in ("edp", "edp_history", "res", "final_res", "quality_report", "tester_results"):
                        # Emit message for significant state changes
                        yield {
                            "event": "message",
                            "data": {
                                "text": f"New data available: {field}",
                                "field": field,
                                "timestamp": ts,
                            },
                        }
                    elif field == "executor_pass":
                        # Multi-section generation progress
                        pass_data = value if isinstance(value, dict) else {}
                        yield {
                            "event": "code_gen",
                            "data": {
                                "text": pass_data.get("description", "Generating code..."),
                                "pass_number": pass_data.get("pass_number"),
                                "pass_name": pass_data.get("pass_name"),
                            },
                        }

                last_blob_keys = current_blob_keys
            except Exception:
                pass  # Non-fatal during streaming

            # Check for terminal state
            if current_status in TERMINAL_STATUSES:
                yield {
                    "event": "complete",
                    "data": {
                        "status": current_status,
                        "outcome_tier": job.get("outcome_tier"),
                    },
                }
                break

            # Wait before next poll
            await asyncio.sleep(2)

        return

    return EventSourceResponse(event_generator())