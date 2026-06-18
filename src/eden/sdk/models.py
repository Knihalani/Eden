"""Eden SDK Pydantic models.

Auto-generated convenience models for the v1 API envelope and resource payloads.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Meta / Envelope
# ---------------------------------------------------------------------------

class APIMeta(BaseModel):
    """Metadata included in every API response."""

    model_config = ConfigDict(extra="ignore")

    api_version: str
    request_id: str
    timestamp: str


class PaginatedMeta(APIMeta):
    """Metadata for paginated responses."""

    model_config = ConfigDict(extra="ignore")

    total: int
    page: int
    per_page: int


class APIEnvelope(BaseModel):
    """Standard API response envelope."""

    model_config = ConfigDict(extra="ignore")

    data: dict[str, Any]
    meta: APIMeta


class PaginatedEnvelope(BaseModel):
    """Paginated API response envelope."""

    model_config = ConfigDict(extra="ignore")

    data: list[dict[str, Any]]
    meta: PaginatedMeta


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

class JobItem(BaseModel):
    """Job list item."""

    model_config = ConfigDict(extra="ignore")

    job_id: str
    status: str
    current_stage: str
    outcome_tier: str | None = None
    created_at: str
    updated_at: str


class JobStatus(JobItem):
    """Detailed job status."""

    model_config = ConfigDict(extra="ignore")

    stage_history: list[dict[str, Any]] = Field(default_factory=list)


class JobResult(BaseModel):
    """Job result."""

    model_config = ConfigDict(extra="ignore")

    job_id: str
    status: str
    outcome_tier: str | None = None
    environment_code: str | None = None
    test_results: dict[str, Any] | None = None
    quality_report: dict[str, Any] | None = None
    archivist_summary: dict[str, Any] | None = None


class JobCreateRequest(BaseModel):
    """Request to create a job."""

    model_config = ConfigDict(extra="ignore")

    description: str = Field(..., min_length=1, description="Natural language description")
    tags: list[str] = Field(default_factory=list)
    difficulty_parameters: dict[str, Any] = Field(default_factory=dict)


class JobCreateResponse(BaseModel):
    """Response from job creation."""

    model_config = ConfigDict(extra="ignore")

    job_id: str
    status: str
    message: str


# ---------------------------------------------------------------------------
# Environments
# ---------------------------------------------------------------------------

class EnvironmentItem(BaseModel):
    """Environment list item."""

    model_config = ConfigDict(extra="ignore")

    job_id: str
    status: str
    outcome_tier: str | None = None
    created_at: str
    updated_at: str


class EnvironmentDetail(BaseModel):
    """Environment detail."""

    model_config = ConfigDict(extra="ignore")

    job_id: str
    status: str
    current_stage: str
    outcome_tier: str | None = None
    environment_code: str | None = None
    test_results: dict[str, Any] | None = None
    quality_report: dict[str, Any] | None = None
    created_at: str
    updated_at: str


class EnvironmentVersion(BaseModel):
    """Environment code version."""

    model_config = ConfigDict(extra="ignore")

    iteration: int
    code: str
    timestamp: str
    trigger: str | None = None


class EnvironmentTestReport(BaseModel):
    """Environment test report."""

    model_config = ConfigDict(extra="ignore")

    job_id: str
    status: str
    verdict: str
    total_tests: int
    total_passed: int
    total_failed: int
    total_errors: int
    exploits_detected: int
    adversarial_issues: int
    mutation_score: float | None = None


# ---------------------------------------------------------------------------
# Benchmarks
# ---------------------------------------------------------------------------

class BenchmarkItem(BaseModel):
    """Benchmark item."""

    model_config = ConfigDict(extra="ignore")

    benchmark_id: str
    benchmark_name: str
    message: str


class BenchmarkRunRequest(BaseModel):
    """Request to run a benchmark."""

    model_config = ConfigDict(extra="ignore")

    target_code: str | None = None


class BenchmarkRunResult(BaseModel):
    """Benchmark run result."""

    model_config = ConfigDict(extra="ignore")

    run_id: str
    benchmark_id: str
    status: str
    passed: bool
    scores: dict[str, float]


class BenchmarkResultDetail(BaseModel):
    """Benchmark result detail."""

    model_config = ConfigDict(extra="ignore")

    benchmark_id: str
    run_id: str
    timestamp: str
    passed: bool
    scores: dict[str, float]
    details: dict[str, Any] | None = None


class BenchmarkHistoryItem(BaseModel):
    """Benchmark history item."""

    model_config = ConfigDict(extra="ignore")

    run_id: str
    benchmark_id: str
    status: str
    passed: bool
    scores: dict[str, float]
    timestamp: str


# ---------------------------------------------------------------------------
# Streaming Events
# ---------------------------------------------------------------------------

class StreamEvent(BaseModel):
    """Base streaming event."""

    model_config = ConfigDict(extra="ignore")

    event: str
    data: dict[str, Any]


class StatusEventData(BaseModel):
    """Status event payload."""

    model_config = ConfigDict(extra="ignore")

    job_id: str
    status: str
    current_stage: str
    outcome_tier: str | None = None
    stage_history: list[dict[str, Any]] = Field(default_factory=list)


class StageChangeEventData(BaseModel):
    """Stage change event payload."""

    model_config = ConfigDict(extra="ignore")

    from_stage: str = Field(..., alias="from")
    to_stage: str = Field(..., alias="to")
    at: str


class CodeFragmentEventData(BaseModel):
    """Code fragment event payload."""

    model_config = ConfigDict(extra="ignore")

    field: str
    code: str
    timestamp: str


class CompleteEventData(BaseModel):
    """Completion event payload."""

    model_config = ConfigDict(extra="ignore")

    status: str
    outcome_tier: str | None = None
