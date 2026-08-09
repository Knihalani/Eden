"""MCP tool registry + dispatch (F04).

Tools are callable without the ``mcp`` PyPI package so unit smoke can
exercise them. ``python -m eden.mcp_server`` serves a minimal JSON-RPC
stdio loop (``tools/list``, ``tools/call``) for IDE wiring.
"""

from __future__ import annotations

import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from eden.mcp_server import tools as tool_fns
from eden.mcp_server.auth import (
    McpAuthContext,
    pin_org_id,
    require_scope,
    resolve_auth,
)
from eden.mcp_server.client import EdenApiClient, HttpEdenClient

logger = logging.getLogger(__name__)

_MCP_SERVER_NAME = "eden-mcp-server"


def _emit_tool_telemetry(
    tool_name: str,
    org_id: str | None,
    status: str,
    duration_ms: float,
) -> None:
    """Emit a structured log event with SEP-414 MCP attrs.  Best-effort; never raises."""
    with contextlib.suppress(Exception):
        logger.info(
            "mcp.tool_call",
            extra={
                "mcp.server_name": _MCP_SERVER_NAME,
                "mcp.tool_name": tool_name,
                "eden.mcp_server.org_id": org_id or "",
                "eden.mcp_server.status": status,
                "eden.mcp_server.duration_ms": round(duration_ms, 2),
            },
        )

ToolHandler = Callable[..., Awaitable[dict[str, Any]]]

TOOL_CATALOG: list[dict[str, Any]] = [
    {
        "name": "search_traces",
        "description": "Search org traces by query / agent.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "query": {"type": "string"},
                "agent_id": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "get_trace",
        "description": "Fetch trace tree / metadata.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "trace_id": {"type": "string"},
            },
            "required": ["org_id", "trace_id"],
        },
    },
    {
        "name": "get_transcript",
        "description": "Step-by-step transcript / timeline for a trace.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "trace_id": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["org_id", "trace_id"],
        },
    },
    {
        "name": "list_checkpoints",
        "description": "List debugger checkpoints for a trace.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "trace_id": {"type": "string"},
            },
            "required": ["org_id", "trace_id"],
        },
    },
    {
        "name": "rerun_debugger",
        "description": (
            "Rerun a trace from a checkpoint step using the prefix cache populated by F03. "
            "Returns cache_hits and populated_steps when the debugger_llm_cache has data for this trace. "
            "rerun_mode is a client-side hint only (cached_live/replay) — the server has no "
            "rerun_mode field and never reads it. To actually invoke a real model on the mutated "
            "tail step (F01 live gateway), set the separate `live` boolean; it requires "
            "debugger_live_rerun_v1 and defaults to false so nothing is silently billed."
        ),
        "scope": "mcp:debug",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "trace_id": {"type": "string"},
                "from_step": {"type": "integer"},
                "prompt_override": {"type": "string"},
                "rerun_mode": {
                    "type": "string",
                    "enum": ["cached_live", "replay"],
                    "description": (
                        "Client-side hint only; not forwarded to the API. Use `live` to "
                        "actually reach the live gateway."
                    ),
                },
                "live_prefix": {
                    "type": "boolean",
                    "description": "When true, prefer live prefix cache rows from debugger_llm_cache.",
                },
                "live": {
                    "type": "boolean",
                    "description": (
                        "Actually invoke the model on the mutated tail step (F01 live gateway); "
                        "requires debugger_live_rerun_v1. Defaults false — never silently billed."
                    ),
                },
            },
            "required": ["org_id", "trace_id"],
        },
    },
    {
        "name": "checkpoint_rerun",
        "description": (
            "Rerun the debugger from a checkpoint step (F01 live-rerun path). "
            "rerun_mode is a client-side hint only (cached_live/replay) — the server has no "
            "rerun_mode field and never reads it. Returns the debugger route's honesty stats "
            "(cache_hits / populated_steps). To actually invoke a real model on the mutated "
            "tail step, set the separate `live` boolean; it requires debugger_live_rerun_v1 "
            "and defaults to false so nothing is silently billed."
        ),
        "scope": "mcp:debug",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "trace_id": {"type": "string"},
                "from_step": {"type": "integer"},
                "prompt_override": {"type": "string"},
                "rerun_mode": {
                    "type": "string",
                    "enum": ["cached_live", "replay"],
                    "description": (
                        "Client-side hint only; not forwarded to the API. Use `live` to "
                        "actually reach the live gateway."
                    ),
                },
                "live_prefix": {
                    "type": "boolean",
                    "description": "When true, prefer live prefix cache rows from debugger_llm_cache.",
                },
                "live": {
                    "type": "boolean",
                    "description": (
                        "Actually invoke the model on the mutated tail step (F01 live gateway); "
                        "requires debugger_live_rerun_v1. Defaults false — never silently billed."
                    ),
                },
            },
            "required": ["org_id", "trace_id"],
        },
    },
    {
        "name": "search_issues",
        "description": "List agent issues (optional status/severity).",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "status": {"type": "string"},
                "severity": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "get_issue",
        "description": "Get a single agent issue with triage.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "issue_id": {"type": "string"},
            },
            "required": ["org_id", "issue_id"],
        },
    },
    {
        "name": "get_trace_stumbles",
        "description": "List detected stumbles for a trace (F28).",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "trace_id": {"type": "string"},
                "kind": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["org_id", "trace_id"],
        },
    },
    {
        "name": "triage_issue",
        "description": "Run TriageAgent on an issue.",
        "scope": "mcp:debug",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "issue_id": {"type": "string"},
                "force": {"type": "boolean"},
            },
            "required": ["org_id", "issue_id"],
        },
    },
    {
        "name": "run_autofix",
        "description": "Propose a patch for an issue (dry_run default true).",
        "scope": "mcp:fix",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "issue_id": {"type": "string"},
                "dry_run": {"type": "boolean"},
            },
            "required": ["org_id", "issue_id"],
        },
    },
    {
        "name": "confirm_shadow_detector",
        "description": (
            "Confirm or dismiss a shadow detector (Loop 1 signal feedback), "
            "the same operator feedback the issues UI records. A dismiss that "
            "crosses the delete threshold auto-disables the detector inline."
        ),
        "scope": "mcp:fix",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "signal_id": {"type": "string"},
                "confirm_or_dismiss": {
                    "type": "string",
                    "enum": ["confirm", "dismiss"],
                },
            },
            "required": ["org_id", "signal_id", "confirm_or_dismiss"],
        },
    },
    {
        "name": "get_improvement_queue",
        "description": "N17 unified improvement cockpit queue.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "agent_id": {"type": "string"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "list_improvement_plans",
        "description": "N23 improvement plan inbox.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "status": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "get_improvement_plan",
        "description": "N23 improvement plan detail + diff.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "plan_id": {"type": "string"},
            },
            "required": ["org_id", "plan_id"],
        },
    },
    {
        "name": "approve_improvement_plan",
        "description": "Approve plan and open GitHub PR (code_patch).",
        "scope": "mcp:fix",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "plan_id": {"type": "string"},
                "applied_by": {"type": "string"},
            },
            "required": ["org_id", "plan_id"],
        },
    },
    {
        "name": "export_fixture",
        "description": "D6 — export redacted failure fixture for local replay.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "issue_id": {"type": "string"},
            },
            "required": ["org_id", "issue_id"],
        },
    },
    {
        "name": "create_regression_case",
        "description": "N01 — materialize regression eval cases from a resolved issue.",
        "scope": "mcp:fix",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "issue_id": {"type": "string"},
                "max_traces": {"type": "integer"},
            },
            "required": ["org_id", "issue_id"],
        },
    },
    {
        "name": "preview_change_impact",
        "description": "N04 — run change impact preview for a PR/config diff.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "change_id": {"type": "string"},
                "changed_files": {"type": "array", "items": {"type": "string"}},
                "agent_id": {"type": "string"},
                "prompt_override": {"type": "string"},
            },
            "required": ["org_id", "change_id", "changed_files"],
        },
    },
    {
        "name": "eden_health",
        "description": "F84 — Eden self-observability health (workers, ingest lag, components).",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "tail_trace",
        "description": "N11 — tail live in-flight session events (buffer snapshot / SSE bridge).",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "session_id": {"type": "string"},
                "from_event_id": {"type": "integer"},
                "max_events": {"type": "integer"},
            },
            "required": ["org_id", "session_id"],
        },
    },
    {
        "name": "label_tool_call",
        "description": "F21 — label a tool span good|bad for misuse learning.",
        "scope": "mcp:debug",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "span_id": {"type": "string"},
                "trace_id": {"type": "string"},
                "tool_name": {"type": "string"},
                "label": {"type": "string", "enum": ["good", "bad"]},
                "reason": {"type": "string"},
                "agent_id": {"type": "string"},
                "args_summary": {"type": "string"},
            },
            "required": ["org_id", "span_id", "trace_id", "tool_name", "label"],
        },
    },
    {
        "name": "query_eql",
        "description": "Compile / preview an Eden Query Language (EQL) filter (read-only).",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "nl_text": {"type": "string"},
                "eql": {"type": "string"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "query_sql",
        "description": "Run a read-only org-scoped SQL query (safe ChatSidebar mirror).",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "sql": {"type": "string"},
                "max_rows": {"type": "integer"},
            },
            "required": ["org_id", "sql"],
        },
    },
    {
        "name": "list_datasets",
        "description": "List evaluation datasets for the org.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "list_experiments",
        "description": "List experiments for the org.",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "get_judge_scores",
        "description": "Fetch judge / Layer A scores for a trace (eval read tool).",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "trace_id": {"type": "string"},
            },
            "required": ["org_id", "trace_id"],
        },
    },
    {
        "name": "get_cost_breakdown",
        "description": "Customer FinOps cost breakdown by feature (org-scoped).",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "window_hours": {"type": "integer"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "get_agentic_metrics",
        "description": "F64 agentic metrics pack summary (tool selection, action completion, …).",
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "window_hours": {"type": "integer"},
                "agent_id": {"type": "string"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "get_book",
        "description": (
            "Read an agent's Book (F40) — structured behavior/knowledge record. "
            "When Ledger is enabled for the org the same route may return ledger content."
        ),
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "agent_id": {"type": "string"},
            },
            "required": ["org_id", "agent_id"],
        },
    },
    {
        "name": "list_artifacts",
        "description": (
            "List Artifacts / Nudges (F39) for the org — runtime prompt interventions. "
            "Optional agent_id / mode filters."
        ),
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "agent_id": {"type": "string"},
                "mode": {"type": "string"},
            },
            "required": ["org_id"],
        },
    },
    {
        "name": "get_ledger",
        "description": (
            "Read Ledger content. Pass agent_id for one agent's ledger; omit it "
            "to list org-wide ledger summary rows."
        ),
        "scope": "mcp:read",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "agent_id": {"type": "string"},
            },
            "required": ["org_id"],
        },
    },
]

_HANDLERS: dict[str, ToolHandler] = {
    "search_traces": tool_fns.search_traces,
    "get_trace": tool_fns.get_trace,
    "get_transcript": tool_fns.get_transcript,
    "list_checkpoints": tool_fns.list_checkpoints,
    "rerun_debugger": tool_fns.rerun_debugger,
    "checkpoint_rerun": tool_fns.checkpoint_rerun,
    "search_issues": tool_fns.search_issues,
    "get_issue": tool_fns.get_issue,
    "get_trace_stumbles": tool_fns.get_trace_stumbles,
    "triage_issue": tool_fns.triage_issue,
    "run_autofix": tool_fns.run_autofix,
    "confirm_shadow_detector": tool_fns.confirm_shadow_detector,
    "get_improvement_queue": tool_fns.get_improvement_queue,
    "list_improvement_plans": tool_fns.list_improvement_plans,
    "get_improvement_plan": tool_fns.get_improvement_plan,
    "approve_improvement_plan": tool_fns.approve_improvement_plan,
    "export_fixture": tool_fns.export_fixture,
    "create_regression_case": tool_fns.create_regression_case,
    "preview_change_impact": tool_fns.preview_change_impact,
    "eden_health": tool_fns.eden_health,
    "tail_trace": tool_fns.tail_trace,
    "label_tool_call": tool_fns.label_tool_call,
    "query_eql": tool_fns.query_eql,
    "query_sql": tool_fns.query_sql,
    "list_datasets": tool_fns.list_datasets,
    "list_experiments": tool_fns.list_experiments,
    "get_judge_scores": tool_fns.get_judge_scores,
    "get_cost_breakdown": tool_fns.get_cost_breakdown,
    "get_agentic_metrics": tool_fns.get_agentic_metrics,
    "get_book": tool_fns.get_book,
    "list_artifacts": tool_fns.list_artifacts,
    "get_ledger": tool_fns.get_ledger,
}

_SCOPE_BY_NAME = {t["name"]: t["scope"] for t in TOOL_CATALOG}


def list_tools() -> list[dict[str, Any]]:
    """Return MCP-shaped tool descriptors."""
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "inputSchema": t["inputSchema"],
        }
        for t in TOOL_CATALOG
    ]


async def call_tool(
    name: str,
    arguments: dict[str, Any] | None = None,
    *,
    client: EdenApiClient | None = None,
    auth: McpAuthContext | None = None,
) -> dict[str, Any]:
    """Dispatch a named tool. Used by smoke tests and the stdio loop."""
    args = dict(arguments or {})
    handler = _HANDLERS.get(name)
    if handler is None:
        return {"status": "error", "error": f"unknown tool: {name}"}

    ctx = auth or resolve_auth(org_id=args.get("org_id"))
    scope = _SCOPE_BY_NAME.get(name, "mcp:read")
    # Empty API key: smoke/dev read-only. Write/debug tools require a key.
    if not ctx.api_key and scope != "mcp:read":
        return {
            "status": "error",
            "error": "API key required for this MCP tool",
        }
    if ctx.api_key:
        try:
            require_scope(ctx, scope)
        except PermissionError as exc:
            return {"status": "error", "error": str(exc)}

    argument_org = args.pop("org_id", None)
    try:
        org_id = pin_org_id(ctx, argument_org)
    except PermissionError as exc:
        return {"status": "error", "error": str(exc)}
    except ValueError as exc:
        return {"status": "error", "error": str(exc)}

    api = client or HttpEdenClient(ctx)
    t0 = time.monotonic()
    status = "ok"
    try:
        result = await handler(api, org_id, **args)
    except TypeError as exc:
        status = "error"
        _emit_tool_telemetry(name, org_id, status, (time.monotonic() - t0) * 1000)
        return {"status": "error", "error": f"bad arguments: {exc}"}
    except Exception as exc:
        status = "error"
        logger.debug("mcp tool %s failed: %s", name, exc)
        _emit_tool_telemetry(name, org_id, status, (time.monotonic() - t0) * 1000)
        # Do not echo raw exception text to clients (paths, SQL, stack crumbs).
        return {"status": "error", "error": "tool execution failed"}
    _emit_tool_telemetry(name, org_id, status, (time.monotonic() - t0) * 1000)
    return {"status": "ok", "tool": name, "result": result}
