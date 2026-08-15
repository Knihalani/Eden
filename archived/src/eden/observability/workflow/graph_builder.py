"""Workflow graph builder (Cat 1).

Converts a stored trace's events into a renderable graph
(nodes + edges) suitable for Cytoscape, React Flow, or Mermaid.
A "node" is a span (agent, tool call, retrieval, model call,
memory access, or final output); an "edge" is the
``parent_span_id -> span_id`` relationship.

Real implementation walks the ``telemetry_events`` table for
the trace, groups by ``span_id``, and emits:

* ``nodes`` — one per distinct span, with
  ``id, label, type, duration_ms, error, agent_id, position``.
* ``edges`` — one per parent->child relationship.

A simple deterministic BFS layout (``layout``) annotates the
nodes with x/y coordinates so the front-end doesn't need a
client-side dagre / elk. A real layered layout is a
follow-up PR; the BFS layout is good enough for traces up
to ~1k spans and tests can assert on its output shape.

The graph is persisted to ``trace_workflow_graphs`` for
caching so subsequent renders are O(1) reads.

See ``docs/observability-gap/01-trace-replay.md``.
"""

from __future__ import annotations

import logging
from collections import deque
from typing import Any

from eden.observability._trace_common import (
    fetch_all_trace_events,
    json_dumps,
    not_found_envelope,
    ok_envelope,
    upsert_workflow_graph,
)

logger = logging.getLogger(__name__)


# Spacing constants for the deterministic BFS layout. Tuned
# so a 100-span trace fits in a 2000x1000 box; the front-end
# can re-scale as needed.
_LAYOUT_X_STEP = 220
_LAYOUT_Y_STEP = 110
_LAYOUT_ROOT_X = 80
_LAYOUT_ROOT_Y = 60


class WorkflowGraphBuilder:
    """Build a Cytoscape-style graph of one trace."""

    name = "workflow_graph"

    async def build(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        """Return ``{nodes, edges}`` for the trace.

        Persists the built graph to ``trace_workflow_graphs``
        so the front-end can skip the build on subsequent
        renders. Best-effort cache — a write failure doesn't
        block the response.
        """
        rows = await fetch_all_trace_events(org_id, trace_id)
        if not rows:
            return not_found_envelope(self.name, trace_id)

        # Group events by span_id. The TelemetryCollector emits
        # one row per span start/end pair, so multiple events
        # may share a span_id (e.g. "span.start" and "span.end").
        # We collapse them to one node per span by keeping the
        # "end" event when present (it has the final
        # duration_ms and outcome) and falling back to the
        # first event.
        span_map: dict[str, dict[str, Any]] = {}
        for row in rows:
            span_id = row.get("span_id") or row.get("event_id")
            if not span_id:
                continue
            existing = span_map.get(span_id)
            if existing is None:
                span_map[span_id] = row
                continue
            # Prefer the row with a non-null outcome or duration_ms.
            if (
                row.get("outcome") and not existing.get("outcome")
            ) or (
                row.get("duration_ms")
                and not existing.get("duration_ms")
            ):
                span_map[span_id] = row

        nodes: list[dict[str, Any]] = []
        for span_id, row in span_map.items():
            nodes.append(_build_node(span_id, row))

        edges: list[dict[str, Any]] = []
        for span_id, row in span_map.items():
            parent = row.get("parent_span_id")
            if parent and parent in span_map:
                edges.append({"from": parent, "to": span_id})

        # Annotate with x/y positions. Sort is stable so the
        # output is deterministic across renders — important
        # for the persistence cache.
        graph = {
            "nodes": nodes,
            "edges": edges,
        }
        graph = self.layout(graph)

        # Cache the graph for subsequent renders.
        try:
            await upsert_workflow_graph(
                org_id, trace_id, graph_json=json_dumps(graph)
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("workflow_graph: cache write failed: %s", exc)

        return ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "node_count": len(nodes),
                "edge_count": len(edges),
                **graph,
            },
        )

    async def subgraph(
        self,
        org_id: str,
        trace_id: str,
        *,
        root_span_id: str,
    ) -> dict[str, Any]:
        """Return the sub-DAG rooted at ``root_span_id``.

        BFS-walked from the root, includes only the root and
        its descendants. Does NOT write to the cache (the
        subgraph is caller-provided; caching the same
        sub-DAG under multiple roots would inflate the
        table).
        """
        rows = await fetch_all_trace_events(org_id, trace_id)
        if not rows:
            return not_found_envelope(self.name, trace_id)

        span_map: dict[str, dict[str, Any]] = {}
        for row in rows:
            span_id = row.get("span_id") or row.get("event_id")
            if not span_id:
                continue
            existing = span_map.get(span_id)
            if existing is None or (
                row.get("outcome") and not existing.get("outcome")
            ):
                span_map[span_id] = row

        if root_span_id not in span_map:
            return ok_envelope(
                self.name,
                {
                    "trace_id": trace_id,
                    "root_span_id": root_span_id,
                    "node_count": 0,
                    "edge_count": 0,
                    "nodes": [],
                    "edges": [],
                    "message": "root span not in trace",
                },
            )

        # BFS from the root.
        visited: set[str] = {root_span_id}
        queue: deque[str] = deque([root_span_id])
        children_idx: dict[str, list[str]] = {sid: [] for sid in span_map}
        for sid, row in span_map.items():
            p = row.get("parent_span_id")
            if p and p in span_map:
                children_idx.setdefault(p, []).append(sid)

        while queue:
            current = queue.popleft()
            for child in children_idx.get(current, []):
                if child in visited:
                    continue
                visited.add(child)
                queue.append(child)

        sub_nodes: list[dict[str, Any]] = []
        for sid in visited:
            row = span_map.get(sid)
            if row is not None:
                sub_nodes.append(_build_node(sid, row))

        sub_edges: list[dict[str, Any]] = []
        for sid in visited:
            row = span_map.get(sid)
            if row is None:
                continue
            parent = row.get("parent_span_id")
            if parent and parent in visited:
                sub_edges.append({"from": parent, "to": sid})

        graph = self.layout({"nodes": sub_nodes, "edges": sub_edges})

        return ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "root_span_id": root_span_id,
                "node_count": len(sub_nodes),
                "edge_count": len(sub_edges),
                **graph,
            },
        )

    def layout(
        self,
        graph: dict[str, Any],
    ) -> dict[str, Any]:
        """Annotate ``graph['nodes']`` with x/y positions.

        Deterministic BFS from the root nodes (those without a
        parent edge). Returns the input graph with a
        ``position: {x, y}`` dict added to each node.

        The layout is a left-to-right tree: root nodes start
        at x=80, each level of descendants moves right by
        ``_LAYOUT_X_STEP``, and siblings within a level are
        stacked vertically with ``_LAYOUT_Y_STEP`` between
        them.

        Cycles are broken by stopping the BFS at already-
        visited nodes (a node may appear at multiple levels
        if the graph has cycles; it just keeps its first
        position).
        """
        nodes = graph.get("nodes") or []
        edges = graph.get("edges") or []

        # Build adjacency: parent -> [child, ...]
        children: dict[str, list[str]] = {}
        node_ids: set[str] = set()
        for n in nodes:
            nid = n.get("id")
            if nid is None:
                continue
            node_ids.add(nid)
            children.setdefault(nid, [])
        for e in edges:
            src = e.get("from")
            dst = e.get("to")
            if src in node_ids and dst in node_ids:
                children.setdefault(src, []).append(dst)

        # Find roots: nodes that no edge points to as a child.
        # More robust than "no parent_span_id" because the
        # caller may have already filtered to a sub-DAG.
        has_parent: set[str] = set()
        for e in edges:
            has_parent.add(e.get("to"))
        roots = [nid for nid in node_ids if nid not in has_parent]
        # Stable order: sort alphabetically so the layout is
        # deterministic across renders.
        roots.sort()

        positions: dict[str, tuple[int, int]] = {}
        visited: set[str] = set()
        # Multi-root BFS. Each root gets its own column.
        for col, root in enumerate(roots):
            x = _LAYOUT_ROOT_X + col * (_LAYOUT_X_STEP // 2)
            queue: deque[tuple[str, int]] = deque([(root, 0)])
            local_visited: set[str] = set()
            # Track y per (level, column) so siblings stack.
            level_y: dict[int, int] = {}
            while queue:
                node, level = queue.popleft()
                if node in local_visited:
                    continue
                local_visited.add(node)
                y = _LAYOUT_ROOT_Y + level_y.get(level, 0) * _LAYOUT_Y_STEP
                level_y[level] = level_y.get(level, 0) + 1
                positions[node] = (x, y)
                visited.add(node)
                for child in children.get(node, []):
                    if child in local_visited:
                        continue
                    queue.append((child, level + 1))

        # Any orphaned nodes (not reachable from a root, e.g.
        # a span whose parent is missing) get a default
        # position past the last root column.
        orphans = [nid for nid in node_ids if nid not in visited]
        orphans.sort()
        for idx, nid in enumerate(orphans):
            x = _LAYOUT_ROOT_X + (len(roots) + idx) * (_LAYOUT_X_STEP // 2)
            y = _LAYOUT_ROOT_Y
            positions[nid] = (x, y)

        for n in nodes:
            nid = n.get("id")
            if nid in positions:
                x, y = positions[nid]
                n["position"] = {"x": int(x), "y": int(y)}
            else:
                n["position"] = {"x": 0, "y": 0}

        return {"nodes": nodes, "edges": edges}


def _build_node(span_id: str, row: dict[str, Any]) -> dict[str, Any]:
    """Build a graph node dict from one telemetry_events row."""
    payload = row.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}
    # The "label" picks a friendly short name. Order of
    # preference: span name (most descriptive), the
    # payload.tool_call.name (for tool calls), then the
    # event_type. Empty / null fall back to event_type.
    label = (
        row.get("name")
        or (
            isinstance(payload.get("tool_call"), dict)
            and payload["tool_call"].get("name")
        )
        or (
            isinstance(payload.get("tool_call"), str)
            and payload["tool_call"]
        )
        or row.get("event_type")
        or span_id
    )
    return {
        "id": span_id,
        "label": label,
        "type": row.get("event_type"),
        "name": row.get("name"),
        "duration_ms": row.get("duration_ms"),
        "outcome": row.get("outcome"),
        "error": row.get("error"),
        "agent_id": row.get("agent_id"),
        "timestamp": (
            row["timestamp"].isoformat()
            if hasattr(row.get("timestamp"), "isoformat")
            else row.get("timestamp")
        ),
        "parent_span_id": row.get("parent_span_id"),
    }
