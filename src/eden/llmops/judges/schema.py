"""Phase 7.1b — Pydantic schemas for the judges API + judge_scores
table.

The table migration lives in
``src/eden/db_migrations/versions/010_judge_scores.py``; this file
holds the Pydantic models the API surfaces.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class JudgeRunRequest(BaseModel):
    """Request body for ``POST /orgs/{org_id}/observability/judges/run``."""

    trace_id: str = Field(..., description="The trace to score")
    judge_names: Optional[list[str]] = Field(
        None,
        description=(
            "Restrict to these judges. None = run all matching judges "
            "for the trace's events."
        ),
    )
    sync: bool = Field(
        True,
        description=(
            "If True, await each judge and return the scores in the "
            "response. If False, queue the work and return immediately "
            "with a job id."
        ),
    )


class JudgeScoreResponse(BaseModel):
    """One score in the API response."""

    judge_run_id: Optional[str] = None
    judge_name: str
    judge_version: str
    trace_id: str
    span_id: Optional[str] = None
    score: float
    rationale: Optional[str] = None
    model: str
    scored_at: datetime
    latency_ms: float = 0.0
    metadata: dict[str, Any] = Field(default_factory=dict)


class JudgeRunResponse(BaseModel):
    """Response body for ``POST /orgs/{org_id}/observability/judges/run``."""

    judge_runs: list[JudgeScoreResponse] = Field(default_factory=list)
    count: int = 0
    queued: bool = False
    job_id: Optional[str] = None


class JudgeListResponse(BaseModel):
    """Response body for ``GET /orgs/{org_id}/observability/judges``."""

    scores: list[JudgeScoreResponse] = Field(default_factory=list)
    total: int = 0
    limit: int = 100
    offset: int = 0
