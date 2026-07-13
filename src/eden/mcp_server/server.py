"""MCP tool registry + dispatch (F04).

Tools are callable without the ``mcp`` PyPI package so unit smoke can
exercise them. ``python -m eden.mcp_server`` serves a minimal JSON-RPC
stdio loop (``tools/list``, ``tools/call``) for IDE wiring.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from eden.mcp_server.auth import McpAuthContext, require_scope, resolve_auth
from eden.mcp_server.client import EdenApiClient, HttpEdenClient
from eden.mcp_server import tools as tool_fns

logger = logging.getLogger(__name__)

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
        "description": "Rerun a trace from a checkpoint step.",
        "scope": "mcp:debug",
        "inputSchema": {
            "type": "object",
            "properties": {
                "org_id": {"type": "string"},
                "trace_id": {"type": "string"},
                "from_step": {"type": "integer"},
                "prompt_override": {"type": "string"},
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
            },
            "required": ["org_id", "change_id", "changed_files"],
        },
    },
]

_HANDLERS: dict[str, ToolHandler] = {
    "search_traces": tool_fns.search_traces,
    "get_trace": tool_fns.get_trace,
    "get_transcript": tool_fns.get_transcript,
    "list_checkpoints": tool_fns.list_checkpoints,
    "rerun_debugger": tool_fns.rerun_debugger,
    "search_issues": tool_fns.search_issues,
    "get_issue": tool_fns.get_issue,
    "triage_issue": tool_fns.triage_issue,
    "run_autofix": tool_fns.run_autofix,
    "get_improvement_queue": tool_fns.get_improvement_queue,
    "export_fixture": tool_fns.export_fixture,
    "create_regression_case": tool_fns.create_regression_case,
    "preview_change_impact": tool_fns.preview_change_impact,
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
    # Dev/smoke: empty key with default scopes still allows read tools.
    if ctx.api_key or scope == "mcp:read":
        try:
            require_scope(
                McpAuthContext(
                    api_key=ctx.api_key or "smoke",
                    base_url=ctx.base_url,
                    org_id=ctx.org_id,
                    scopes=ctx.scopes
                    if ctx.api_key
                    else ("mcp:read", "mcp:debug", "mcp:fix"),
                ),
                scope,
            )
        except PermissionError as exc:
            return {"status": "error", "error": str(exc)}

    org_id = args.pop("org_id", None) or ctx.org_id
    if not org_id:
        return {"status": "error", "error": "org_id required"}

    api = client or HttpEdenClient(ctx)
    try:
        result = await handler(api, org_id, **args)
    except TypeError as exc:
        return {"status": "error", "error": f"bad arguments: {exc}"}
    except Exception as exc:
        logger.debug("mcp tool %s failed: %s", name, exc)
        return {"status": "error", "error": str(exc)}
    return {"status": "ok", "tool": name, "result": result}
