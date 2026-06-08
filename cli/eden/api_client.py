"""Async Eden API client used by the Eden Agent CLI.

The CLI is one of several Eden clients. The canonical SDK lives at
``src/eden/sdk/client.py`` (EdenClient); the CLI's needs are narrower
(KB queries, observability summaries, job submission, KB writes) so we
wrap httpx directly and avoid pulling the full SDK + its transitive deps
into a CLI that should be quick to ``pip install``.

All public methods return plain dicts (Pydantic-free on the wire) so
callers in the CLI can be tested with simple fixtures.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

import httpx

from eden.config import EdenCLIConfig

logger = logging.getLogger("eden.cli.api_client")


class EdenAPIError(RuntimeError):
    """Wraps a non-2xx response from the Eden API."""

    def __init__(self, status_code: int, detail: Any):
        super().__init__(f"Eden API {status_code}: {detail}")
        self.status_code = status_code
        self.detail = detail


class EdenAPIClient:
    """Async Eden HTTP client tailored for the CLI.

    Endpoints (relative paths, ``/v1`` prefix added automatically)::

        GET  /orgs/{org_id}/kb/query
        GET  /orgs/{org_id}/observability/traces
        GET  /orgs/{org_id}/observability/summary
        POST /orgs/{org_id}/kb/entries
        POST /orgs/{org_id}/jobs
        GET  /orgs/{org_id}/jobs/{job_id}
    """

    def __init__(
        self,
        config: EdenCLIConfig,
        *,
        timeout: float = 30.0,
        max_retries: int = 3,
    ):
        self.config = config
        self.timeout = timeout
        self.max_retries = max_retries
        self._client: Optional[httpx.AsyncClient] = None

    # ── Lifecycle ──────────────────────────────────────────────────────

    async def __aenter__(self) -> "EdenAPIClient":
        await self._ensure_client()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": f"eden-cli/{_VERSION}",
            }
            if self.config.api_key:
                headers["X-Org-Api-Key"] = self.config.api_key
            if self.config.org_id:
                headers["X-Org-Id"] = self.config.org_id

            self._client = httpx.AsyncClient(
                base_url=self.config.base_url.rstrip("/"),
                headers=headers,
                timeout=httpx.Timeout(self.timeout, connect=10.0),
                follow_redirects=True,
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    # ── Low-level ──────────────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, Any]] = None,
        json_body: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        client = await self._ensure_client()
        url = f"/v1{path}" if not path.startswith("/v1") else path
        last_exc: Optional[Exception] = None

        for attempt in range(self.max_retries + 1):
            try:
                resp = await client.request(
                    method, url, params=params, json=json_body
                )
                if resp.status_code >= 500 and attempt < self.max_retries:
                    # exponential backoff (sync sleep; tiny, acceptable in async)
                    import asyncio

                    await asyncio.sleep(0.25 * (2**attempt))
                    continue
                if resp.status_code >= 400:
                    try:
                        detail: Any = resp.json()
                    except Exception:  # noqa: BLE001
                        detail = resp.text
                    raise EdenAPIError(resp.status_code, detail)
                if not resp.content:
                    return {}
                return resp.json()
            except httpx.RequestError as exc:
                last_exc = exc
                if attempt >= self.max_retries:
                    raise
                import asyncio

                await asyncio.sleep(0.25 * (2**attempt))
        # Unreachable, but keep type-checker happy
        raise EdenAPIError(0, str(last_exc) if last_exc else "unknown")

    # ── KB ─────────────────────────────────────────────────────────────

    async def query_kb(
        self,
        query: str,
        *,
        scope: str = "all",  # all | global | tenant
        limit: int = 10,
        org_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Query the Knowledge Base.

        ``scope`` is forwarded to the API. ``org_id`` defaults to the
        authenticated org (for tenant-scoped queries).
        """
        org = org_id or self.config.org_id
        if not org:
            raise EdenAPIError(401, "org_id required for KB query")
        return await self._request(
            "GET",
            f"/orgs/{org}/kb/query",
            params={"q": query, "scope": scope, "limit": limit},
        )

    async def write_kb_entry(
        self,
        entry: dict[str, Any],
        *,
        org_id: Optional[str] = None,
    ) -> dict[str, Any]:
        org = org_id or self.config.org_id
        if not org:
            raise EdenAPIError(401, "org_id required to write KB")
        return await self._request(
            "POST", f"/orgs/{org}/kb/entries", json_body=entry
        )

    # ── Observability ──────────────────────────────────────────────────

    async def list_traces(
        self,
        *,
        limit: int = 20,
        agent_id: Optional[str] = None,
        realm: Optional[str] = None,
        org_id: Optional[str] = None,
    ) -> dict[str, Any]:
        org = org_id or self.config.org_id
        if not org:
            raise EdenAPIError(401, "org_id required for traces")
        params: dict[str, Any] = {"limit": limit}
        if agent_id:
            params["agent_id"] = agent_id
        if realm:
            params["realm"] = realm
        return await self._request(
            "GET", f"/orgs/{org}/observability/traces", params=params
        )

    async def observability_summary(
        self,
        *,
        window_hours: int = 24,
        org_id: Optional[str] = None,
    ) -> dict[str, Any]:
        org = org_id or self.config.org_id
        if not org:
            raise EdenAPIError(401, "org_id required for observability summary")
        return await self._request(
            "GET",
            f"/orgs/{org}/observability/summary",
            params={"window_hours": window_hours},
        )

    # ── Jobs ───────────────────────────────────────────────────────────

    async def submit_job(
        self, job: dict[str, Any], *, org_id: Optional[str] = None
    ) -> dict[str, Any]:
        org = org_id or self.config.org_id
        if not org:
            raise EdenAPIError(401, "org_id required to submit job")
        return await self._request("POST", f"/orgs/{org}/jobs", json_body=job)

    async def get_job(
        self, job_id: str, *, org_id: Optional[str] = None
    ) -> dict[str, Any]:
        org = org_id or self.config.org_id
        if not org:
            raise EdenAPIError(401, "org_id required to fetch job")
        return await self._request("GET", f"/orgs/{org}/jobs/{job_id}")

    # ── Health ─────────────────────────────────────────────────────────

    async def health(self) -> bool:
        """Return True if the API responds 2xx on /v1/health."""
        try:
            await self._request("GET", "/health")
            return True
        except EdenAPIError:
            return False


@asynccontextmanager
async def eden_client(config: EdenCLIConfig) -> AsyncIterator[EdenAPIClient]:
    """Async context manager: ``async with eden_client(cfg) as c: ...``

    The yielded client has its ``httpx.AsyncClient`` initialized (i.e.
    ``c._client is not None``), so callers can immediately ``await``
    methods without a separate warm-up step.
    """
    client = EdenAPIClient(config)
    await client.__aenter__()
    try:
        yield client
    finally:
        await client.close()


_VERSION = "0.1.0-eden"
