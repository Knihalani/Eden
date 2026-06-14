/**
 * tidyLayout — pure function that re-positions a DAG into a
 * clean top-down layered layout. Used by the "Tidy" button in
 * the toolbar so users can recover from a messy canvas.
 *
 * Algorithm: Kahn's topological sort → longest-path layering
 * → per-row horizontal placement. Cycles are tolerated
 * gracefully: nodes that never reach in-degree 0 land on a
 * single extra row below the layered DAG so they don't break
 * the layout or cause an infinite loop.
 *
 * The layout is deterministic given the same (nodes, edges)
 * input — important for tests and for React Flow's animation
 * when nodes move.
 */

import type { EdenNode, EdenEdge } from "./types";

const COL_GAP = 60;
const ROW_GAP = 130;
const NODE_WIDTH = 200;

export function tidyLayout(
  nodes: EdenNode[],
  edges: EdenEdge[],
): EdenNode[] {
  if (nodes.length === 0) return nodes;

  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);

  // Filter to edges that reference known nodes (defensive — the
  // translator already validates, but the layout should not
  // throw on a stale state).
  const liveEdges = edges.filter(
    (e) => idSet.has(e.source) && idSet.has(e.target),
  );

  // Kahn's algorithm: peel off roots, assign layered depth.
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const id of ids) {
    inDegree.set(id, 0);
    successors.set(id, []);
  }
  for (const e of liveEdges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    successors.get(e.source)!.push(e.target);
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      depth.set(id, 0);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    const d = depth.get(id) ?? 0;
    for (const next of successors.get(id) ?? []) {
      const nextD = d + 1;
      if ((depth.get(next) ?? -1) < nextD) depth.set(next, nextD);
      inDegree.set(next, (inDegree.get(next) ?? 1) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }

  // Any node not in `queue` is part of a cycle. Drop them on
  // an extra row at the bottom, left-aligned.
  const cyclic = ids.filter((id) => !depth.has(id));
  let maxRow = 0;
  for (const d of depth.values()) if (d > maxRow) maxRow = d;
  for (const id of cyclic) depth.set(id, maxRow + 1);

  // Group by depth (row).
  const rows = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d)!.push(id);
    if (d > maxRow) maxRow = d;
  }

  // Place each row horizontally.
  const positions = new Map<string, { x: number; y: number }>();
  for (let row = 0; row <= maxRow; row++) {
    const idsInRow = rows.get(row) ?? [];
    const totalWidth =
      idsInRow.length * NODE_WIDTH + (idsInRow.length - 1) * COL_GAP;
    const startX = -totalWidth / 2;
    idsInRow.forEach((id, i) => {
      positions.set(id, {
        x: startX + i * (NODE_WIDTH + COL_GAP),
        y: row * ROW_GAP,
      });
    });
  }

  return nodes.map((n) => {
    const p = positions.get(n.id);
    if (!p) return n;
    return { ...n, position: p };
  });
}
