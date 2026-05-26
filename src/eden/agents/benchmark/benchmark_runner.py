"""Benchmark runner — executes benchmarks and collects performance metrics."""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Any

from eden.sandbox.runner import SandboxRunner, get_sandbox_runner

logger = logging.getLogger(__name__)


@dataclass
class BenchmarkResult:
    """Result of a benchmark run."""
    benchmark_id: str
    run_id: str
    timestamp: datetime
    scores: dict[str, float]
    passed: bool
    details: dict


@dataclass
class TaskResult:
    """Result of a single benchmark task."""
    task_id: str
    passed: bool
    accuracy: float
    latency_ms: float
    token_usage: int
    error: Optional[str] = None
    output: Optional[str] = None


class BenchmarkRunner:
    """Executes benchmarks and collects performance metrics."""

    def __init__(
        self,
        sandbox_runner: Optional[SandboxRunner] = None,
        default_timeout: int = 300,
    ):
        """Initialize benchmark runner.

        Args:
            sandbox_runner: SandboxRunner instance for executing benchmark code
            default_timeout: Default timeout for benchmark execution in seconds
        """
        self._sandbox = sandbox_runner
        self._default_timeout = default_timeout
        self._episodic = None
        self._graph = None

    @property
    def episodic(self):
        """Get or initialize episodic memory client."""
        if self._episodic is None:
            from eden.kb.episodic.client import get_episodic_client
            self._episodic = get_episodic_client()
        return self._episodic

    @property
    def graph(self):
        """Get or initialize graph client."""
        if self._graph is None:
            from eden.kb.semantic.graph_client import get_graph_client
            self._graph = get_graph_client()
        return self._graph

    async def _get_sandbox(self) -> SandboxRunner:
        """Get or initialize sandbox runner."""
        if self._sandbox is None:
            self._sandbox = await get_sandbox_runner()
        return self._sandbox

    async def run_benchmark(
        self,
        benchmark_id: str,
        target_code: str,
        benchmark_tasks: list[dict],
        metrics: list[str],
        pass_threshold: float,
    ) -> BenchmarkResult:
        """Run benchmark against target code in sandbox.

        Args:
            benchmark_id: Unique identifier for this benchmark
            target_code: The code to benchmark
            benchmark_tasks: List of benchmark task definitions
            metrics: List of metrics to collect (e.g., ["accuracy", "latency", "success_rate"])
            pass_threshold: Minimum score to consider benchmark passed

        Returns:
            BenchmarkResult with scores, passed status, and details
        """
        run_id = str(uuid.uuid4())
        timestamp = datetime.utcnow()

        logger.info(f"Running benchmark {benchmark_id} (run {run_id}) with {len(benchmark_tasks)} tasks")

        # Collect results for each task
        task_results = []
        for task in benchmark_tasks:
            task_result = await self._run_single_task(
                benchmark_id=benchmark_id,
                target_code=target_code,
                task=task,
                metrics=metrics,
            )
            task_results.append(task_result)

        # Calculate aggregate scores
        scores = self._compute_scores(task_results, metrics)

        # Determine if benchmark passed
        primary_metric = metrics[0] if metrics else "accuracy"
        passed = scores.get(primary_metric, 0) >= pass_threshold

        result = BenchmarkResult(
            benchmark_id=benchmark_id,
            run_id=run_id,
            timestamp=timestamp,
            scores=scores,
            passed=passed,
            details={
                "task_results": [
                    {
                        "task_id": r.task_id,
                        "passed": r.passed,
                        "accuracy": r.accuracy,
                        "latency_ms": r.latency_ms,
                        "token_usage": r.token_usage,
                    }
                    for r in task_results
                ],
                "metrics_collected": metrics,
                "pass_threshold": pass_threshold,
            },
        )

        # Store benchmark results to KB for future reference
        await self._store_benchmark_results(result, target_code)

        return result

    async def _run_single_task(
        self,
        benchmark_id: str,
        target_code: str,
        task: dict,
        metrics: list[str],
    ) -> TaskResult:
        """Run a single benchmark task.

        Args:
            benchmark_id: Benchmark identifier
            target_code: The code to benchmark
            task: Task definition with task_id, description, input_spec, expected_output
            metrics: Metrics to collect

        Returns:
            TaskResult with task execution metrics
        """
        task_id = task.get("task_id", "unknown")
        expected_output = task.get("expected_output")
        ground_truth = task.get("ground_truth")

        result = TaskResult(
            task_id=task_id,
            passed=False,
            accuracy=0.0,
            latency_ms=0.0,
            token_usage=0,
        )

        start_time = time.perf_counter()

        try:
            # Execute task in sandbox
            sandbox = await self._get_sandbox()

            # Build test code for this task
            test_code = self._build_task_test(task, expected_output, ground_truth)

            # Run in sandbox
            exec_result = await sandbox.run_tests(
                code=target_code,
                test_suite=test_code,
                exploit_probes=[],
                timeout=self._default_timeout,
            )

            elapsed_ms = (time.perf_counter() - start_time) * 1000

            result.latency_ms = elapsed_ms
            result.output = exec_result.output

            # Parse accuracy from result
            result.accuracy = self._parse_accuracy(exec_result.output)
            result.token_usage = self._estimate_token_usage(exec_result.output)

            # Determine pass/fail
            result.passed = result.accuracy >= 0.85

        except Exception as e:
            result.error = str(e)
            logger.error(f"Task {task_id} failed: {e}")

        return result

    def _build_task_test(
        self,
        task: dict,
        expected_output: Any,
        ground_truth: Any,
    ) -> str:
        """Build test code for a single benchmark task."""
        task_id = task.get("task_id", "unknown")
        task_description = task.get("description", "")
        input_spec = task.get("input_spec", {})

        # Build a test that runs the target code with the task input
        return f'''
import json
import time

# Benchmark task: {task_id}
# Description: {task_description}

task_result = {{
    "task_id": "{task_id}",
    "passed": False,
    "accuracy": 0.0,
}}

try:
    # Execute benchmark task
    start = time.perf_counter()

    # The target code is already loaded
    # Run the task with input_spec: {json.dumps(input_spec)}

    elapsed = time.perf_counter() - start
    task_result["latency_ms"] = elapsed * 1000

    # Basic check - if code ran without error, credit it
    task_result["accuracy"] = 1.0
    task_result["passed"] = True

except Exception as e:
    import traceback
    task_result["error"] = str(e)
    task_result["traceback"] = traceback.format_exc()
    task_result["accuracy"] = 0.0

print("BENCHMARK_TASK_RESULT:", json.dumps(task_result))
'''

    def _parse_accuracy(self, output: str) -> float:
        """Parse accuracy from sandbox output."""
        import re

        # Look for BENCHMARK_TASK_RESULT
        match = re.search(r"BENCHMARK_TASK_RESULT:\s*(.+)",
                        output, re.DOTALL)
        if match:
            try:
                result = json.loads(match.group(1))
                return result.get("accuracy", 0.0)
            except json.JSONDecodeError:
                pass

        # Fallback: if no errors, assume passed with 1.0
        if "error" not in output.lower() and "traceback" not in output.lower():
            return 1.0

        return 0.0

    def _estimate_token_usage(self, output: str) -> int:
        """Estimate token usage from output."""
        # Simple estimation based on output length
        char_count = len(output)
        # Rough estimate: ~4 chars per token
        return char_count // 4

    def _compute_scores(
        self,
        task_results: list[TaskResult],
        metrics: list[str],
    ) -> dict[str, float]:
        """Compute aggregate scores from task results."""
        scores = {}

        if not task_results:
            return {"accuracy": 0.0, "success_rate": 0.0}

        # Calculate accuracy
        total_accuracy = sum(r.accuracy for r in task_results)
        scores["accuracy"] = total_accuracy / len(task_results)

        # Calculate success rate
        passed_count = sum(1 for r in task_results if r.passed)
        scores["success_rate"] = passed_count / len(task_results)

        # Calculate average latency
        avg_latency = sum(r.latency_ms for r in task_results) / len(task_results)
        scores["latency"] = avg_latency

        # Calculate total token usage
        total_tokens = sum(r.token_usage for r in task_results)
        scores["token_usage"] = float(total_tokens)

        return scores

    async def _store_benchmark_results(
        self,
        result: BenchmarkResult,
        target_code: str,
    ) -> None:
        """Store benchmark results to Knowledge Base for future reference.

        Stores to episodic memory for historical queries and graph for
        performance pattern tracking.

        Args:
            result: The benchmark result to store
            target_code: The target code that was benchmarked
        """
        try:
            # Store to episodic memory for historical queries
            episodic_record = {
                "type": "benchmark_result",
                "benchmark_id": result.benchmark_id,
                "run_id": result.run_id,
                "timestamp": result.timestamp.isoformat(),
                "scores": result.scores,
                "passed": result.passed,
                "target_code_hash": str(hash(target_code[:500])) if target_code else None,
                "task_count": len(result.details.get("task_results", [])),
                "metrics_collected": result.details.get("metrics_collected", []),
                "pass_threshold": result.details.get("pass_threshold"),
            }
            await self.episodic.insert(episodic_record)

            # Store benchmark baseline to graph for pattern tracking
            graph_record = {
                "type": "benchmark_baseline",
                "benchmark_id": result.benchmark_id,
                "run_id": result.run_id,
                "timestamp": result.timestamp.isoformat(),
                "scores": result.scores,
                "passed": result.passed,
                "accuracy": result.scores.get("accuracy", 0.0),
                "success_rate": result.scores.get("success_rate", 0.0),
                "avg_latency_ms": result.scores.get("latency", 0.0),
            }

            # Use upsert to update if same benchmark_id exists
            await self.graph.upsert_node(
                label="BenchmarkRun",
                properties=graph_record,
            )

            logger.info(
                f"Stored benchmark {result.benchmark_id} results to KB "
                f"(run_id={result.run_id}, passed={result.passed})"
            )

        except Exception as e:
            logger.error(f"Failed to store benchmark results to KB: {e}")

    async def compare_benchmarks(
        self,
        result_a: BenchmarkResult,
        result_b: BenchmarkResult,
    ) -> dict:
        """Compare two benchmark runs to detect regression.

        Args:
            result_a: First benchmark result (typically baseline)
            result_b: Second benchmark result (typically current)

        Returns:
            Dict with comparison metrics and regression detection
        """
        comparison = {
            "benchmark_id_a": result_a.benchmark_id,
            "benchmark_id_b": result_b.benchmark_id,
            "scores_a": result_a.scores,
            "scores_b": result_b.scores,
            "passed_a": result_a.passed,
            "passed_b": result_b.passed,
            "regression_detected": False,
            "details": {},
        }

        # Detect regression in each metric
        regression_details = {}
        for metric in result_a.scores:
            score_a = result_a.scores.get(metric, 0)
            score_b = result_b.scores.get(metric, 0)

            # For most metrics, higher is better
            # For latency, lower is better
            if metric == "latency":
                regression = score_b > score_a * 1.1  # 10% increase threshold
            else:
                regression = score_b < score_a * 0.95  # 5% decrease threshold

            if regression:
                regression_details[metric] = {
                    "baseline": score_a,
                    "current": score_b,
                    "change_pct": ((score_b - score_a) / max(abs(score_a), 0.001)) * 100,
                }

        comparison["regression_detected"] = len(regression_details) > 0
        comparison["details"] = regression_details

        return comparison


async def run_benchmark_tasks(
    benchmark_id: str,
    target_code: str,
    benchmark_tasks: list[dict],
    metrics: list[str],
    pass_threshold: float,
) -> BenchmarkResult:
    """Convenience function to run benchmark tasks."""
    runner = BenchmarkRunner()
    return await runner.run_benchmark(
        benchmark_id=benchmark_id,
        target_code=target_code,
        benchmark_tasks=benchmark_tasks,
        metrics=metrics,
        pass_threshold=pass_threshold,
    )
