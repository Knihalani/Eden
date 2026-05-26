"""Benchmark engine — orchestrates benchmark creation and execution."""

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from eden.agents.benchmark.agent import BenchmarkAgent, BenchmarkDefinition
from eden.agents.benchmark.benchmark_runner import BenchmarkRunner, BenchmarkResult

logger = logging.getLogger(__name__)


@dataclass
class BenchmarkRun:
    """Tracks a single benchmark run."""
    run_id: str
    benchmark_id: str
    timestamp: datetime
    status: str  # "running", "completed", "failed"
    result: Optional[BenchmarkResult] = None


class BenchmarkEngine:
    """Orchestrates benchmark creation and execution.

    Coordinates the BenchmarkAgent (creation) and BenchmarkRunner (execution)
    to provide end-to-end benchmark workflow.
    """

    def __init__(
        self,
        benchmark_agent: Optional[BenchmarkAgent] = None,
        benchmark_runner: Optional[BenchmarkRunner] = None,
    ):
        """Initialize benchmark engine.

        Args:
            benchmark_agent: BenchmarkAgent instance for creating benchmarks
            benchmark_runner: BenchmarkRunner instance for executing benchmarks
        """
        self._agent = benchmark_agent or BenchmarkAgent()
        self._runner = benchmark_runner or BenchmarkRunner()
        self._runs: dict[str, BenchmarkRun] = {}

    async def create_benchmark(
        self,
        target_agents: list[str],
        criteria: dict,
        benchmark_name: Optional[str] = None,
        job_context: Optional[dict] = None,
    ) -> str:
        """Create a new benchmark definition.

        Args:
            target_agents: List of agent names to benchmark
            criteria: Success criteria for the benchmark
            benchmark_name: Optional name for the benchmark
            job_context: Optional job context (code, res, etc.)

        Returns:
            benchmark_id: Unique identifier for the created benchmark
        """
        benchmark_id = str(uuid.uuid4())

        logger.info(f"Creating benchmark {benchmark_id} for agents: {target_agents}")

        # Use benchmark agent to create the definition
        agent_state = {
            "job_id": benchmark_id,
            "benchmark_request": {
                "target_agents": target_agents,
                "criteria": criteria,
                "benchmark_name": benchmark_name or f"benchmark-{benchmark_id}",
            },
        }
        if job_context:
            agent_state.update(job_context)

        result = await self._agent.run(agent_state)
        benchmark_def = result.get("benchmark_definition")

        if benchmark_def and benchmark_def.benchmark_id:
            benchmark_id = benchmark_def.benchmark_id

        logger.info(f"Benchmark {benchmark_id} created successfully")
        return benchmark_id

    async def run_benchmark(
        self,
        benchmark_id: str,
        target_code: str,
        benchmark_definition: Optional[BenchmarkDefinition] = None,
    ) -> BenchmarkResult:
        """Execute a benchmark and return results.

        Args:
            benchmark_id: Unique identifier for the benchmark to run
            target_code: The code to benchmark
            benchmark_definition: Optional pre-created benchmark definition

        Returns:
            BenchmarkResult with scores, passed status, and details
        """
        logger.info(f"Executing benchmark {benchmark_id}")

        # Create a run record
        run_id = str(uuid.uuid4())
        self._runs[run_id] = BenchmarkRun(
            run_id=run_id,
            benchmark_id=benchmark_id,
            timestamp=datetime.utcnow(),
            status="running",
        )

        try:
            # If no benchmark definition provided, create a default one
            if benchmark_definition is None:
                benchmark_definition = self._create_default_definition(benchmark_id)

            # Run the benchmark
            result = await self._runner.run_benchmark(
                benchmark_id=benchmark_id,
                target_code=target_code,
                benchmark_tasks=[
                    {
                        "task_id": t.task_id,
                        "description": t.description,
                        "input_spec": t.input_spec,
                        "expected_output": t.expected_output,
                        "ground_truth": t.ground_truth,
                    }
                    for t in benchmark_definition.tasks
                ],
                metrics=benchmark_definition.metrics,
                pass_threshold=benchmark_definition.pass_threshold,
            )

            # Update run record
            self._runs[run_id].status = "completed"
            self._runs[run_id].result = result

            logger.info(
                f"Benchmark {benchmark_id} completed: "
                f"passed={result.passed}, scores={result.scores}"
            )

            return result

        except Exception as e:
            logger.error(f"Benchmark {benchmark_id} failed: {e}")
            self._runs[run_id].status = "failed"
            raise

    async def compare_benchmarks(
        self,
        benchmark_id_a: str,
        benchmark_id_b: str,
    ) -> dict:
        """Compare two benchmark runs to detect regression.

        Args:
            benchmark_id_a: First benchmark ID (typically baseline)
            benchmark_id_b: Second benchmark ID (typically current)

        Returns:
            Dict with comparison metrics and regression detection
        """
        logger.info(f"Comparing benchmarks {benchmark_id_a} vs {benchmark_id_b}")

        # Look up the runs
        result_a = self._get_latest_result(benchmark_id_a)
        result_b = self._get_latest_result(benchmark_id_b)

        if not result_a or not result_b:
            raise ValueError(
                f"Could not find benchmark results for comparison: "
                f"{benchmark_id_a}={result_a}, {benchmark_id_b}={result_b}"
            )

        comparison = await self._runner.compare_benchmarks(result_a, result_b)
        return comparison

    def _create_default_definition(self, benchmark_id: str) -> BenchmarkDefinition:
        """Create a default benchmark definition if none exists."""
        return BenchmarkDefinition(
            benchmark_id=benchmark_id,
            benchmark_name=f"benchmark-{benchmark_id}",
            target_agents=["executor"],
            tasks=[
                {
                    "task_id": "default-task-1",
                    "description": "Default benchmark task",
                    "input_spec": {},
                    "expected_output": None,
                    "ground_truth": None,
                }
            ],
            metrics=["accuracy", "success_rate"],
            pass_threshold=0.85,
        )

    def _get_latest_result(self, benchmark_id: str) -> Optional[BenchmarkResult]:
        """Get the latest result for a benchmark ID."""
        # Check runs dict for the benchmark
        for run in reversed(list(self._runs.values())):
            if run.benchmark_id == benchmark_id and run.result:
                return run.result
        return None

    def get_run_history(self) -> list[dict]:
        """Get history of benchmark runs."""
        return [
            {
                "run_id": r.run_id,
                "benchmark_id": r.benchmark_id,
                "timestamp": r.timestamp.isoformat(),
                "status": r.status,
                "passed": r.result.passed if r.result else None,
            }
            for r in self._runs.values()
        ]


async def run_benchmark_workflow(
    target_agents: list[str],
    criteria: dict,
    target_code: str,
    benchmark_name: Optional[str] = None,
) -> BenchmarkResult:
    """Convenience function for full benchmark workflow.

    Creates and executes a benchmark in one call.

    Args:
        target_agents: List of agent names to benchmark
        criteria: Success criteria for the benchmark
        target_code: The code to benchmark
        benchmark_name: Optional name for the benchmark

    Returns:
        BenchmarkResult with scores, passed status, and details
    """
    engine = BenchmarkEngine()

    # Create benchmark
    benchmark_id = await engine.create_benchmark(
        target_agents=target_agents,
        criteria=criteria,
        benchmark_name=benchmark_name,
    )

    # Run benchmark
    result = await engine.run_benchmark(
        benchmark_id=benchmark_id,
        target_code=target_code,
    )

    return result
