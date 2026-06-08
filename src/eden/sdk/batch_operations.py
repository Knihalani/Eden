"""Eden SDK — Batch operations and parallel job execution.

Supports batch environment generation, parallel benchmark execution,
and async dataset operations with progress tracking.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Iterator, TypeVar

T = TypeVar("T")


@dataclass
class BatchResult:
    """Result of a single item in a batch operation."""

    index: int
    status: str  # "success" | "error" | "skipped"
    result: Any = None
    error: str | None = None
    duration_ms: int = 0


@dataclass
class BatchSummary:
    """Summary of a completed batch operation."""

    total: int
    succeeded: int
    failed: int
    skipped: int
    total_duration_ms: int
    results: list[BatchResult] = field(default_factory=list)

    @property
    def success_rate(self) -> float:
        return self.succeeded / self.total if self.total > 0 else 0.0


class BatchExecutor:
    """Execute operations in batches with configurable concurrency."""

    def __init__(self, max_concurrency: int = 5):
        self.max_concurrency = max(max_concurrency, 1)
        self._semaphore = asyncio.Semaphore(self.max_concurrency)

    async def run(
        self,
        items: list[Any],
        operation: Callable[[Any], Coroutine[Any, Any, T]],
        on_progress: Callable[[int, int], None] | None = None,
    ) -> BatchSummary:
        """Run an async operation over a list of items with bounded concurrency."""
        results: list[BatchResult] = []
        total = len(items)

        async def _run_one(index: int, item: Any) -> BatchResult:
            import time
            start = time.perf_counter()
            async with self._semaphore:
                try:
                    result = await operation(item)
                    duration_ms = int((time.perf_counter() - start) * 1000)
                    return BatchResult(
                        index=index,
                        status="success",
                        result=result,
                        duration_ms=duration_ms,
                    )
                except Exception as e:
                    duration_ms = int((time.perf_counter() - start) * 1000)
                    return BatchResult(
                        index=index,
                        status="error",
                        error=str(e),
                        duration_ms=duration_ms,
                    )
                finally:
                    if on_progress:
                        on_progress(len([r for r in results if r]), total)

        # Execute all tasks and collect results
        tasks = [_run_one(i, item) for i, item in enumerate(items)]
        raw_results = await asyncio.gather(*tasks)
        results = sorted(raw_results, key=lambda r: r.index)

        succeeded = sum(1 for r in results if r.status == "success")
        failed = sum(1 for r in results if r.status == "error")
        skipped = sum(1 for r in results if r.status == "skipped")
        total_duration_ms = sum(r.duration_ms for r in results)

        return BatchSummary(
            total=total,
            succeeded=succeeded,
            failed=failed,
            skipped=skipped,
            total_duration_ms=total_duration_ms,
            results=results,
        )

    def run_sync(
        self,
        items: list[Any],
        operation: Callable[[Any], T],
        on_progress: Callable[[int, int], None] | None = None,
    ) -> BatchSummary:
        """Synchronous wrapper for batch execution using a thread pool."""
        import concurrent.futures
        import time

        results: list[BatchResult] = []
        total = len(items)

        def _run_one(index: int, item: Any) -> BatchResult:
            start = time.perf_counter()
            try:
                result = operation(item)
                duration_ms = int((time.perf_counter() - start) * 1000)
                return BatchResult(
                    index=index,
                    status="success",
                    result=result,
                    duration_ms=duration_ms,
                )
            except Exception as e:
                duration_ms = int((time.perf_counter() - start) * 1000)
                return BatchResult(
                    index=index,
                    status="error",
                    error=str(e),
                    duration_ms=duration_ms,
                )

        with concurrent.futures.ThreadPoolExecutor(
            max_workers=self.max_concurrency
        ) as executor:
            futures = {
                executor.submit(_run_one, i, item): i
                for i, item in enumerate(items)
            }
            for future in concurrent.futures.as_completed(futures):
                results.append(future.result())
                if on_progress:
                    on_progress(len(results), total)

        results = sorted(results, key=lambda r: r.index)
        succeeded = sum(1 for r in results if r.status == "success")
        failed = sum(1 for r in results if r.status == "error")
        skipped = sum(1 for r in results if r.status == "skipped")
        total_duration_ms = sum(r.duration_ms for r in results)

        return BatchSummary(
            total=total,
            succeeded=succeeded,
            failed=failed,
            skipped=skipped,
            total_duration_ms=total_duration_ms,
            results=results,
        )


class ParallelJobRunner:
    """Run multiple Eden jobs in parallel with progress tracking."""

    def __init__(self, client: Any, max_concurrency: int = 3):
        self.client = client
        self.executor = BatchExecutor(max_concurrency=max_concurrency)

    async def generate_environments(
        self,
        descriptions: list[str],
        **common_kwargs: Any,
    ) -> BatchSummary:
        """Batch-generate environments from multiple descriptions."""
        async def _create(desc: str) -> Any:
            return await self.client.environments.create(
                description=desc, **common_kwargs
            )

        return await self.executor.run(descriptions, _create)

    async def run_benchmarks(
        self,
        benchmark_ids: list[str],
        **common_kwargs: Any,
    ) -> BatchSummary:
        """Run multiple benchmarks in parallel."""
        async def _run(bench_id: str) -> Any:
            return await self.client.benchmarks.execute(
                benchmark_id=bench_id, **common_kwargs
            )

        return await self.executor.run(benchmark_ids, _run)

    async def create_datasets_from_traces(
        self,
        filters: list[dict[str, Any]],
        **common_kwargs: Any,
    ) -> BatchSummary:
        """Create multiple datasets from trace filters in parallel."""
        async def _create(filter_spec: dict[str, Any]) -> Any:
            return await self.client.datasets.create_from_traces(
                filter=filter_spec, **common_kwargs
            )

        return await self.executor.run(filters, _create)


class StreamingBatchIterator:
    """Iterator that yields batch results as they complete."""

    def __init__(self, items: list[Any], operation: Callable[[Any], T]):
        self.items = items
        self.operation = operation
        self._results: list[BatchResult] = []
        self._completed = 0

    def __iter__(self) -> Iterator[BatchResult]:
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as executor:
            futures = {
                executor.submit(self._execute_one, i, item): i
                for i, item in enumerate(self.items)
            }
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                self._results.append(result)
                self._completed += 1
                yield result

    def _execute_one(self, index: int, item: Any) -> BatchResult:
        import time
        start = time.perf_counter()
        try:
            result = self.operation(item)
            duration_ms = int((time.perf_counter() - start) * 1000)
            return BatchResult(
                index=index,
                status="success",
                result=result,
                duration_ms=duration_ms,
            )
        except Exception as e:
            duration_ms = int((time.perf_counter() - start) * 1000)
            return BatchResult(
                index=index,
                status="error",
                error=str(e),
                duration_ms=duration_ms,
            )

    @property
    def completed(self) -> int:
        return self._completed

    @property
    def total(self) -> int:
        return len(self.items)
