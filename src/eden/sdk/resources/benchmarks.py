"""Eden SDK — Benchmarks resource."""

from __future__ import annotations

from typing import Any

from eden.sdk.models import (
    BenchmarkHistoryItem,
    BenchmarkItem,
    BenchmarkResultDetail,
    BenchmarkRunResult,
)


class BenchmarksResource:
    """Operations for benchmarks."""

    def __init__(self, client: Any):
        self._client = client

    async def create(
        self,
        *,
        benchmark_name: str,
        target_agents: list[str],
        criteria: dict[str, Any],
        idempotency_key: str | None = None,
    ) -> BenchmarkItem:
        """Create a new benchmark definition.

        Args:
            benchmark_name: Human-readable name.
            target_agents: Agent identifiers to benchmark.
            criteria: Success criteria dictionary.
            idempotency_key: Optional idempotency key.

        Returns:
            BenchmarkItem with benchmark_id and message.
        """
        data = await self._client.post(
            "/benchmarks",
            json_body={
                "benchmark_name": benchmark_name,
                "target_agents": target_agents,
                "criteria": criteria,
            },
            idempotency_key=idempotency_key,
        )
        return BenchmarkItem(**data)

    async def run(
        self,
        benchmark_id: str,
        *,
        target_code: str,
        idempotency_key: str | None = None,
    ) -> BenchmarkRunResult:
        """Execute a benchmark.

        Args:
            benchmark_id: Benchmark to run.
            target_code: Code to benchmark against.
            idempotency_key: Optional idempotency key.

        Returns:
            BenchmarkRunResult with scores and pass/fail status.
        """
        data = await self._client.post(
            f"/benchmarks/{benchmark_id}/run",
            json_body={"target_code": target_code},
            idempotency_key=idempotency_key,
        )
        return BenchmarkRunResult(**data)

    async def results(self, benchmark_id: str) -> BenchmarkResultDetail:
        """Get the latest results for a benchmark."""
        data = await self._client.get(f"/benchmarks/{benchmark_id}/results")
        return BenchmarkResultDetail(**data)

    async def history(self) -> list[BenchmarkHistoryItem]:
        """List past benchmark runs."""
        data = await self._client.get("/benchmarks/history")
        if isinstance(data, list):
            return [BenchmarkHistoryItem(**r) for r in data]
        items = data.get("data", data)
        return [BenchmarkHistoryItem(**r) for r in items]
