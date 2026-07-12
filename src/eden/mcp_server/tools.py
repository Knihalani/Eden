"""MCP tool handlers — thin wrappers over :class:`EdenApiClient`."""

from __future__ import annotations

from typing import Any

from eden.mcp_server.client import EdenApiClient


async def search_traces(
    client: EdenApiClient,
    org_id: str,
    *,
    query: str | None = None,
    agent_id: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    return await client.search_traces(
        org_id, query=query, agent_id=agent_id, limit=limit
    )


async def get_trace(
    client: EdenApiClient, org_id: str, *, trace_id: str
) -> dict[str, Any]:
    return await client.get_trace(org_id, trace_id)


async def get_transcript(
    client: EdenApiClient,
    org_id: str,
    *,
    trace_id: str,
    limit: int = 50,
) -> dict[str, Any]:
    return await client.get_transcript(org_id, trace_id, limit=limit)


async def list_checkpoints(
    client: EdenApiClient, org_id: str, *, trace_id: str
) -> dict[str, Any]:
    return await client.list_checkpoints(org_id, trace_id)


async def rerun_debugger(
    client: EdenApiClient,
    org_id: str,
    *,
    trace_id: str,
    from_step: int = 0,
    prompt_override: str | None = None,
) -> dict[str, Any]:
    return await client.rerun_debugger(
        org_id,
        trace_id=trace_id,
        from_step=from_step,
        prompt_override=prompt_override,
    )


async def search_issues(
    client: EdenApiClient,
    org_id: str,
    *,
    status: str | None = None,
    severity: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    return await client.search_issues(
        org_id, status=status, severity=severity, limit=limit
    )


async def get_issue(
    client: EdenApiClient, org_id: str, *, issue_id: str
) -> dict[str, Any]:
    return await client.get_issue(org_id, issue_id)


async def triage_issue(
    client: EdenApiClient,
    org_id: str,
    *,
    issue_id: str,
    force: bool = False,
) -> dict[str, Any]:
    return await client.triage_issue(org_id, issue_id, force=force)


async def run_autofix(
    client: EdenApiClient,
    org_id: str,
    *,
    issue_id: str,
    dry_run: bool = True,
) -> dict[str, Any]:
    return await client.run_autofix(org_id, issue_id, dry_run=dry_run)


async def get_improvement_queue(
    client: EdenApiClient,
    org_id: str,
    *,
    agent_id: str | None = None,
) -> dict[str, Any]:
    return await client.get_improvement_queue(org_id, agent_id=agent_id)
