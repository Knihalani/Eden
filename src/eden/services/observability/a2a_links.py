"""A2A link service — D.12.2 (§8.2).

Persists + reads ``a2a_links`` rows (parent_trace_id,
child_trace_id, agent_ids, invocation_type, response_status).
Per spec §B.5 + §E.1 the ``on_a2a_invocation_failed`` hook
fires when a link is marked failed.

Ponytail: best-effort — DB errors fall through to ``[]`` /
``None`` so the route layer never 500s. The service is the
only thing that talks to ``a2a_links``; routes are thin.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def _get_client():
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("a2a: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("a2a: get_postgres_client failed: %s", exc)
        return None


def _row(r: Any) -> dict[str, Any]:
    d = dict(r)
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


class A2ALinkService:
    """CRUD over the ``a2a_links`` table."""

    async def register_link(
        self,
        org_id: str,
        *,
        parent_trace_id: str,
        child_trace_id: str,
        parent_agent_id: str,
        child_agent_id: str,
        parent_span_id: str,
        invocation_type: str,
        response_status: str | None = None,
    ) -> str | None:
        """Insert (or upsert) a link row. Returns the row id."""
        client = await _get_client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                """
                INSERT INTO a2a_links (
                    id, org_id, parent_trace_id, child_trace_id,
                    parent_agent_id, child_agent_id,
                    parent_span_id, invocation_type, response_status
                ) VALUES (
                    gen_random_uuid(), $1, $2::uuid, $3::uuid,
                    $4::uuid, $5::uuid,
                    $6::uuid, $7, $8
                )
                ON CONFLICT (parent_trace_id, parent_span_id, child_trace_id)
                DO UPDATE SET response_status = COALESCE(
                    EXCLUDED.response_status, a2a_links.response_status
                )
                RETURNING id
                """,
                org_id,
                parent_trace_id,
                child_trace_id,
                parent_agent_id,
                child_agent_id,
                parent_span_id,
                invocation_type,
                response_status,
            )
            return str(row["id"]) if row else None
        except Exception as exc:
            logger.debug("a2a.register_link failed: %s", exc)
            return None

    async def get_links_for_trace(
        self,
        trace_id: str,
        *,
        org_id: str | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """Return ``{parent: [...], children: [...]}`` for a trace.

        ``parent``: rows where this trace is the child (i.e. we
        were invoked by another agent).
        ``children``: rows where this trace is the parent (i.e.
        we invoked another agent).
        """
        client = await _get_client()
        if client is None:
            return {"parent": [], "children": []}
        try:
            where = ["(parent_trace_id = $1::uuid OR child_trace_id = $1::uuid)"]
            args: list[Any] = [trace_id]
            if org_id is not None:
                where.append(f"org_id = ${len(args)+1}")
                args.append(org_id)
            rows = await client.fetch(
                f"""
                SELECT id, org_id, parent_trace_id, child_trace_id,
                       parent_agent_id, child_agent_id, parent_span_id,
                       invocation_type, response_status, error_kind,
                       created_at
                  FROM a2a_links
                 WHERE {' AND '.join(where)}
                 ORDER BY created_at ASC
                """,
                *args,
            )
        except Exception as exc:
            logger.debug("a2a.get_links_for_trace failed: %s", exc)
            return {"parent": [], "children": []}
        parent: list[dict[str, Any]] = []
        children: list[dict[str, Any]] = []
        for r in rows:
            d = _row(r)
            if d.get("child_trace_id") == trace_id:
                parent.append(d)
            else:
                children.append(d)
        return {"parent": parent, "children": children}

    async def get_invocation_graph(
        self,
        trace_id: str,
        *,
        org_id: str | None = None,
        max_depth: int = 4,
    ) -> dict[str, Any]:
        """BFS up + down from a trace. Returns nodes + edges.

        ``nodes`` = {trace_id: {trace_id, is_root, depth}}
        ``edges`` = [{parent_trace_id, child_trace_id, ...}]
        """
        client = await _get_client()
        if client is None:
            return {"nodes": {}, "edges": []}
        try:
            # $1 = trace_id (up-side seed: child_trace_id = trace_id)
            # $2 = trace_id (down-side seed: parent_trace_id = trace_id)
            # $3 = max_depth (up-side recursion bound)
            # $4 = max_depth (down-side recursion bound)
            args: list[Any] = [trace_id, trace_id, int(max_depth), int(max_depth)]
            org_clause = ""
            if org_id is not None:
                org_clause = f"AND org_id = ${len(args)+1}"
                args.append(org_id)
            # Recursive CTE: BFS up (parent chain) + BFS down (children).
            rows = await client.fetch(
                f"""
                WITH RECURSIVE up AS (
                    SELECT id, parent_trace_id, child_trace_id,
                           parent_agent_id, child_agent_id,
                           parent_span_id, invocation_type,
                           response_status, error_kind, created_at,
                           0 AS depth, child_trace_id AS trace
                      FROM a2a_links
                     WHERE child_trace_id = $1::uuid
                       {org_clause}
                    UNION ALL
                    SELECT l.id, l.parent_trace_id, l.child_trace_id,
                           l.parent_agent_id, l.child_agent_id,
                           l.parent_span_id, l.invocation_type,
                           l.response_status, l.error_kind, l.created_at,
                           up.depth + 1, l.child_trace_id
                      FROM a2a_links l
                      JOIN up ON l.child_trace_id = up.parent_trace_id
                     WHERE up.depth + 1 < $3
                ),
                down AS (
                    SELECT id, parent_trace_id, child_trace_id,
                           parent_agent_id, child_agent_id,
                           parent_span_id, invocation_type,
                           response_status, error_kind, created_at,
                           0 AS depth, parent_trace_id AS trace
                      FROM a2a_links
                     WHERE parent_trace_id = $2::uuid
                       {org_clause}
                    UNION ALL
                    SELECT l.id, l.parent_trace_id, l.child_trace_id,
                           l.parent_agent_id, l.child_agent_id,
                           l.parent_span_id, l.invocation_type,
                           l.response_status, l.error_kind, l.created_at,
                           down.depth + 1, l.parent_trace_id
                      FROM a2a_links l
                      JOIN down ON l.parent_trace_id = down.child_trace_id
                     WHERE down.depth + 1 < $4
                )
                SELECT DISTINCT * FROM (
                    SELECT * FROM up
                    UNION ALL
                    SELECT * FROM down
                ) all_rows
                ORDER BY depth, created_at
                """,
                *args,
            )
        except Exception as exc:
            logger.debug("a2a.get_invocation_graph failed: %s", exc)
            return {"nodes": {}, "edges": []}
        nodes: dict[str, dict[str, Any]] = {
            trace_id: {
                "trace_id": trace_id,
                "is_root": True,
                "depth": 0,
            }
        }
        edges: list[dict[str, Any]] = []
        for r in rows:
            d = _row(r)
            edges.append({
                "id": d.get("id"),
                "parent_trace_id": d.get("parent_trace_id"),
                "child_trace_id": d.get("child_trace_id"),
                "parent_agent_id": d.get("parent_agent_id"),
                "child_agent_id": d.get("child_agent_id"),
                "parent_span_id": d.get("parent_span_id"),
                "invocation_type": d.get("invocation_type"),
                "response_status": d.get("response_status"),
                "error_kind": d.get("error_kind"),
                "created_at": d.get("created_at"),
                "depth": d.get("depth"),
            })
            for tid in (d.get("parent_trace_id"), d.get("child_trace_id")):
                if tid and tid not in nodes:
                    nodes[tid] = {
                        "trace_id": tid,
                        "is_root": False,
                        "depth": int(d.get("depth") or 0),
                    }
        return {"nodes": nodes, "edges": edges}

    async def mark_failed(
        self,
        link_id: str,
        *,
        error_kind: str,
    ) -> bool:
        """Update ``response_status='failed'`` + ``error_kind``.

        Fires the ``on_a2a_invocation_failed`` hook on success.
        """
        client = await _get_client()
        if client is None:
            return False
        try:
            row = await client.fetchrow(
                """
                UPDATE a2a_links
                   SET response_status = 'failed',
                       error_kind      = $2
                 WHERE id = $1::uuid
                 RETURNING id, org_id, parent_trace_id, child_trace_id,
                           invocation_type
                """,
                link_id, error_kind,
            )
        except Exception as exc:
            logger.debug("a2a.mark_failed update failed: %s", exc)
            return False
        if row is None:
            return False
        try:
            from eden.llmops.promotion_hooks import PromotionHook
            hook = PromotionHook()
            await hook.on_a2a_invocation_failed(
                str(row["org_id"]),
                parent_trace_id=str(row["parent_trace_id"]),
                child_trace_id=str(row["child_trace_id"]) if row["child_trace_id"] else None,
                invocation_type=str(row["invocation_type"]),
                error_kind=error_kind,
            )
        except Exception as exc:
            logger.debug("a2a.mark_failed: hook fire failed: %s", exc)
        return True


_singleton: A2ALinkService | None = None


def get_a2a_service() -> A2ALinkService:
    """Return the process-wide :class:`A2ALinkService`."""
    global _singleton
    if _singleton is None:
        _singleton = A2ALinkService()
    return _singleton


__all__ = ["A2ALinkService", "get_a2a_service"]
