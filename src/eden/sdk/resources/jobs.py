"""Eden SDK — Jobs resource."""

from __future__ import annotations

from typing import Any, AsyncIterator, Optional

from eden.sdk.models import (
    JobCreateRequest,
    JobItem,
    JobStatus,
    JobResult,
    StreamEvent,
)


class JobsResource:
    """Operations for environment generation jobs."""

    def __init__(self, client: Any):
        self._client = client

    async def create(
        self,
        *,
        description: str,
        tags: Optional[list[str]] = None,
        difficulty_parameters: Optional[dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> JobItem:
        """Create a new environment generation job.

        Args:
            description: Natural language description of the environment.
            tags: Optional tags to guide the Planner.
            difficulty_parameters: Optional difficulty hints.
            idempotency_key: Optional idempotency key for safe retries.

        Returns:
            JobItem with the created job metadata.
        """
        payload = JobCreateRequest(
            description=description,
            tags=tags or [],
            difficulty_parameters=difficulty_parameters or {},
        )
        data = await self._client.post(
            "/jobs",
            json_body=payload.model_dump(),
            idempotency_key=idempotency_key,
        )
        return JobItem(**data)

    async def list(
        self,
        *,
        status: Optional[str] = None,
        outcome_tier: Optional[str] = None,
        q: Optional[str] = None,
        sort: str = "created_at:desc",
        created_after: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict[str, Any]:
        """List jobs for the authenticated user.

        Returns:
            Dict with ``jobs`` (list of JobItem) and pagination fields.
        """
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
        if created_after:
            params["created_after"] = created_after

        data = await self._client.get("/jobs", params=params)
        return data

    async def get(self, job_id: str) -> JobStatus:
        """Get job status by ID."""
        data = await self._client.get(f"/jobs/{job_id}")
        return JobStatus(**data)

    async def get_result(self, job_id: str) -> JobResult:
        """Get job result (raises 202 if not yet completed)."""
        data = await self._client.get(f"/jobs/{job_id}/result")
        return JobResult(**data)

    async def cancel(self, job_id: str) -> dict[str, Any]:
        """Cancel an in-progress job."""
        return await self._client.post(f"/jobs/{job_id}/cancel")

    async def stream(self, job_id: str) -> AsyncIterator[StreamEvent]:
        """Stream job status updates via Server-Sent Events.

        Yields StreamEvent objects until the job reaches a terminal state.

        Usage:
            async for event in eden.jobs.stream("job_abc123"):
                print(event.event, event.data)
        """
        from eden.sdk.streaming import SSEStream
        client = self._client
        await client._ensure_client()
        http_client = client._client
        if http_client is None:
            raise RuntimeError("HTTP client not initialized")

        url = f"{client.config.base_url.rstrip('/')}/v1/jobs/{job_id}/stream"
        headers = dict(http_client.headers)
        headers["Accept"] = "text/event-stream"

        async with http_client.stream("GET", url, headers=headers) as response:
            async for event in SSEStream(response.aiter_text()):
                yield event
