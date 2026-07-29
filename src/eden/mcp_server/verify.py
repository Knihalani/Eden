"""Bearer verification for the MCP HTTP transport.

Before the 2026-07 remediation ``/v1/mcp`` checked only that an
``Authorization`` header was *present*::

    if not api_key:
        return _rpc_error(..., http_status=401)

Nothing hashed the key, looked it up in ``org_api_keys``, or checked that it
belonged to the ``X-Org-Id`` the caller supplied — and ``resolve_auth`` then
granted ``mcp:read + mcp:debug + mcp:fix`` to any non-empty string. The
``MCP_SCOPES`` frozenset in ``api/deps.py`` had no consumer at all.

The org-mismatch guard in the transport was not a defence either: both the
header and the tool argument are attacker-supplied, so comparing them proves
nothing. The org must come from the *verified key row*.

This module is that missing step. It reuses ``validate_org_api_key`` — the
same SHA-256 lookup, debounced ``last_used_at`` write and fail-to-``None``
behaviour used by every other programmatic auth path — so MCP keys are
neither weaker nor a second implementation.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.mcp_server.auth import McpAuthContext
from eden.mcp_server.errors import McpAuthError, McpScopeError, McpUnavailableError

logger = logging.getLogger(__name__)


async def verify_mcp_bearer(
    *,
    api_key: str | None,
    org_id_header: str | None,
    base_url: str,
) -> McpAuthContext:
    """Verify an MCP bearer token and return a scoped auth context.

    Raises :class:`McpAuthError` (401) when the key is missing, unknown, or
    does not belong to ``org_id_header``; :class:`McpScopeError` (403) when the
    key carries no MCP scope; :class:`McpUnavailableError` (503) when the
    lookup itself could not run.

    ``org_id_header`` is required. Resolving a key without it would mean
    scanning every org's keys by hash, which ``validate_org_api_key`` does not
    support and which would be a slower, looser contract than the ingest and
    gateway paths use.
    """
    key = (api_key or "").strip()
    if not key:
        raise McpAuthError("API key required")

    org_header = (org_id_header or "").strip()
    if not org_header:
        raise McpAuthError("X-Org-Id required")

    try:
        from eden.api.deps import resolve_eden_org_id
        from eden.api.routes.api_keys import validate_org_api_key
    except Exception as exc:  # pragma: no cover - import guard
        logger.warning("mcp: auth machinery unavailable: %s", exc)
        raise McpUnavailableError("authentication unavailable") from exc

    try:
        eden_org_id = await resolve_eden_org_id(org_header)
    except Exception as exc:
        logger.warning("mcp: org resolve failed: %s", exc)
        raise McpUnavailableError("authentication unavailable") from exc

    if not eden_org_id:
        # Unknown org and invalid key are both 401: distinguishing them tells
        # an unauthenticated caller which org ids exist.
        raise McpAuthError("invalid credentials")

    try:
        row = await validate_org_api_key(str(eden_org_id), key)
    except Exception as exc:
        logger.warning("mcp: key validation raised: %s", exc)
        raise McpUnavailableError("authentication unavailable") from exc

    if not row:
        raise McpAuthError("invalid credentials")

    granted = _mcp_scopes_for(row)
    if not granted:
        raise McpScopeError("API key has no MCP scope")

    # org_id comes from the verified row, never from the header the caller
    # sent. This is the property the old mismatch check could not provide.
    return McpAuthContext(
        api_key=key,
        base_url=base_url,
        org_id=str(row.get("org_id") or eden_org_id),
        scopes=granted,
        transport="http",
    )


def _mcp_scopes_for(row: dict[str, Any]) -> tuple[str, ...]:
    """Intersect the key's stored scopes with the MCP scope vocabulary."""
    from eden.api.deps import MCP_SCOPES, expand_scope_aliases

    raw = row.get("scopes") or ()
    if isinstance(raw, str):
        raw = [raw]
    try:
        expanded = set(expand_scope_aliases(list(raw)))
    except Exception:  # noqa: BLE001 - alias table is best-effort
        expanded = set(raw)

    # A wildcard key gets the full MCP set; otherwise only what it holds.
    if expanded & {"*", "mcp:*"}:
        return ("mcp:read", "mcp:debug", "mcp:fix")
    return tuple(sorted(expanded & MCP_SCOPES))
