// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { tidyLayout } from "../layout";
import { makeBlockNode, type EdenEdge, type EdenNode } from "../types";

function makeEdge(
  source: EdenNode,
  target: EdenNode,
  sourceHandle = "out",
  targetHandle = "in",
): EdenEdge {
  return {
    id: `${source.id}->${target.id}`,
    source: source.id,
    target: target.id,
    sourceHandle,
    targetHandle,
    data: { kind: "data" },
  };
}

describe("tidyLayout", () => {
  it("returns the same nodes for an empty graph", () => {
    expect(tidyLayout([], [])).toEqual([]);
  });

  it("places two connected nodes on different rows", () => {
    const a = makeBlockNode("agent", { x: 0, y: 0 });
    const s = makeBlockNode("scenario", { x: 0, y: 0 });
    const out = tidyLayout([a, s], [makeEdge(a, s)]);
    expect(out[0]!.position.y).toBe(0);
    expect(out[1]!.position.y).toBe(130);
  });

  it("lays out a chain A -> B -> C with each on its own row", () => {
    const a = makeBlockNode("agent", { x: 0, y: 0 });
    const b = makeBlockNode("tool", { x: 0, y: 0 });
    const c = makeBlockNode("scenario", { x: 0, y: 0 });
    const out = tidyLayout([a, b, c], [makeEdge(a, b), makeEdge(b, c)]);
    const positions = Object.fromEntries(out.map((n) => [n.id, n.position.y]));
    expect(positions[a.id]).toBe(0);
    expect(positions[b.id]).toBe(130);
    expect(positions[c.id]).toBe(260);
  });

  it("takes the max parent depth when a node has multiple parents", () => {
    const a = makeBlockNode("agent", { x: 0, y: 0 });
    const t = makeBlockNode("tool", { x: 0, y: 0 });
    const s = makeBlockNode("scenario", { x: 0, y: 0 });
    // a -> t, a -> s, t -> s — s has parents a (depth 0) and t (depth 1) → depth 2
    const out = tidyLayout(
      [a, t, s],
      [makeEdge(a, t), makeEdge(a, s), makeEdge(t, s)],
    );
    const positions = Object.fromEntries(out.map((n) => [n.id, n.position.y]));
    expect(positions[s.id]).toBe(260);
  });

  it("handles cycles without infinite loop (cyclic nodes go on a single extra row)", () => {
    const a = makeBlockNode("agent", { x: 0, y: 0 });
    const t = makeBlockNode("tool", { x: 0, y: 0 });
    // a <-> t
    const out = tidyLayout(
      [a, t],
      [makeEdge(a, t), makeEdge(t, a)],
    );
    // Both should land on the same row (the cyclic row below
    // the layered DAG) — the function should not loop forever.
    expect(out[0]!.position.y).toBe(out[1]!.position.y);
  });

  it("centres each row horizontally (bounding box is symmetric)", () => {
    const a = makeBlockNode("agent", { x: 0, y: 0 });
    const b = makeBlockNode("agent", { x: 0, y: 0 });
    const c = makeBlockNode("agent", { x: 0, y: 0 });
    // Three roots, no edges.
    const out = tidyLayout([a, b, c], []);
    const xs = out.map((n) => n.position.x).sort((p, q) => p - q);
    // The bounding box of the row should be symmetric around 0.
    // leftmost_x = -totalWidth/2, rightmost_x + NODE_WIDTH = totalWidth/2
    // ⇒ rightmost_x - leftmost_x + NODE_WIDTH = totalWidth
    // ⇒ totalWidth = 3*200 + 2*60 = 720
    const leftmost = xs[0]!;
    const rightmost = xs[2]!;
    const boxWidth = rightmost + 200 - leftmost;
    expect(boxWidth).toBe(720);
    // The midpoint of the bounding box is ~0.
    expect((leftmost + rightmost + 200) / 2).toBeCloseTo(0, 5);
  });

  it("preserves node ids and other fields", () => {
    const a = makeBlockNode("agent", { x: 0, y: 0 });
    const out = tidyLayout([a], []);
    expect(out[0]!.id).toBe(a.id);
    expect(out[0]!.data.kind).toBe("agent");
  });
});
