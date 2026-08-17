import { describe, expect, test } from "bun:test";
import type { Step } from "../lib/types";
import { edgesOf, layoutDag, neighbor } from "./dag-layout";

const ticketish: Step[] = [
  { id: "lookup", kind: "tool", tool: "lookupTicket", args: { id: { kind: "input", path: "id" } } },
  { id: "details", kind: "tool", tool: "fetchDetails", args: { id: { kind: "input", path: "id" } } },
  {
    id: "parsed",
    kind: "tool",
    tool: "parseFields",
    args: { details: { kind: "from", step: "details", path: "" } },
  },
  {
    id: "valid",
    kind: "tool",
    tool: "validate",
    args: { fields: { kind: "from", step: "parsed", path: "" } },
  },
  { id: "validOk", kind: "assert", expr: "ok == true", onFail: "deopt" },
  {
    id: "draft",
    kind: "island",
    input: { kind: "from", step: "parsed", path: "" },
    system: "Draft a reply.",
    outputSchema: { type: "object" },
  },
  {
    id: "write",
    kind: "tool",
    tool: "writeRecord",
    args: {
      reply: { kind: "from", step: "draft", path: "text" },
      fields: { kind: "from", step: "parsed", path: "" },
    },
  },
  { id: "verify", kind: "tool", tool: "verifyWrite", args: { id: { kind: "input", path: "id" } } },
  { id: "verified", kind: "assert", expr: "verified == true", onFail: "error" },
  { id: "notify", kind: "tool", tool: "notify", args: { id: { kind: "input", path: "id" } } },
];

describe("layoutDag", () => {
  test("branches parsed into validate and draft instead of one row", () => {
    const { nodes } = layoutDag(ticketish);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId.parsed.col).toBeGreaterThan(byId.details.col);
    expect(byId.valid.col).toBe(byId.draft.col);
    expect(byId.valid.row).not.toBe(byId.draft.row);
    expect(byId.write.col).toBeGreaterThan(byId.draft.col);
    expect(new Set(nodes.map((n) => n.row)).size).toBeGreaterThan(1);
  });

  test("wires follow dataflow, not a necklace", () => {
    const edges = edgesOf(ticketish);
    expect(edges).toContainEqual({ from: "parsed", to: "draft" });
    expect(edges).toContainEqual({ from: "parsed", to: "valid" });
    expect(edges.some((e) => e.from === "lookup")).toBe(false);
    expect(edges.some((e) => e.from === "lookup" && e.to === "details")).toBe(false);
  });

  test("sequence-only stretches run left to right", () => {
    const seq: Step[] = [
      { id: "a", kind: "tool", tool: "lookupTicket", args: {} },
      { id: "b", kind: "tool", tool: "writeRecord", args: {} },
    ];
    const { nodes } = layoutDag(seq);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId.b.col).toBeGreaterThan(byId.a.col);
    expect(byId.a.row).toBe(byId.b.row);
  });

  test("arrow keys follow dataflow edges", () => {
    const { nodes } = layoutDag(ticketish);
    const edges = edgesOf(ticketish);
    expect(neighbor(nodes, "details", "right", edges)).toBe("parsed");
    expect(neighbor(nodes, "parsed", "left", edges)).toBe("details");
  });
});
