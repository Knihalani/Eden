"""Job management routes for Eden API."""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks, Query
from pydantic import BaseModel, Field

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
    framework: str = Field(default="gymnasium", description="Target framework")
    framework_version: str = Field(default="0.29", description="Framework version")
    difficulty_parameters: dict = Field(default_factory=dict)
    output_mode: str = Field(default="gymnasium_mode")


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


@router.post("", response_model=JobResponse)
async def submit_job(request: JobRequest, background_tasks: BackgroundTasks):
    """Submit a new environment generation job."""
    import uuid
    job_id = str(uuid.uuid4())
    created_at = datetime.utcnow().isoformat()

    client = await get_postgres_client()
    await client.upsert_job(
        job_id=job_id,
        request=request.model_dump(),
        status="pending",
        current_stage="planning",
        created_at=created_at,
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


@router.get("/{job_id}", response_model=JobStatusResponse)
async def get_job_status(job_id: str):
    """Get job status."""
    client = await get_postgres_client()
    job = await client.get_job(job_id)

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
async def get_job_result(job_id: str):
    """Get job result."""
    client = await get_postgres_client()
    job = await client.get_job(job_id)

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
async def get_job_trace(job_id: str):
    """Get full job trace from checkpoint history."""
    client = await get_postgres_client()
    job = await client.get_job(job_id)

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


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str):
    """Cancel an in-progress job."""
    client = await get_postgres_client()
    job = await client.get_job(job_id)

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