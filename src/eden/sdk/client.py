"""Eden async HTTP client.

Resource-oriented API built on httpx with automatic retries,
exponential backoff, and envelope unwrapping.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

import httpx

from eden.sdk.config import EdenConfig
from eden.sdk.errors import raise_for_status, EdenError
from eden.sdk.models import APIEnvelope, PaginatedEnvelope

logger = logging.getLogger("eden.sdk")

DEFAULT_RETRYABLE = (408, 429, 500, 502, 503, 504)


class EdenClient:
    """Async Eden API client.

    Usage:
        async with EdenClient() as eden:
            job = await eden.jobs.create(description="...")
    """

    def __init__(self, *, config: Optional[EdenConfig] = None, **kwargs):
        self.config = config or EdenConfig.load(**kwargs)
        self._client: Optional[httpx.AsyncClient] = None
        self._request_id: Optional[str] = None

    # ── Lifecycle ──────────────────────────────────────────────────────

    async def __aenter__(self) -> "EdenClient":
        await self._ensure_client()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "eden-py/0.1.0",
            }
            headers.update(self.config.get_headers())

            timeout = httpx.Timeout(self.config.timeout, connect=10.0)
            self._client = httpx.AsyncClient(
                base_url=self.config.base_url.rstrip("/"),
                headers=headers,
                timeout=timeout,
                follow_redirects=True,
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    # ── Low-level HTTP ─────────────────────────────────────────────────

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[dict] = None,
        params: Optional[dict] = None,
        headers: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        """Make an HTTP request with automatic retries and envelope unwrapping."""
        client = await self._ensure_client()
        url = f"/v1{path}" if not path.startswith("/v1") else path

        request_headers = dict(headers) if headers else {}
        if idempotency_key:
            request_headers["Idempotency-Key"] = idempotency_key
        if self.config.debug:
            request_headers["X-Debug"] = "true"

        self._request_id = str(uuid.uuid4())[:12]
        request_headers["X-Request-ID"] = self._request_id

        last_exception: Optional[Exception] = None

        for attempt in range(self.config.max_retries + 1):
            try:
                if self.config.debug:
                    logger.debug(
                        f"[req {self._request_id}] {method} {url} "
                        f"(attempt {attempt + 1}/{self.config.max_retries + 1})"
                    )

                response = await client.request(
                    method=method,
                    url=url,
                    json=json_body,
                    params=params,
                    headers=request_headers,
                )

                # Handle raw binary responses (e.g., ZIP downloads)
                if response.headers.get("content-type", "").startswith("application/zip"):
                    return {
                        "_binary": True,
                        "content": response.content,
                        "headers": dict(response.headers),
                        "status_code": response.status_code,
                    }

                body = response.json() if response.text else {}

                if self.config.debug:
                    logger.debug(
                        f"[req {self._request_id}] {response.status_code} "
                        f"{len(response.text)} bytes"
                    )

                # Unwrap envelope
                if "data" in body and "meta" in body:
                    data = body["data"]
                    meta = body["meta"]
                    req_id = meta.get("request_id", self._request_id)
                else:
                    data = body
                    meta = {}
                    req_id = self._request_id

                    # Check for HTTP errors — retry on 500-level before raising
                if response.status_code >= 400:
                    if response.status_code in DEFAULT_RETRYABLE and attempt < self.config.max_retries:
                        wait = min(2 ** attempt, 60)
                        logger.warning(
                            f"[req {self._request_id}] {response.status_code} — "
                            f"retrying in {wait}s"
                        )
                        await asyncio.sleep(wait)
                        continue
                    raise_for_status(
                        response.status_code,
                        {"detail": data.get("detail", "Unknown error"), "meta": meta, **data},
                        request_id=req_id,
                    )

                return {"_data": data, "_meta": meta, "_status": response.status_code}

            except (httpx.NetworkError, httpx.TimeoutException) as e:
                last_exception = e
                if attempt < self.config.max_retries:
                    wait = min(2 ** attempt, 60)
                    logger.warning(
                        f"[req {self._request_id}] Network error — retrying in {wait}s"
                    )
                    await asyncio.sleep(wait)
                continue

        # All retries exhausted
        raise EdenError(
            message=f"Request failed after {self.config.max_retries + 1} attempts: {last_exception}",
            request_id=self._request_id,
        )

    async def get(self, path: str, **kwargs: Any) -> Any:
        """GET request returning unwrapped data."""
        result = await self.request("GET", path, **kwargs)
        return result["_data"]

    async def post(self, path: str, **kwargs: Any) -> Any:
        """POST request returning unwrapped data."""
        result = await self.request("POST", path, **kwargs)
        return result["_data"]

    # ── Resource accessors ─────────────────────────────────────────────

    @property
    def jobs(self) -> "JobsResource":
        """Job resource accessor."""
        from eden.sdk.resources.jobs import JobsResource
        return JobsResource(self)

    @property
    def environments(self) -> "EnvironmentsResource":
        """Environment resource accessor."""
        from eden.sdk.resources.environments import EnvironmentsResource
        return EnvironmentsResource(self)

    @property
    def benchmarks(self) -> "BenchmarksResource":
        """Benchmark resource accessor."""
        from eden.sdk.resources.benchmarks import BenchmarksResource
        return BenchmarksResource(self)
