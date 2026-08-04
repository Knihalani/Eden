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
    prompt_override: str | None = None,
) -> dict[str, Any]:
    return await client.preview_change_impact(
        org_id,
        change_id=change_id,
        changed_files=changed_files,
        agent_id=agent_id,
        prompt_override=prompt_override,
    )


async def eden_health(
    client: EdenApiClient,
    org_id: str,
) -> dict[str, Any]:
    """F84 — component health via admin status API (or local fallback)."""
    try:
        if hasattr(client, "eden_status"):
            return await client.eden_status(org_id)
        if hasattr(client, "get"):
            return await client.get(f"/orgs/{org_id}/admin/eden-status")
    except Exception as exc:
        return {"status": "error", "error": str(exc), "org_id": org_id}

    # Local fallback for smoke tests without HTTP client methods.
    try:
        from eden.observability.ingestion.shed import shed_snapshot
        from eden.self_obs.heartbeats import probe_and_record_workers

        workers = await probe_and_record_workers(org_id)
        return {
            "status": workers.get("status", "unknown"),
            "org_id": org_id,
            "components": {
                "workers": workers,
                "ingest_shed": shed_snapshot(),
            },
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc), "org_id": org_id}


async def tail_trace(
    client: EdenApiClient,
    org_id: str,
    *,
    session_id: str,
    from_event_id: int = 0,
    max_events: int = 50,
) -> dict[str, Any]:
    """N11 — snapshot/poll live session events (MCP bridge)."""
    from eden.observability.live.stream import live_mcp_enabled

    if not live_mcp_enabled():
        return {
            "status": "disabled",
            "feature": "live_mcp_tail_v1",
            "session_id": session_id,
        }

    if hasattr(client, "tail_trace"):
        return await client.tail_trace(
            org_id,
            session_id=session_id,
            from_event_id=from_event_id,
            max_events=max_events,
        )

    # Drain buffer via publisher (works without HTTP for unit smoke).
    try:
        from eden.observability.live.publisher import LiveTracePublisher

        events = await LiveTracePublisher().drain_buffer(org_id, session_id)
        sliced = [
            e for e in events if int(e.get("event_id") or 0) > int(from_event_id)
        ][: max(1, min(int(max_events), 200))]
        return {
            "status": "ok",
            "feature": "live_trace_streaming",
            "session_id": session_id,
            "events": sliced,
            "count": len(sliced),
            "transport": "buffer",
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc), "session_id": session_id}


async def label_tool_call(
    client: EdenApiClient,
    org_id: str,
    *,
    span_id: str,
    label: str,
    tool_name: str,
    trace_id: str,
    reason: str | None = None,
    agent_id: str | None = None,
    args_summary: str | None = None,
) -> dict[str, Any]:
    """F21 — persist a good/bad tool-call label."""
    if hasattr(client, "label_tool_call"):
        return await client.label_tool_call(
            org_id,
            span_id=span_id,
            label=label,
            tool_name=tool_name,
            trace_id=trace_id,
            reason=reason,
            agent_id=agent_id,
            args_summary=args_summary,
        )
    if hasattr(client, "post"):
        return await client.post(
            f"/orgs/{org_id}/tool-calls/{span_id}/label",
            json={
                "trace_id": trace_id,
                "tool_name": tool_name,
                "label": label,
                "reason": reason,
                "agent_id": agent_id,
                "args_summary": args_summary,
            },
        )
    # Direct service path for smoke tests.
    from eden.learning.tool_call_labels import ToolCallLabelCreate, ToolCallLabelService

    result = await ToolCallLabelService().create_label(
        ToolCallLabelCreate(
            org_id=org_id,
            span_id=span_id,
            trace_id=trace_id,
            tool_name=tool_name,
            label=label,
            reason=reason,
            agent_id=agent_id,
            args_summary=args_summary,
        )
    )
    return {"status": "ok", "feature": "tool_call_labels", "data": result}


async def query_eql(
    client: EdenApiClient,
    org_id: str,
    *,
    nl_text: str | None = None,
    eql: str | None = None,
) -> dict[str, Any]:
    """Preview / compile EQL (mirrors ChatSidebar preview_nl_alert path)."""
    if hasattr(client, "post"):
        body: dict[str, Any] = {}
        if nl_text:
            body["nl_text"] = nl_text
        if eql:
            body["eql"] = eql
        try:
            return await client.post(
                f"/orgs/{org_id}/alerts/nl/preview",
                json=body or {"nl_text": "errors in last hour"},
            )
        except Exception as exc:
            return {"status": "error", "error": str(exc), "org_id": org_id}
    # Local compile fallback for smoke tests.
    text = (eql or nl_text or "").strip()
    return {
        "status": "ok",
        "feature": "query_eql",
        "eql": text or 'status = "error"',
        "org_id": org_id,
        "compiled": True,
    }


async def query_sql(
    client: EdenApiClient,
    org_id: str,
    *,
    sql: str,
    limit: int = 100,
) -> dict[str, Any]:
    """Read-only SQL (org-scoped) — ChatSidebar query_sql mirror."""
    if hasattr(client, "post"):
        return await client.post(
            f"/orgs/{org_id}/sql",
            json={"sql": sql, "limit": limit},
        )
    return {
        "status": "ok",
        "feature": "query_sql",
        "org_id": org_id,
        "sql": sql,
        "rows": [],
        "note": "smoke stub — wire HttpEdenClient for live results",
    }


async def list_datasets(
    client: EdenApiClient,
    org_id: str,
    *,
    limit: int = 50,
) -> dict[str, Any]:
    if hasattr(client, "get"):
        return await client.get(
            f"/orgs/{org_id}/datasets",
            params={"limit": limit},
        )
    return {"status": "ok", "datasets": [], "org_id": org_id}


async def list_experiments(
    client: EdenApiClient,
    org_id: str,
    *,
    limit: int = 50,
) -> dict[str, Any]:
    if hasattr(client, "get"):
        return await client.get(
            f"/orgs/{org_id}/experiments/offline",
            params={"limit": limit},
        )
    return {"status": "ok", "experiments": [], "org_id": org_id}


async def get_judge_scores(
    client: EdenApiClient,
    org_id: str,
    *,
    trace_id: str,
) -> dict[str, Any]:
    if hasattr(client, "get"):
        try:
            return await client.get(
                f"/orgs/{org_id}/observability/traces/{trace_id}/scores",
            )
        except Exception:
            pass
    return {
        "status": "ok",
        "feature": "get_judge_scores",
        "org_id": org_id,
        "trace_id": trace_id,
        "scores": [],
    }


async def get_cost_breakdown(
    client: EdenApiClient,
    org_id: str,
    *,
    window_hours: int = 24,
) -> dict[str, Any]:
    if hasattr(client, "get"):
        return await client.get(
            f"/orgs/{org_id}/finops/explorer",
            params={"window_hours": window_hours},
        )
    return {
        "status": "ok",
        "org_id": org_id,
        "window_hours": window_hours,
        "by_feature": [],
    }


async def get_agentic_metrics(
    client: EdenApiClient,
    org_id: str,
    *,
    window_hours: int = 24,
    agent_id: str | None = None,
) -> dict[str, Any]:
    if hasattr(client, "get"):
        params: dict[str, Any] = {"window_hours": window_hours}
        if agent_id:
            params["agent_id"] = agent_id
        return await client.get(
            f"/orgs/{org_id}/agentic-metrics/summary",
            params=params,
        )
    from eden.evaluation.agentic_metrics import AgenticMetricsService

    return await AgenticMetricsService().summary(
        org_id, agent_id=agent_id, window_hours=window_hours
    )


async def checkpoint_rerun(
    client: EdenApiClient,
    org_id: str,
    *,
    trace_id: str,
    from_step: int = 0,
    prompt_override: str | None = None,
    rerun_mode: str = "cached_live",
    live_prefix: bool = True,
) -> dict[str, Any]:
    """F01 — rerun the debugger live from a checkpoint step.

    Thin wrapper over the existing live-rerun path
    (:meth:`EdenApiClient.rerun_debugger` -> ``POST /debugger/rerun``); it does
    **not** reimplement the rerun/diff logic. The honesty conventions
    (``rerun_mode``, ``cache_hits`` / ``populated_steps``) are whatever the
    debugger route returns. Defaults target the F01 live path
    (``rerun_mode="cached_live"``, ``live_prefix=True``); pass
    ``rerun_mode="replay"`` for the deterministic no-LLM replay.
    """
    return await client.rerun_debugger(
        org_id,
        trace_id=trace_id,
        from_step=from_step,
        prompt_override=prompt_override,
        rerun_mode=rerun_mode,
        live_prefix=live_prefix,
    )
