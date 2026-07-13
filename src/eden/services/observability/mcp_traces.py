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

    async def list_server_registry(self, org_id: str) -> list[dict[str, Any]]:
        """Fleet overview — registry table with live rollup fallback."""
        client = await _get_client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT org_id, server_name, first_seen, last_seen, tool_names,
                       transport, call_count_7d, error_rate_7d, p95_latency_ms,
                       auth_failure_count_7d, affected_agent_ids
                FROM mcp_server_registry
                WHERE org_id = $1
                ORDER BY call_count_7d DESC
                LIMIT 100
                """,
                org_id,
            )
            if rows:
                return [_row(r) for r in rows]
        except Exception as exc:
            logger.debug("mcp.list_server_registry table miss: %s", exc)

        # Live fallback from telemetry view.
        try:
            rows = await client.fetch(
                """
                SELECT mcp_server_name AS server_name,
                       COUNT(*)::bigint AS call_count_7d,
                       MIN(created_at) AS first_seen,
                       MAX(created_at) AS last_seen,
                       ARRAY_AGG(DISTINCT mcp_tool_name)
                           FILTER (WHERE mcp_tool_name IS NOT NULL) AS tool_names,
                       MAX(mcp_transport) AS transport
                FROM mcp_traces_v
                WHERE org_id = $1
                  AND created_at > NOW() - INTERVAL '7 days'
                GROUP BY mcp_server_name
                ORDER BY call_count_7d DESC
                LIMIT 100
                """,
                org_id,
            )
        except Exception as exc:
            logger.debug("mcp.list_server_registry fallback failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def list_tool_stats(
        self, org_id: str, server_name: str
    ) -> list[dict[str, Any]]:
        client = await _get_client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT tool_name, call_count_7d, error_rate_7d, p95_latency_ms
                FROM mcp_tool_stats
                WHERE org_id = $1 AND server_name = $2
                ORDER BY call_count_7d DESC
                """,
                org_id,
                server_name,
            )
            if rows:
                return [_row(r) for r in rows]
        except Exception as exc:
            logger.debug("mcp.list_tool_stats table miss: %s", exc)

        try:
            rows = await client.fetch(
                """
                SELECT mcp_tool_name AS tool_name,
                       COUNT(*)::bigint AS call_count_7d
                FROM mcp_traces_v
                WHERE org_id = $1
                  AND mcp_server_name = $2
                  AND created_at > NOW() - INTERVAL '7 days'
                GROUP BY mcp_tool_name
                ORDER BY call_count_7d DESC
                """,
                org_id,
                server_name,
            )
        except Exception as exc:
            logger.debug("mcp.list_tool_stats fallback failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def agent_server_graph(self, org_id: str) -> list[dict[str, Any]]:
        """Agent → MCP server edges for the fleet graph."""
        client = await _get_client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT agent_id, mcp_server_name AS server_name,
                       COUNT(*)::bigint AS call_count
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND attributes ? 'mcp'
                  AND created_at > NOW() - INTERVAL '7 days'
                  AND agent_id IS NOT NULL
                GROUP BY agent_id, mcp_server_name
                ORDER BY call_count DESC
                LIMIT 500
                """,
                org_id,
            )
        except Exception as exc:
            logger.debug("mcp.agent_server_graph failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def rollup_registry(self, org_id: str | None = None) -> dict[str, int]:
        """Cron rollup: merge telemetry into registry tables."""
        client = await _get_client()
        if client is None:
            return {"servers": 0, "tools": 0}
        where = ""
        args: list[Any] = []
        if org_id:
            where = "WHERE org_id = $1"
            args = [org_id]
        try:
            servers = await client.fetch(
                f"""
                SELECT org_id, mcp_server_name AS server_name,
                       MIN(created_at) AS first_seen,
                       MAX(created_at) AS last_seen,
                       COUNT(*)::bigint AS call_count_7d,
                       ARRAY_AGG(DISTINCT mcp_tool_name)
                           FILTER (WHERE mcp_tool_name IS NOT NULL) AS tool_names,
                       MAX(mcp_transport) AS transport
                FROM mcp_traces_v
                {where}
                GROUP BY org_id, mcp_server_name
                """,
                *args,
            )
        except Exception as exc:
            logger.debug("mcp.rollup_registry failed: %s", exc)
            return {"servers": 0, "tools": 0}

        n_servers = 0
        n_tools = 0
        for row in servers:
            n_servers += 1
            tools = row.get("tool_names") or []
            n_tools += len(tools)
            try:
                await client.execute(
                    """
                    INSERT INTO mcp_server_registry
                        (org_id, server_name, first_seen, last_seen, tool_names,
                         transport, call_count_7d)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (org_id, server_name) DO UPDATE SET
                        first_seen = LEAST(
                            mcp_server_registry.first_seen, EXCLUDED.first_seen
                        ),
                        last_seen = GREATEST(
                            mcp_server_registry.last_seen, EXCLUDED.last_seen
                        ),
                        tool_names = EXCLUDED.tool_names,
                        transport = COALESCE(
                            EXCLUDED.transport, mcp_server_registry.transport
                        ),
                        call_count_7d = EXCLUDED.call_count_7d
                    """,
                    row["org_id"],
                    row["server_name"],
                    row["first_seen"],
                    row["last_seen"],
                    tools,
                    row.get("transport"),
                    int(row["call_count_7d"] or 0),
                )
            except Exception as exc:
                logger.debug("mcp.rollup_registry upsert server failed: %s", exc)

        return {"servers": n_servers, "tools": n_tools}

    async def sre_summary(self, org_id: str) -> dict[str, Any]:
        """D4 — org-level MCP boundary SRE rollup."""
        servers = await self.list_server_registry(org_id)
        auth_failures = await self.list_auth_failures(
            org_id, resolved=False, limit=50
        )
        graph = await self.agent_server_graph(org_id)
        isolated: list[str] = []
        for srv in servers:
            name = str(srv.get("server_name") or "")
            err_rate = float(srv.get("error_rate_7d") or 0.0)
            auth_n = int(srv.get("auth_failure_count_7d") or 0)
            if auth_n >= 3 or err_rate >= 0.25:
                isolated.append(name)
        return {
            "server_count": len(servers),
            "open_auth_failures": len(auth_failures),
            "agent_edges": len(graph),
            "auto_isolated_servers": isolated,
            "servers": servers[:20],
            "recent_auth_failures": auth_failures[:10],
        }

    async def call_trends(
        self, org_id: str, *, days: int = 7
    ) -> list[dict[str, Any]]:
        """Daily MCP call + auth-failure buckets for the fleet dashboard."""
        days = max(1, min(days, 90))
        client = await _get_client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT date_trunc('day', created_at)::date AS day,
                       COUNT(*)::bigint AS call_count,
                       COUNT(*) FILTER (
                           WHERE attributes->'mcp'->>'auth_failure' = 'true'
                       )::bigint AS auth_failure_count
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND attributes ? 'mcp'
                  AND created_at > NOW() - make_interval(days => $2)
                GROUP BY 1
                ORDER BY 1 ASC
                """,
                org_id,
                days,
            )
        except Exception as exc:
            logger.debug("mcp.call_trends failed: %s", exc)
            return []
        return [
            {
                "day": str(row["day"]),
                "call_count": int(row["call_count"] or 0),
                "auth_failure_count": int(row["auth_failure_count"] or 0),
            }
            for row in rows
        ]


_singleton: McpTraceService | None = None


def get_mcp_service() -> McpTraceService:
    """Return the process-wide :class:`McpTraceService`."""
    global _singleton
    if _singleton is None:
        _singleton = McpTraceService()
    return _singleton


__all__ = ["McpTraceService", "get_mcp_service"]
