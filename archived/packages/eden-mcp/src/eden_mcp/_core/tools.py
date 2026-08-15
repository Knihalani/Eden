"""MCP tool handlers — thin wrappers over :class:`EdenApiClient`."""

from __future__ import annotations

from typing import Any

from eden_mcp._core.client import EdenApiClient


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
    live: bool | None = None,
) -> dict[str, Any]:
    return await client.rerun_debugger(
        org_id,
        trace_id=trace_id,
        from_step=from_step,
        prompt_override=prompt_override,
        rerun_mode=rerun_mode,
        live_prefix=live_prefix,
        live=live,
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
        return await client.eden_status(org_id)
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


async def query_eql(
    client: EdenApiClient,
    org_id: str,
    *,
    nl_text: str | None = None,
    eql: str | None = None,
) -> dict[str, Any]:
    """Preview / compile EQL (``POST /orgs/{org}/alerts/compile``)."""
    nl = (nl_text or "").strip()
    eql_override = (eql or "").strip() or None
    if not nl:
        nl = "Lint and compile provided EQL" if eql_override else "errors in last hour"
    try:
        return await client.compile_nl_alert(
            org_id,
            nl_text=nl,
            eql_override=eql_override,
        )
    except Exception as exc:
        return {"status": "error", "error": str(exc), "org_id": org_id}


async def query_sql(
    client: EdenApiClient,
    org_id: str,
    *,
    sql: str,
    limit: int = 100,
    max_rows: int | None = None,
) -> dict[str, Any]:
    """Read-only SQL (org-scoped) — ChatSidebar query_sql mirror."""
    row_cap = max_rows if max_rows is not None else limit
    return await client.query_sql(org_id, sql=sql, limit=row_cap)


async def list_datasets(
    client: EdenApiClient,
    org_id: str,
    *,
    limit: int = 50,
) -> dict[str, Any]:
    return await client.list_datasets(org_id, limit=limit)


async def list_experiments(
    client: EdenApiClient,
    org_id: str,
    *,
    limit: int = 50,
) -> dict[str, Any]:
    return await client.list_experiments(org_id, limit=limit)


async def get_judge_scores(
    client: EdenApiClient,
    org_id: str,
    *,
    trace_id: str,
) -> dict[str, Any]:
    try:
        return await client.get_judge_scores(org_id, trace_id=trace_id)
    except Exception:
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
    return await client.get_cost_breakdown(org_id, window_hours=window_hours)


async def get_agentic_metrics(
    client: EdenApiClient,
    org_id: str,
    *,
    window_hours: int = 24,
    agent_id: str | None = None,
) -> dict[str, Any]:
    return await client.get_agentic_metrics(
        org_id, window_hours=window_hours, agent_id=agent_id
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
    live: bool = False,
) -> dict[str, Any]:
    """F01 — rerun the debugger live from a checkpoint step.

    Thin wrapper over the existing live-rerun path
    (:meth:`EdenApiClient.rerun_debugger` -> ``POST /debugger/rerun``); it does
    **not** reimplement the rerun/diff logic. The honesty conventions
    (``rerun_mode``, ``cache_hits`` / ``populated_steps``) are whatever the
    debugger route returns. Defaults target the F01 live path
    (``rerun_mode="cached_live"``, ``live_prefix=True``); pass
    ``rerun_mode="replay"`` for the deterministic no-LLM replay.

    ``live`` is a separate opt-in for the real ``live_gateway`` model
    invocation (gated by ``debugger_live_rerun_v1``) and defaults to
    ``False`` — never silently invoke/bill a real model without the
    caller explicitly asking for it.
    """
    return await client.rerun_debugger(
        org_id,
        trace_id=trace_id,
        from_step=from_step,
        prompt_override=prompt_override,
        rerun_mode=rerun_mode,
        live_prefix=live_prefix,
        live=live,
    )


async def get_book(
    client: EdenApiClient,
    org_id: str,
    *,
    agent_id: str,
) -> dict[str, Any]:
    """FEAT-183 — F40 agent Book (or its F44 Ledger successor when enabled)."""
    if hasattr(client, "get_book"):
        return await client.get_book(org_id, agent_id)
    from eden.kb.book.generator import BookGenerator

    book = await BookGenerator().get_latest(org_id, agent_id)
    config = await BookGenerator().get_config(org_id, agent_id)
    return {"status": "ok", "feature": "agent_book", "data": {"book": book, "config": config}}


async def list_artifacts(
    client: EdenApiClient,
    org_id: str,
    *,
    agent_id: str | None = None,
    mode: str | None = None,
) -> dict[str, Any]:
    """FEAT-183 — F39 Artifacts (runtime prompt Nudges), read-only."""
    return await client.list_artifacts(org_id, agent_id=agent_id, mode=mode)


async def get_ledger(
    client: EdenApiClient,
    org_id: str,
    *,
    agent_id: str | None = None,
) -> dict[str, Any]:
    """FEAT-183 — Ledger read access.

    With ``agent_id``, fetches that agent's ledger detail
    (``GET /agents/{agent_id}/ledger``). Without it, lists the org-wide
    ledger summary rows (``GET /ledger``) — same split the portal's
    Ledger page uses (``ledgerApi.list`` vs ``ledgerApi.get``).
    """
    if agent_id:
        return await client.get_ledger(org_id, agent_id)
    return await client.list_ledgers(org_id)


async def confirm_shadow_detector(
    client: EdenApiClient,
    org_id: str,
    *,
    signal_id: str,
    confirm_or_dismiss: str,
) -> dict[str, Any]:
    """P0-D (FEAT-27): confirm or dismiss a shadow detector (Loop 1) straight
    from an MCP client (Cursor/Claude), not just the issues UI.

    Thin wrapper over
    :func:`eden.services.soft_issue_review.record_shadow_feedback` (§6.5) —
    it does not reimplement the confirm/dismiss bookkeeping or the P0-C
    inline auto-disable-on-dismiss logic, it just calls straight into it.
    """
    if confirm_or_dismiss not in ("confirm", "dismiss"):
        return {
            "status": "error",
            "error": "confirm_or_dismiss must be 'confirm' or 'dismiss'",
        }
    from eden.services.soft_issue_review import record_shadow_feedback

    updated = await record_shadow_feedback(
        org_id,
        signal_id,
        confirm=True if confirm_or_dismiss == "confirm" else None,
        dismiss=True if confirm_or_dismiss == "dismiss" else None,
    )
    return {
        "status": "ok" if updated else "error",
        "org_id": org_id,
        "signal_id": signal_id,
        "confirm_or_dismiss": confirm_or_dismiss,
        "updated": updated,
    }
