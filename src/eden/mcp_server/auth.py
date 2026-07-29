"""API-key context for Eden MCP tool calls."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class McpAuthContext:
    """Resolved credentials for outbound Eden API calls.

    ``transport`` records how the context was obtained:

    ``"stdio"``
        Local process (Cursor, a shell). Credentials come from ``EDEN_*`` env
        vars set by the operator, and the local tool fallbacks in ``tools.py``
        are legitimate — they are the point of running the server locally.

    ``"http"``
        A request to ``/v1/mcp``. The key has been verified against
        ``org_api_keys`` by :func:`eden.mcp_server.verify.verify_mcp_bearer`
        and ``org_id`` comes from that verified row, never from a header. The
        local fallbacks are refused on this transport: they query Postgres
        directly and would bypass the API's own authorization.
    """

    api_key: str
    base_url: str
    org_id: str | None = None
    scopes: tuple[str, ...] = ("mcp:read",)
    transport: str = "stdio"


def resolve_auth(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    org_id: str | None = None,
    scopes: tuple[str, ...] | None = None,
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
    # Scopes are never inferred from the mere presence of a key.
    #
    # This previously read: "a present key without explicit scopes gets full
    # MCP tool access (the Eden API still enforces RBAC)". Both halves were
    # wrong over HTTP. Nothing validated the key, so *any* non-empty string —
    # ``Authorization: Bearer x`` — was granted mcp:read+debug+fix; and the
    # "API still enforces RBAC" claim does not hold for the local fallbacks in
    # ``tools.py``, which query Postgres directly and never reach the API.
    #
    # This function now only serves the stdio transport, where credentials come
    # from operator-set ``EDEN_*`` env vars. HTTP callers must go through
    # ``verify.verify_mcp_bearer``, which resolves real scopes from
    # ``org_api_keys``.
    resolved_scopes = scopes if scopes is not None else ("mcp:read",)
    return McpAuthContext(
        api_key=key,
        base_url=url,
        org_id=oid,
        scopes=resolved_scopes,
        transport="stdio",
    )


def pin_org_id(
    ctx: McpAuthContext, argument_org_id: str | None
) -> str:
    """Return the effective org id, rejecting cross-org argument overrides.

    When ``ctx.org_id`` is bound (env / HTTP ``X-Org-Id``), tool arguments
    must match it — otherwise local-fallback tools could IDOR across tenants.
    """
    if ctx.org_id:
        if (
            argument_org_id is not None
            and str(argument_org_id).strip()
            and str(argument_org_id) != str(ctx.org_id)
        ):
            raise PermissionError("org_id does not match authenticated org")
        return str(ctx.org_id)
    if not argument_org_id:
        raise ValueError("org_id required")
    return str(argument_org_id)


def require_scope(ctx: McpAuthContext, scope: str) -> None:
    """Raise ``PermissionError`` when ``scope`` is not granted."""
    if scope in ctx.scopes:
        return
    if "mcp:*" in ctx.scopes or "*" in ctx.scopes:
        return
    # mcp:fix implies mcp:debug implies mcp:read
    if scope == "mcp:read" and (
        "mcp:debug" in ctx.scopes or "mcp:fix" in ctx.scopes
    ):
        return
    if scope == "mcp:debug" and "mcp:fix" in ctx.scopes:
        return
    raise PermissionError(f"MCP scope {scope!r} required")
