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
    rerun_mode: str | None = None,
    live_prefix: bool | None = None,
) -> dict[str, Any]:
    return await client.rerun_debugger(
        org_id,
        trace_id=trace_id,
        from_step=from_step,
        prompt_override=prompt_override,
        rerun_mode=rerun_mode,
        live_prefix=live_prefix,
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


async def get_trace_stumbles(
    client: EdenApiClient,
    org_id: str,
    *,
    trace_id: str,
    kind: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    return await client.get_trace_stumbles(
        org_id, trace_id, kind=kind, limit=limit
    )


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


async def list_improvement_plans(
    client: EdenApiClient,
    org_id: str,
    *,
    status: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    return await client.list_improvement_plans(org_id, status=status, limit=limit)


async def get_improvement_plan(
    client: EdenApiClient,
    org_id: str,
    *,
    plan_id: str,
) -> dict[str, Any]:
    return await client.get_improvement_plan(org_id, plan_id)


async def approve_improvement_plan(
    client: EdenApiClient,
    org_id: str,
    *,
    plan_id: str,
    applied_by: str | None = None,
) -> dict[str, Any]:
    return await client.approve_improvement_plan(
        org_id, plan_id, applied_by=applied_by
    )


async def export_fixture(
    client: EdenApiClient, org_id: str, *, issue_id: str
) -> dict[str, Any]:
    return await client.export_fixture(org_id, issue_id)


async def create_regression_case(
    client: EdenApiClient,
    org_id: str,
    *,
    issue_id: str,
    max_traces: int = 3,
) -> dict[str, Any]:
    return await client.create_regression_case(
        org_id, issue_id, max_traces=max_traces
    )


async def preview_change_impact(
    client: EdenApiClient,
    org_id: str,
    *,
    change_id: str,
    changed_files: list[str],
    agent_id: str | None = None,
) -> dict[str, Any]:
    return await client.preview_change_impact(
        org_id,
        change_id=change_id,
        changed_files=changed_files,
        agent_id=agent_id,
    )
