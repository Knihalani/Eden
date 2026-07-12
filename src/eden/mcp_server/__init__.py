"""Eden MCP server (F04) — coding-agent tools over Eden APIs.

This package exposes trace / issue / debugger / fix / improve tools for
Cursor, Claude Code, and other MCP clients. It is separate from MCP
*ingest* (``eden.sdk.mcp``), which observes customer agents' MCP calls.
"""

from __future__ import annotations

from eden.mcp_server.server import TOOL_CATALOG, call_tool, list_tools

__all__ = ["TOOL_CATALOG", "call_tool", "list_tools"]
