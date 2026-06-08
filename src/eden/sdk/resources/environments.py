"""Eden SDK — Environments resource."""

from __future__ import annotations

from typing import Any, Optional

from eden.sdk.models import (
    EnvironmentItem,
    EnvironmentDetail,
    EnvironmentVersion,
    EnvironmentTestReport,
)


class EnvironmentsResource:
    """Operations for completed environments."""

    def __init__(self, client: Any):
        self._client = client

    async def list(
        self,
        *,
        status: Optional[str] = None,
        outcome_tier: Optional[str] = None,
        q: Optional[str] = None,
        sort: str = "created_at:desc",
        limit: int = 20,
        offset: int = 0,
    ) -> dict[str, Any]:
        """List completed environments."""
        params: dict[str, Any] = {
            "sort": sort,
            "limit": limit,
            "offset": offset,
        }
        if status:
            params["status"] = status
        if outcome_tier:
            params["outcome_tier"] = outcome_tier
        if q:
            params["q"] = q

        data = await self._client.get("/environments", params=params)
        return data

    async def get(self, job_id: str) -> EnvironmentDetail:
        """Get environment detail by job ID."""
        data = await self._client.get(f"/environments/{job_id}")
        return EnvironmentDetail(**data)

    async def download(self, job_id: str) -> bytes:
        """Download environment code as a ZIP archive.

        Returns:
            Raw ZIP file bytes.
        """
        result = await self._client.request("GET", f"/environments/{job_id}/download")
        if result.get("_binary"):
            return result["content"]
        raise RuntimeError("Expected binary ZIP response, got JSON")

    async def tests(self, job_id: str) -> EnvironmentTestReport:
        """Get structured test results from the job result endpoint.

        Note: A dedicated /tests endpoint is planned for Phase 3.
        Currently extracts test data from the job result.
        """
        result = await self._client.get(f"/jobs/{job_id}/result")
        tr = result.get("test_results") or {}
        return EnvironmentTestReport(
            job_id=job_id,
            status=result.get("status", "unknown"),
            verdict=tr.get("verdict", "unknown"),
            total_tests=tr.get("total_tests", 0),
            total_passed=tr.get("total_passed", 0),
            total_failed=tr.get("total_failed", 0),
            total_errors=tr.get("total_errors", 0),
            exploits_detected=tr.get("exploits_detected", 0),
            adversarial_issues=tr.get("adversarial_issues", 0),
            mutation_score=tr.get("mutation_score"),
        )

    async def versions(self, job_id: str) -> list[EnvironmentVersion]:
        """Get version history."""
        data = await self._client.get(f"/environments/{job_id}/versions")
        if isinstance(data, list):
            return [EnvironmentVersion(**v) for v in data]
        # Handle paginated envelope
        items = data.get("data", data)
        return [EnvironmentVersion(**v) for v in items]
