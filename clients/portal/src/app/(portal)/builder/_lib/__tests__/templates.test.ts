// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { TEMPLATES } from "../templates";

describe("templates", () => {
  it("exposes at least 3 starter templates", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(3);
  });

  it("each template has a unique id, name, and emoji", () => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const t of TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.emoji).toBeTruthy();
      expect(ids.has(t.id)).toBe(false);
      expect(names.has(t.name)).toBe(false);
      ids.add(t.id);
      names.add(t.name);
    }
  });

  it("each template's build() returns a fresh valid graph", () => {
    for (const t of TEMPLATES) {
      const built = t.build();
      expect(built.graphName).toBeTruthy();
      expect(built.nodes.length).toBeGreaterThan(0);

      // Every edge's source/target must reference a node id.
      const nodeIds = new Set(built.nodes.map((n) => n.id));
      for (const e of built.edges) {
        expect(nodeIds.has(e.source)).toBe(true);
        expect(nodeIds.has(e.target)).toBe(true);
      }

      // Every Agent and every Scenario requirement: at least
      // one of each, since the spec translator requires both.
      const agents = built.nodes.filter((n) => n.data.kind === "agent");
      const scenarios = built.nodes.filter((n) => n.data.kind === "scenario");
      expect(agents).toHaveLength(1);
      expect(scenarios.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("build() is deterministic — repeated calls return the same graph", () => {
    // Templates use stable ids (so a user re-loading the same
    // template gets the same DAG they expect). The non-stable
    // blocks (Tool, Memory, Loop, Seed) get fresh random ids
    // per call, which is fine for a fresh-graph load.
    const a = TEMPLATES[0]!.build();
    const b = TEMPLATES[0]!.build();
    expect(b.graphName).toBe(a.graphName);
    expect(b.nodes.length).toBe(a.nodes.length);
    expect(b.edges.length).toBe(a.edges.length);
    // The deterministic Scenario id (passed as 3rd arg to
    // makeBlockNode) is the same.
    const aScenarios = a.nodes.filter((n) => n.data.kind === "scenario");
    const bScenarios = b.nodes.filter((n) => n.data.kind === "scenario");
    expect(bScenarios.map((s) => s.id).sort()).toEqual(
      aScenarios.map((s) => s.id).sort(),
    );
  });
});
