"""Eden Public API v1 — Benchmark routes.

All responses are wrapped in the standard API envelope:
    {"data": <payload>, "meta": {"api_version": "...", "request_id": "...", "timestamp": "..."}}
"""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from eden.api.schemas.envelope import APIEnvelope, PaginatedAPIEnvelope
from eden.api.middleware.api_version import CURRENT_VERSION
from eden.api.middleware.correlation_id import get_correlation_id
from eden.api.routes.v1.common import get_v1_caller
from eden.benchmark_engine import BenchmarkEngine

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/benchmarks", tags=["v1-benchmarks"])

_benchmark_engine: BenchmarkEngine | None = None


def _get_benchmark_engine() -> BenchmarkEngine:
    global _benchmark_engine
    if _benchmark_engine is None:
        _benchmark_engine = BenchmarkEngine()
    return _benchmark_engine

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class V1BenchmarkCreateRequest(BaseModel):
    """Request schema for creating a benchmark via v1 API."""

    benchmark_name: str = Field(..., description="Name of the benchmark")
    target_agents: list[str] = Field(..., description="Target agent identifiers")
    criteria: dict = Field(default_factory=dict, description="Evaluation criteria")


class V1BenchmarkItem(BaseModel):
    """Benchmark item for v1 API."""

    benchmark_id: str
    benchmark_name: str
    message: str


class V1BenchmarkRunRequest(BaseModel):
    """Request schema for running a benchmark via v1 API."""

    target_code: Optional[str] = Field(None, description="Code to benchmark against")


class V1BenchmarkRunResult(BaseModel):
    """Benchmark run result for v1 API."""

    run_id: str
    benchmark_id: str
    status: str
    passed: bool
    scores: dict[str, float]


class V1BenchmarkResultDetail(BaseModel):
    """Benchmark result detail for v1 API."""

    benchmark_id: str
    run_id: str
    timestamp: str
    passed: bool
    scores: dict[str, float]
    details: Optional[dict] = None


class V1BenchmarkHistoryItem(BaseModel):
    """Benchmark history item for v1 API."""

    run_id: str
    benchmark_id: str
    status: str
    passed: bool
    scores: dict[str, float]
    timestamp: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("", response_model=APIEnvelope)
async def v1_create_benchmark(
    request: V1BenchmarkCreateRequest,
    background_tasks: BackgroundTasks,
    caller: dict = Depends(get_v1_caller),
):
    """Create a new benchmark definition."""
    engine = _get_benchmark_engine()

    benchmark_id = await engine.create_benchmark(
        target_agents=request.target_agents,
        criteria=request.criteria,
        benchmark_name=request.benchmark_name,
    )

    logger.info(f"Benchmark created via v1: {benchmark_id} by caller {caller.get('user_id')}")

    data = V1BenchmarkItem(
        benchmark_id=benchmark_id,
        benchmark_name=request.benchmark_name,
        message="Benchmark created successfully. Use POST /v1/benchmarks/{benchmark_id}/run to execute it.",
    )

    return APIEnvelope.wrap(
        data=data.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.post("/{benchmark_id}/run", response_model=APIEnvelope)
async def v1_run_benchmark(
    benchmark_id: str,
    request: V1BenchmarkRunRequest,
    background_tasks: BackgroundTasks,
    caller: dict = Depends(get_v1_caller),
):
    """Run a created benchmark."""
    if not request.target_code:
        raise HTTPException(status_code=400, detail="target_code is required")

    engine = _get_benchmark_engine()

    try:
        result = await engine.run_benchmark(
            benchmark_id=benchmark_id,
            target_code=request.target_code,
        )

        logger.info(f"Benchmark {benchmark_id} run via v1: passed={result.passed}")

        data = V1BenchmarkRunResult(
            run_id=result.run_id,
            benchmark_id=result.benchmark_id,
            status="completed",
            passed=result.passed,
            scores=result.scores,
        )

        return APIEnvelope.wrap(
            data=data.model_dump(),
            api_version=CURRENT_VERSION,
            request_id=get_correlation_id(),
        )
    except HTTPException:
        raise  # Let FastAPI HTTPExceptions propagate (404, 400, etc.)
    except Exception as e:
        logger.error(f"Benchmark run failed via v1: {e}")
        raise HTTPException(status_code=500, detail=f"Benchmark execution failed: {str(e)}")


@router.get("/{benchmark_id}/results", response_model=APIEnvelope)
async def v1_get_benchmark_results(
    benchmark_id: str,
    caller: dict = Depends(get_v1_caller),
):
    """Get benchmark results."""
    engine = _get_benchmark_engine()

    # Use the engine's public method to get the latest result
    result = engine.get_latest_result(benchmark_id)

    if not result:
        raise HTTPException(
            status_code=404,
            detail=f"No results found for benchmark {benchmark_id}",
        )

    data = V1BenchmarkResultDetail(
        benchmark_id=result.benchmark_id,
        run_id=result.run_id,
        timestamp=result.timestamp.isoformat(),
        passed=result.passed,
        scores=result.scores,
        details=result.details,
    )

    return APIEnvelope.wrap(
        data=data.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.get("/history", response_model=PaginatedAPIEnvelope)
async def v1_get_benchmark_history(
    caller: dict = Depends(get_v1_caller),
):
    """List past benchmark runs."""
    engine = _get_benchmark_engine()
    runs = engine.get_run_history()

    data = [
        V1BenchmarkHistoryItem(
            run_id=r.get("run_id", ""),
            benchmark_id=r.get("benchmark_id", ""),
            status=r.get("status", ""),
            passed=r.get("passed", False),
            scores=r.get("scores", {}),
            timestamp=r.get("timestamp", ""),
        )
        for r in runs
    ]

    total = len(data)

    return PaginatedAPIEnvelope.wrap(
        data=[d.model_dump() for d in data],
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
        total=total,
        page=1,
        per_page=total,
    )
