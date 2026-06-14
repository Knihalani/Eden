// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  exportPortable,
  importPortable,
  PORTABLE_GRAPH_KIND,
  PORTABLE_GRAPH_VERSION,
  slugifyForFilename,
} from "../portableGraph";
import { makeBlockNode, type EdenNode } from "../types";

function makeAgent(): EdenNode {
  return makeBlockNode("agent", { x: 0, y: 0 });
}
function makeScenario(): EdenNode {
  return makeBlockNode(
    "scenario",
    { x: 200, y: 0 },
    "scenario_x",
  );
}

describe("exportPortable", () => {
  it("produces a versioned, kind-tagged wrapper", () => {
    const agent = makeAgent();
    const out = exportPortable("My Graph", [agent], [], "target: { module: agent }");
    expect(out.version).toBe(PORTABLE_GRAPH_VERSION);
    expect(out.kind).toBe(PORTABLE_GRAPH_KIND);
    expect(out.graphName).toBe("My Graph");
    expect(out.nodes).toHaveLength(1);
    expect(out.yaml).toContain("target:");
    expect(typeof out.exportedAt).toBe("string");
  });
});

describe("importPortable", () => {
  it("rejects non-JSON input", () => {
    const result = importPortable("not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Invalid JSON/);
  });

  it("rejects top-level non-object", () => {
    const result = importPortable('"hello"');
    expect(result.ok).toBe(false);
  });

  it("rejects wrong kind", () => {
    const result = importPortable(
      JSON.stringify({ kind: "something-else", version: 1, graphName: "x", nodes: [], edges: [] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Eden builder graph/);
  });

  it("rejects future versions", () => {
    const result = importPortable(
      JSON.stringify({
        kind: PORTABLE_GRAPH_KIND,
        version: PORTABLE_GRAPH_VERSION + 10,
        graphName: "x",
        nodes: [],
        edges: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Unsupported version/);
  });

  it("rejects edges that reference unknown nodes", () => {
    const agent = makeAgent();
    const result = importPortable(
      JSON.stringify({
        kind: PORTABLE_GRAPH_KIND,
        version: 1,
        graphName: "x",
        nodes: [agent],
        edges: [{ id: "e1", source: "ghost", target: agent.id, data: { kind: "data" } }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unknown node/);
  });

  it("round-trips a graph verbatim", () => {
    const agent = makeAgent();
    const scenario = makeScenario();
    const original = exportPortable(
      "Round trip",
      [agent, scenario],
      [
        {
          id: `${agent.id}->${scenario.id}`,
          source: agent.id,
          target: scenario.id,
          sourceHandle: "out:agent",
          targetHandle: "in:agent",
          data: { kind: "data" },
        },
      ],
      "target:\n  module: agent\n",
    );
    const result = importPortable(JSON.stringify(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.graphName).toBe("Round trip");
    expect(result.graph.nodes).toHaveLength(2);
    expect(result.graph.edges).toHaveLength(1);
  });
});

describe("slugifyForFilename", () => {
  it("strips unsafe characters", () => {
    expect(slugifyForFilename("My Eval / v2!")).toBe("my-eval-v2");
  });
  it("returns 'graph' for empty input", () => {
    expect(slugifyForFilename("")).toBe("graph");
  });
});
