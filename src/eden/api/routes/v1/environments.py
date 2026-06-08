"""Eden Public API v1 — Environment routes.

Environments are the completed, verified outputs of jobs.
These routes provide access to environment code, downloads, tests, and versions.

All responses are wrapped in the standard API envelope:
    {"data": <payload>, "meta": {"api_version": "...", "request_id": "...", "timestamp": "..."}}
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from eden.api.schemas.envelope import APIEnvelope, PaginatedAPIEnvelope
from eden.api.middleware.api_version import CURRENT_VERSION
from eden.api.middleware.correlation_id import get_correlation_id
from eden.api.routes.v1.common import get_v1_caller
from eden.api.routes.jobs import download_job_zip, get_job_tests, get_job_versions
from eden.storage.postgres import get_postgres_client


def _extract_user_id(caller: dict) -> str:
    """Extract a real user_id from the v1 caller for DB filtering."""
    return caller["user_id"]

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/environments", tags=["v1-environments"])

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class V1EnvironmentItem(BaseModel):
    """Environment list item for v1 API."""

    job_id: str
    status: str
    outcome_tier: Optional[str] = None
    created_at: str
    updated_at: str


class V1EnvironmentDetail(BaseModel):
    """Environment detail for v1 API."""

    job_id: str
    status: str
    current_stage: str
    outcome_tier: Optional[str] = None
    environment_code: Optional[str] = None
    test_results: Optional[dict] = None
    quality_report: Optional[dict] = None
    created_at: str
    updated_at: str


class V1EnvironmentVersion(BaseModel):
    """Environment code version for v1 API."""

    iteration: int
    code: str
    timestamp: str
    trigger: Optional[str] = None


class V1EnvironmentTestReport(BaseModel):
    """Environment test report for v1 API."""

    job_id: str
    status: str
    verdict: str
    total_tests: int
    total_passed: int
    total_failed: int
    total_errors: int
    exploits_detected: int
    adversarial_issues: int
    mutation_score: Optional[float] = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("", response_model=PaginatedAPIEnvelope)
async def v1_list_environments(
    status: Optional[str] = Query(None),
    outcome_tier: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="Search by job ID or description"),
    sort: Optional[str] = Query("created_at:desc"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    caller: dict = Depends(get_v1_caller),
):
    """List completed environments for the authenticated user.

    Filters to jobs that have reached a terminal status and contain
    environment code.
    """
    client = await get_postgres_client()
    user_id = _extract_user_id(caller)

    # Environments are terminal-state jobs that have produced code
    jobs = await client.list_jobs(
        user_id=user_id,
        status=status,
        outcome_tier=outcome_tier,
        q=q,
        sort=sort,
        limit=limit,
        offset=offset,
    )
    total = await client.count_jobs(
        user_id=user_id,
        status=status,
        outcome_tier=outcome_tier,
        q=q,
    )

    data = [
        V1EnvironmentItem(
            job_id=j["job_id"],
            status=j["status"],
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
async def v1_get_environment(
    job_id: str,
    caller: dict = Depends(get_v1_caller),
):
    """Get a single environment by job ID."""
    client = await get_postgres_client()
    user_id = _extract_user_id(caller)

    job = await client.get_job(job_id, user_id=user_id)
    if not job:
        raise HTTPException(status_code=404, detail="Environment not found")

    blobs = await client.get_checkpoint_blobs(job_id)
    blob_data = {b["field"]: b["value"] for b in blobs}

    data = V1EnvironmentDetail(
        job_id=job["job_id"],
        status=job["status"],
        current_stage=job["current_stage"],
        outcome_tier=job.get("outcome_tier"),
        environment_code=blob_data.get("final_res", {}).get("code"),
        test_results=blob_data.get("tester_results"),
        quality_report=blob_data.get("quality_report"),
        created_at=job.get("created_at", ""),
        updated_at=job.get("updated_at", ""),
    )

    return APIEnvelope.wrap(
        data=data.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.get("/{job_id}/download")
async def v1_download_environment(
    job_id: str,
    caller: dict = Depends(get_v1_caller),
):
    """Download the generated environment as a ZIP file.

    Returns a ZIP archive containing the environment code files.
    """
    return await download_job_zip(job_id, caller)


@router.get("/{job_id}/tests", response_model=APIEnvelope)
async def v1_get_environment_tests(
    job_id: str,
    caller: dict = Depends(get_v1_caller),
):
    """Get structured test results for a completed environment."""
    report = await get_job_tests(job_id, caller)

    data = V1EnvironmentTestReport(
        job_id=report["job_id"],
        status=report["status"],
        verdict=report["verdict"],
        total_tests=report["summary"]["total_tests"],
        total_passed=report["summary"]["total_passed"],
        total_failed=report["summary"]["total_failed"],
        total_errors=report["summary"]["total_errors"],
        exploits_detected=report["summary"]["exploits_detected"],
        adversarial_issues=report["summary"]["adversarial_issues"],
        mutation_score=report["summary"].get("mutation_score"),
    )

    return APIEnvelope.wrap(
        data=data.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.get("/{job_id}/versions", response_model=PaginatedAPIEnvelope)
async def v1_get_environment_versions(
    job_id: str,
    caller: dict = Depends(get_v1_caller),
):
    """Get version history for an environment."""
    versions = await get_job_versions(job_id, caller)

    data = [
        V1EnvironmentVersion(
            iteration=v.iteration,
            code=v.code,
            timestamp=v.timestamp,
            trigger=v.trigger,
        )
        for v in versions
    ]

    return PaginatedAPIEnvelope.wrap(
        data=[d.model_dump() for d in data],
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
        total=len(data),
        page=1,
        per_page=len(data),
    )
