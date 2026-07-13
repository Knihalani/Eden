"""Typed Eden API HTTP client used by MCP tools."""

from __future__ import annotations

import logging
from typing import Any, Protocol

import httpx

from eden.mcp_server.auth import McpAuthContext

logger = logging.getLogger(__name__)


class EdenApiClient(Protocol):
    """Minimal surface MCP tools need from Eden."""

    async def search_traces(
        self,
        org_id: str,
        *,
        query: str | None = None,
        agent_id: str | None = None,
        limit: int = 20,
    ) -> dict[str, Any]: ...

    async def get_trace(self, org_id: str, trace_id: str) -> dict[str, Any]: ...

    async def get_transcript(
        self, org_id: str, trace_id: str, *, limit: int = 50
    ) -> dict[str, Any]: ...

    async def list_checkpoints(
        self, org_id: str, trace_id: str
    ) -> dict[str, Any]: ...

    async def rerun_debugger(
        self,
        org_id: str,
        *,
        trace_id: str,
        from_step: int = 0,
        prompt_override: str | None = None,
    ) -> dict[str, Any]: ...

    async def search_issues(
        self,
        org_id: str,
        *,
        status: str | None = None,
        severity: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]: ...

    async def get_issue(self, org_id: str, issue_id: str) -> dict[str, Any]: ...

    async def triage_issue(
        self, org_id: str, issue_id: str, *, force: bool = False
    ) -> dict[str, Any]: ...

    async def run_autofix(
        self,
        org_id: str,
        issue_id: str,
        *,
        dry_run: bool = True,
    ) -> dict[str, Any]: ...

    async def get_improvement_queue(
        self, org_id: str, *, agent_id: str | None = None
    ) -> dict[str, Any]: ...

    async def create_regression_case(
        self, org_id: str, issue_id: str, *, max_traces: int = 3
    ) -> dict[str, Any]: ...

    async def preview_change_impact(
        self,
        org_id: str,
        *,
        change_id: str,
        changed_files: list[str],
        agent_id: str | None = None,
    ) -> dict[str, Any]: ...

    async def export_fixture(
        self, org_id: str, issue_id: str
    ) -> dict[str, Any]: ...


class HttpEdenClient:
    """HTTPS client against Eden FastAPI routes."""

    def __init__(self, auth: McpAuthContext, *, timeout: float = 30.0) -> None:
        self._auth = auth
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self._auth.api_key:
            headers["Authorization"] = f"Bearer {self._auth.api_key}"
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self._auth.base_url}{path}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.request(
                method,
                url,
                headers=self._headers(),
                json=json_body,
                params=params,
            )
            try:
                data = resp.json()
            except Exception:
                data = {"raw": resp.text[:2000]}
            if resp.status_code >= 400:
                return {
                    "status": "error",
                    "http_status": resp.status_code,
                    "data": data,
                }
            if isinstance(data, dict):
                return data
            return {"status": "ok", "data": data}

    async def search_traces(
        self,
        org_id: str,
        *,
        query: str | None = None,
        agent_id: str | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if query:
            params["q"] = query
        if agent_id:
            params["agent_id"] = agent_id
        return await self._request(
            "GET", f"/orgs/{org_id}/observability/traces", params=params
        )

    async def get_trace(self, org_id: str, trace_id: str) -> dict[str, Any]:
        return await self._request(
            "GET", f"/orgs/{org_id}/observability/traces/{trace_id}/tree"
        )

    async def get_transcript(
        self, org_id: str, trace_id: str, *, limit: int = 50
    ) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/orgs/{org_id}/observability/traces/{trace_id}/timeline",
            params={"limit": limit},
        )

    async def list_checkpoints(
        self, org_id: str, trace_id: str
    ) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/orgs/{org_id}/debugger/checkpoints/{trace_id}",
        )

    async def rerun_debugger(
        self,
        org_id: str,
        *,
        trace_id: str,
        from_step: int = 0,
        prompt_override: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"trace_id": trace_id, "from_step": from_step}
        if prompt_override is not None:
            body["prompt_override"] = prompt_override
        return await self._request(
            "POST", f"/orgs/{org_id}/debugger/rerun", json_body=body
        )

    async def search_issues(
        self,
        org_id: str,
        *,
        status: str | None = None,
        severity: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        if severity:
            params["severity"] = severity
        return await self._request(
            "GET", f"/orgs/{org_id}/agent-issues", params=params
        )

    async def get_issue(self, org_id: str, issue_id: str) -> dict[str, Any]:
        return await self._request(
            "GET", f"/orgs/{org_id}/agent-issues/{issue_id}"
        )

    async def triage_issue(
        self, org_id: str, issue_id: str, *, force: bool = False
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/orgs/{org_id}/agent-issues/{issue_id}/triage",
            json_body={"force": force},
        )

    async def run_autofix(
        self,
        org_id: str,
        issue_id: str,
        *,
        dry_run: bool = True,
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/orgs/{org_id}/improve/autofix/{issue_id}",
            json_body={"dry_run": dry_run},
        )

    async def get_improvement_queue(
        self, org_id: str, *, agent_id: str | None = None
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if agent_id:
            params["agent_id"] = agent_id
        return await self._request(
            "GET", f"/orgs/{org_id}/improve/queue", params=params or None
        )

    async def create_regression_case(
        self, org_id: str, issue_id: str, *, max_traces: int = 3
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/orgs/{org_id}/agent-issues/{issue_id}/regression-cases",
            json_body={"max_traces": max_traces, "auto": True},
        )

    async def preview_change_impact(
        self,
        org_id: str,
        *,
        change_id: str,
        changed_files: list[str],
        agent_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "change_id": change_id,
            "changed_files": changed_files,
        }
        if agent_id:
            body["agent_id"] = agent_id
        return await self._request(
            "POST",
            f"/orgs/{org_id}/change-impact/preview",
            json_body=body,
        )

    async def export_fixture(self, org_id: str, issue_id: str) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/orgs/{org_id}/agent-issues/{issue_id}/export-fixture",
        )
