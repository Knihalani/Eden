"""Cat 10 v2 — :class:`DataLineageService`.

Traces the data lineage for a given resource (trace_id /
outcome_id / user_id) across the existing Eden tables.

v0 traces:

* ``usage_events`` (the LLM call ledger) →
* ``outcomes`` (the business-outcome attach) →
* ``org_audit_log`` (the privileged-action record)

v2 expands to the LLM call → tool call → outcome chain via
``trace_workflow_graphs`` (Cat 1) + ``tool_attributions``
(Cat 7) — that work ships in the v2.1 doc.

This is the data-side answer to the auditor's "where did this
data go?" — the dashboard renders it as a graph; the SDK
returns the raw nodes + edges.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.services.governance_intel._common import (
    _bad_request_envelope,
    _get_client,
    _new_id,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


#: Resource types the v0 service recognises. Aliases supported:
#: ``"trace"`` ↔ ``"trace_id"``; ``"outcome"`` ↔ ``"outcome_id"``;
#: ``"user"`` ↔ ``"user_id"``.
_RESOURCE_TYPES: dict[str, str] = {
    "trace": "trace_id",
    "trace_id": "trace_id",
    "outcome": "outcome_id",
    "outcome_id": "outcome_id",
    "user": "user_id",
    "user_id": "user_id",
}


class DataLineageService:
    """Trace data lineage across the Eden tables for an auditor."""

    name = "data_lineage"

    async def trace(
        self,
        org_id: str,
        *,
        resource_type: str,
        resource_id: str,
        depth: int = 2,
    ) -> dict[str, Any]:
        """Return the lineage graph for ``resource_id``.

        Args:
            resource_type: ``"trace"`` / ``"outcome"`` /
                ``"user"`` (or the ``_id`` long form).
            resource_id: the key value to query.
            depth: max BFS depth. Bounded to ``[1, 4]``.

        Returns:
            ``{"nodes": [...], "edges": [...]}`` shape suitable
            for D3 / Cytoscape rendering.
        """
        canon = _RESOURCE_TYPES.get(
            (resource_type or "").strip().lower()
        )
        if canon is None:
            return _bad_request_envelope(
                self.name,
                f"resource_type must be one of "
                f"{sorted(set(_RESOURCE_TYPES.values()))}",
            )
        if not isinstance(resource_id, str) or not resource_id.strip():
            return _bad_request_envelope(
                self.name, "resource_id is required",
            )
        depth = max(1, min(4, int(depth)))

        client = await _get_client()

        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

        # Seed
        root = (canon, resource_id)
        seen.add(root)
        nodes.append(
            {"id": _node_id(canon, resource_id), "type": canon,
             "key": resource_id, "depth": 0}
        )

        frontier: list[tuple[str, str, int]] = [
            (canon, resource_id, 0)
        ]

        # BFS up to ``depth`` hops
        while frontier:
            (kind, key, hop) = frontier.pop(0)
            if hop >= depth:
                continue
            neighbours = await self._neighbours_of(
                client, org_id, kind, key,
            )
            for n_kind, n_key, edge_label in neighbours:
                pair = (n_kind, n_key)
                if pair in seen:
                    continue
                seen.add(pair)
                nodes.append(
                    {"id": _node_id(n_kind, n_key), "type": n_kind,
                     "key": n_key, "depth": hop + 1}
                )
                edges.append({
                    "from": _node_id(kind, key),
                    "to": _node_id(n_kind, n_key),
                    "label": edge_label,
                })
                frontier.append((n_kind, n_key, hop + 1))

        return _ok_envelope(
            self.name,
            {
                "lineage_id": _new_id("lin"),
                "root": {"type": canon, "key": resource_id},
                "depth": depth,
                "nodes": nodes,
                "edges": edges,
                "node_count": len(nodes),
                "edge_count": len(edges),
            },
        )

    # ── BFS step ──────────────────────────────────────────────────

    async def _neighbours_of(
        self,
        client: Any,
        org_id: str,
        kind: str,
        key: str,
    ) -> list[tuple[str, str, str]]:
        """Return the direct neighbours of a ``(kind, key)`` node.

        Edges currently traced (each is a Postgres query):

        * ``trace_id``   → ``outcome_id`` via :sql:`outcomes`
        * ``trace_id``   → ``user_id``    via :sql:`telemetry_events`
        * ``outcome_id`` → ``trace_id``   via :sql:`outcomes`
        * ``user_id``    → ``trace_id``   via :sql:`telemetry_events`
        * any            → ``audit_log_id`` via :sql:`org_audit_log`
        """
        if client is None:
            return []
        out: list[tuple[str, str, str]] = []

        try:
            if kind == "trace_id":
                # → outcome
                rows = await client.fetch(
                    "SELECT id FROM outcomes "
                    "WHERE org_id = $1 AND trace_id = $2 LIMIT 50",
                    org_id, key,
                )
                for r in rows or []:
                    if r.get("id"):
                        out.append(
                            ("outcome_id", str(r["id"]), "produced")
                        )
                # → user
                rows = await client.fetch(
                    "SELECT DISTINCT user_id FROM telemetry_events "
                    "WHERE org_id = $1 AND trace_id = $2 LIMIT 50",
                    org_id, key,
                )
                for r in rows or []:
                    uid = r.get("user_id")
                    if uid:
                        out.append(
                            ("user_id", str(uid), "actor")
                        )

            elif kind == "outcome_id":
                rows = await client.fetch(
                    "SELECT trace_id FROM outcomes "
                    "WHERE org_id = $1 AND id = $2 LIMIT 1",
                    org_id, key,
                )
                for r in rows or []:
                    tid = r.get("trace_id")
                    if tid:
                        out.append(
                            ("trace_id", str(tid), "from_trace")
                        )

            elif kind == "user_id":
                rows = await client.fetch(
                    "SELECT DISTINCT trace_id FROM telemetry_events "
                    "WHERE org_id = $1 AND user_id = $2 "
                    "ORDER BY trace_id LIMIT 50",
                    org_id, key,
                )
                for r in rows or []:
                    tid = r.get("trace_id")
                    if tid:
                        out.append(
                            ("trace_id", str(tid), "ran_trace")
                        )

            # Always pull audit-log rows that target this kind/key —
            # they show governance touches.
            rows = await client.fetch(
                "SELECT id FROM org_audit_log "
                "WHERE org_id = $1 AND target_type = $2 "
                "AND target_id = $3 ORDER BY created_at DESC LIMIT 20",
                org_id, kind.replace("_id", ""), key,
            )
            for r in rows or []:
                if r.get("id"):
                    out.append(
                        ("audit_log_id", str(r["id"]), "audit")
                    )

        except Exception as exc:
            logger.debug(
                "lineage.neighbours_of failed for %s/%s: %s",
                kind, key, exc,
            )

        return out


def _node_id(kind: str, key: str) -> str:
    """Stable id for the lineage node — used as the source/target
    in edges and as the SVG ``id`` attribute on the front-end.
    """
    return f"{kind}:{key}"
