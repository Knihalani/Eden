"""Benchmark routes for Eden API."""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel

from eden.api.deps import get_current_user
from eden.benchmark_engine import BenchmarkEngine
from eden.agents.benchmark.benchmark_runner import BenchmarkResult

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/benchmark", tags=["benchmark"])

# Global benchmark engine instance
_benchmark_engine: Optional[BenchmarkEngine] = None


def get_benchmark_engine() -> BenchmarkEngine:
    """Get or create the global benchmark engine instance."""
    global _benchmark_engine
    if _benchmark_engine is None:
        _benchmark_engine = BenchmarkEngine()
    return _benchmark_engine


class BenchmarkCreateRequest(BaseModel):
    """Request schema for creating a benchmark."""

    benchmark_name: str
    target_agents: list[str]
    criteria: dict


class BenchmarkRunRequest(BaseModel):
    """Request schema for running a benchmark."""

    benchmark_id: str
    target_code: Optional[str] = None


class BenchmarkCreateResponse(BaseModel):
    """Response schema for benchmark creation."""

    benchmark_id: str
    message: str


class BenchmarkRunResponse(BaseModel):
    """Response schema for benchmark run."""

    run_id: str
    benchmark_id: str
    status: str
    passed: bool
    scores: dict[str, float]


class BenchmarkHistoryResponse(BaseModel):
    """Response schema for benchmark history."""

    runs: list[dict]
    total: int


@router.post("/create", response_model=BenchmarkCreateResponse)
async def create_benchmark(
    request: BenchmarkCreateRequest,
    background_tasks: BackgroundTasks,
    user: dict = get_current_user,
):
    """Create a new benchmark definition."""
    engine = get_benchmark_engine()

    benchmark_id = await engine.create_benchmark(
        target_agents=request.target_agents,
        criteria=request.criteria,
        benchmark_name=request.benchmark_name,
    )

    logger.info(f"Benchmark created: {benchmark_id} by user {user.get('user_id')}")

    return BenchmarkCreateResponse(
        benchmark_id=benchmark_id,
        message="Benchmark created successfully. Use POST /benchmark/run/{benchmark_id} to execute it.",
    )


@router.post("/run/{benchmark_id}", response_model=BenchmarkRunResponse)
async def run_benchmark(
    benchmark_id: str,
    request: BenchmarkRunRequest,
    background_tasks: BackgroundTasks,
    user: dict = get_current_user,
):
    """Run a created benchmark."""
    engine = get_benchmark_engine()

    if not request.target_code:
        raise HTTPException(status_code=400, detail="target_code is required")

    try:
        result = await engine.run_benchmark(
            benchmark_id=benchmark_id,
            target_code=request.target_code,
        )

        logger.info(f"Benchmark {benchmark_id} run completed: passed={result.passed}")

        return BenchmarkRunResponse(
            run_id=result.run_id,
            benchmark_id=result.benchmark_id,
            status="completed",
            passed=result.passed,
            scores=result.scores,
        )
    except Exception as e:
        logger.error(f"Benchmark run failed: {e}")
        raise HTTPException(status_code=500, detail=f"Benchmark execution failed: {str(e)}")


@router.get("/results/{benchmark_id}")
async def get_benchmark_results(
    benchmark_id: str,
    user: dict = get_current_user,
):
    """Get benchmark results for a specific benchmark."""
    engine = get_benchmark_engine()

    # Find the latest result for this benchmark
    result = None
    for run in reversed(list(engine._runs.values())):
        if run.benchmark_id == benchmark_id and run.result:
            result = run.result
            break

    if not result:
        raise HTTPException(
            status_code=404,
            detail=f"No results found for benchmark {benchmark_id}",
        )

    return {
        "benchmark_id": result.benchmark_id,
        "run_id": result.run_id,
        "timestamp": result.timestamp.isoformat(),
        "passed": result.passed,
        "scores": result.scores,
        "details": result.details,
    }


@router.get("/history", response_model=BenchmarkHistoryResponse)
async def get_benchmark_history(
    user: dict = get_current_user,
):
    """List past benchmark runs."""
    engine = get_benchmark_engine()

    runs = engine.get_run_history()

    return BenchmarkHistoryResponse(
        runs=runs,
        total=len(runs),
    )