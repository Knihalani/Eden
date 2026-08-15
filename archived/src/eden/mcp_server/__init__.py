"""Eden MCP server (F04) — coding-agent tools over Eden APIs.

This package exposes trace / issue / debugger / fix / improve tools for
Cursor, Claude Code, and other MCP clients. It is separate from MCP
*ingest* (``eden.sdk.mcp``), which observes customer agents' MCP calls.

Capabilities shipped:
* **Tools** — ``tools/list`` + ``tools/call`` (all existing tools)
* **Resources** — ``resources/list`` + ``resources/read`` (eden:// URI scheme)
* **Prompts** — ``prompts/list`` + ``prompts/get`` (triage_issue, explain_trace,
  summarize_cost)
"""

from __future__ import annotations

from eden.mcp_server.prompts import PROMPT_CATALOG, get_prompt, list_prompts
from eden.mcp_server.resources import (
    RESOURCE_TEMPLATE_CATALOG,
    list_resource_templates,
    read_resource,
)
from eden.mcp_server.server import TOOL_CATALOG, call_tool, list_tools

__all__ = [
    "TOOL_CATALOG",
    "call_tool",
    "list_tools",
    # Resources
    "RESOURCE_TEMPLATE_CATALOG",
    "list_resource_templates",
    "read_resource",
    # Prompts
    "PROMPT_CATALOG",
    "get_prompt",
    "list_prompts",
]
