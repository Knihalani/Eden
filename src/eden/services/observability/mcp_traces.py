"""MCP trace service — D.12.1 (§8.1).

Reads from the ``mcp_traces_v`` view defined in migration 057
+ the ``mcp_server_auth_failures`` audit table.

Public surface:

* :class:`McpTraceService` — read-side queries
* :func:`get_mcp_service` — singleton getter (mirrors
  ``BudgetService`` / ``PromptService`` / ``OnboardingStateMachine``)

Ponytail: best-effort — DB errors fall through to ``[]`` so
the route layer never 500s. The view does the JSONB projection;
the service just runs the SELECT and returns the rows.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def _get_client():
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("mcp: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("mcp: get_postgres_client failed: %s", exc)
        return None


def _row(r: Any) -> dict[str, Any]:
    d = dict(r)
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


class McpTraceService:
    """Read-side queries for the MCP trace surface."""

    async def list_for_trace(
        self,
        trace_id: str,
        *,
        org_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return every MCP-typed telemetry event for a trace.

        Reads from the ``mcp_traces_v`` view — one row per
        telemetry_event that has an ``mcp`` sub-document.
        """
        client = await _get_client()
        if client is None:
            return []
        try:
            if org_id:
                rows = await client.fetch(
                    """
                    SELECT trace_id, org_id, mcp_server_name, mcp_tool_name,
                           mcp_resource_uri, mcp_prompt_name,
                           mcp_sampling, mcp_transport, created_at
                      FROM mcp_traces_v
                     WHERE trace_id = $1::uuid
                       AND org_id   = $2
                     ORDER BY created_at ASC
                    """,
                    trace_id, org_id,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT trace_id, org_id, mcp_server_name, mcp_tool_name,
                           mcp_resource_uri, mcp_prompt_name,
                           mcp_sampling, mcp_transport, created_at
                      FROM mcp_traces_v
                     WHERE trace_id = $1::uuid
                     ORDER BY created_at ASC
                    """,
                    trace_id,
                )
        except Exception as exc:
            logger.debug("mcp.list_for_trace failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def list_auth_failures(
        self,
        org_id: str,
        *,
        server_name: str | None = None,
        resolved: bool | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List MCP server auth failures for an org."""
        client = await _get_client()
        if client is None:
            return []
        try:
            where: list[str] = ["org_id = $1"]
            args: list[Any] = [org_id]
            if server_name is not None:
                where.append(f"server_name = ${len(args)+1}")
                args.append(server_name)
            if resolved is True:
                where.append("resolved_at IS NOT NULL")
            elif resolved is False:
                where.append("resolved_at IS NULL")
            args.append(int(limit))
            rows = await client.fetch(
                f"""
                SELECT id, org_id, server_name, transport, failure_kind,
                       error_message, trace_id, span_id,
                       occurred_at, resolved_at, resolved_by
                  FROM mcp_server_auth_failures
                 WHERE {' AND '.join(where)}
                 ORDER BY occurred_at DESC
                 LIMIT ${len(args)}
                """,
                *args,
            )
        except Exception as exc:
            logger.debug("mcp.list_auth_failures failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def record_auth_failure(
        self,
        org_id: str,
        *,
        server_name: str,
        failure_kind: str,
        transport: str | None = None,
        error_message: str | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> str | None:
        """Persist an MCP auth-failure row. Best-effort."""
        client = await _get_client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                """
                INSERT INTO mcp_server_auth_failures (
                    org_id, server_name, transport, failure_kind,
                    error_message, trace_id, span_id
                ) VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::uuid)
                RETURNING id
                """,
                org_id,
                server_name,
                transport,
                failure_kind,
                error_message,
                trace_id,
                span_id,
            )
            return str(row["id"]) if row else None
        except Exception as exc:
            logger.debug("mcp.record_auth_failure failed: %s", exc)
            return None


_singleton: McpTraceService | None = None


def get_mcp_service() -> McpTraceService:
    """Return the process-wide :class:`McpTraceService`."""
    global _singleton
    if _singleton is None:
        _singleton = McpTraceService()
    return _singleton


__all__ = ["McpTraceService", "get_mcp_service"]
