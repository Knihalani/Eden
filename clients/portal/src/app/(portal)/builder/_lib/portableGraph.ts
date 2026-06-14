/**
 * portableGraph — round-trip a builder graph to and from a
 * single JSON file. The format is a thin wrapper around the
 * in-memory shape so reloads are exact (no lossy YAML
 * reconstruction).
 *
 *   {
 *     "version": 1,
 *     "kind": "eden-builder-graph",
 *     "graphName": "My Eval",
 *     "nodes": [...EdenNode],
 *     "edges": [...EdenEdge],
 *     "yaml": "target:\n  module: agent\n..."
 *   }
 *
 * Importing a ``.json`` of this shape replaces the current
 * graph verbatim. Importing a raw YAML is *not* supported here
 * (the spec format is lossy for the visual graph — Tools,
 * Memory, Loop, Seed are emitted as lists/scalars without
 * their visual wiring). For YAML-only round-trip, the user
 * can paste into a future "YAML import" surface that ships
 * with the spec translator's reverse-direction support.
 */

import type { EdenEdge, EdenNode } from "./types";

export const PORTABLE_GRAPH_VERSION = 1;
export const PORTABLE_GRAPH_KIND = "eden-builder-graph";

export interface PortableGraph {
  version: number;
  kind: typeof PORTABLE_GRAPH_KIND;
  graphName: string;
  nodes: EdenNode[];
  edges: EdenEdge[];
  /** The currently-rendered eden-sim-eval.yaml, included so
   *  the file is self-describing even if the user opens it
   *  in a text editor. */
  yaml: string;
  exportedAt: string;
}

export function exportPortable(
  graphName: string,
  nodes: EdenNode[],
  edges: EdenEdge[],
  yaml: string,
): PortableGraph {
  return {
    version: PORTABLE_GRAPH_VERSION,
    kind: PORTABLE_GRAPH_KIND,
    graphName,
    nodes,
    edges,
    yaml,
    exportedAt: new Date().toISOString(),
  };
}

export type ImportResult =
  | { ok: true; graph: PortableGraph }
  | { ok: false; error: string };

export function importPortable(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "Top-level value is not an object." };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== PORTABLE_GRAPH_KIND) {
    return {
      ok: false,
      error: `Not an Eden builder graph (kind = ${JSON.stringify(obj.kind)}).`,
    };
  }
  if (typeof obj.version !== "number") {
    return { ok: false, error: "Missing or invalid 'version' field." };
  }
  if (obj.version > PORTABLE_GRAPH_VERSION) {
    return {
      ok: false,
      error: `Unsupported version ${obj.version} (this build supports ≤ ${PORTABLE_GRAPH_VERSION}).`,
    };
  }
  if (typeof obj.graphName !== "string") {
    return { ok: false, error: "Missing or invalid 'graphName'." };
  }
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    return { ok: false, error: "Missing or invalid 'nodes' / 'edges' arrays." };
  }
  // Defensive: every edge must reference a known node id.
  const ids = new Set((obj.nodes as unknown[]).map((n) => (n as { id: string }).id));
  for (const e of obj.edges as Array<{ source: string; target: string }>) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      return {
        ok: false,
        error: `Edge ${e.source} -> ${e.target} references an unknown node.`,
      };
    }
  }
  return {
    ok: true,
    graph: {
      version: obj.version,
      kind: PORTABLE_GRAPH_KIND,
      graphName: obj.graphName,
      nodes: obj.nodes as EdenNode[],
      edges: obj.edges as EdenEdge[],
      yaml: typeof obj.yaml === "string" ? obj.yaml : "",
      exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
    },
  };
}

/** Convenience: download a portable graph as a ``.builder.json`` file. */
export function downloadPortable(
  graphName: string,
  nodes: EdenNode[],
  edges: EdenEdge[],
  yaml: string,
): void {
  if (typeof window === "undefined") return;
  const file = exportPortable(graphName, nodes, edges, yaml);
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slugifyForFilename(graphName)}.builder.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slugifyForFilename(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "graph"
  );
}
