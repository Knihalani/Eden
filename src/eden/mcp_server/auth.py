"""API-key context for Eden MCP tool calls."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class McpAuthContext:
    """Resolved credentials for outbound Eden API calls."""

    api_key: str
    base_url: str
    org_id: str | None = None
    scopes: tuple[str, ...] = ("mcp:read",)


def resolve_auth(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    org_id: str | None = None,
) -> McpAuthContext:
    """Build auth from explicit args or ``EDEN_*`` env vars."""
    key = (api_key or os.environ.get("EDEN_API_KEY") or "").strip()
    url = (
        base_url
        or os.environ.get("EDEN_BASE_URL")
        or os.environ.get("EDEN_API_URL")
        or "http://127.0.0.1:8000"
    ).rstrip("/")
    oid = org_id or os.environ.get("EDEN_ORG_ID") or None
    return McpAuthContext(api_key=key, base_url=url, org_id=oid)


def require_scope(ctx: McpAuthContext, scope: str) -> None:
    """Raise ``PermissionError`` when ``scope`` is not granted."""
    if scope in ctx.scopes:
        return
    # mcp:fix implies mcp:debug implies mcp:read
    if scope == "mcp:read" and (
        "mcp:debug" in ctx.scopes or "mcp:fix" in ctx.scopes
    ):
        return
    if scope == "mcp:debug" and "mcp:fix" in ctx.scopes:
        return
    raise PermissionError(f"MCP scope {scope!r} required")
