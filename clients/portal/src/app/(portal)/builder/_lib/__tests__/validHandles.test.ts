// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  isValidHandlePair,
  makeIsValidConnection,
  rejectionReason,
} from "../validHandles";
import { makeBlockNode, type EdenNode } from "../types";

function node(kind: EdenNode["data"]["kind"]): EdenNode {
  return makeBlockNode(kind, { x: 0, y: 0 });
}

describe("isValidHandlePair", () => {
  it("accepts the five valid output -> scenario input pairs", () => {
    expect(isValidHandlePair("out:agent", "in:agent")).toBe(true);
    expect(isValidHandlePair("out:tool", "in:tool")).toBe(true);
    expect(isValidHandlePair("out:scoring", "in:scoring")).toBe(true);
    expect(isValidHandlePair("out:memory", "in:memory")).toBe(true);
    expect(isValidHandlePair("out:loop", "in:loop")).toBe(true);
  });

  it("rejects mismatched pairs", () => {
    expect(isValidHandlePair("out:agent", "in:tool")).toBe(false);
    expect(isValidHandlePair("out:tool", "in:agent")).toBe(false);
    expect(isValidHandlePair("out:scoring", "in:agent")).toBe(false);
  });

  it("rejects null handles", () => {
    expect(isValidHandlePair(null, "in:agent")).toBe(false);
    expect(isValidHandlePair("out:agent", null)).toBe(false);
    expect(isValidHandlePair(null, null)).toBe(false);
  });
});

describe("makeIsValidConnection", () => {
  it("returns false for self-loops", () => {
    const a = node("agent");
    const isValid = makeIsValidConnection([a]);
    expect(
      isValid({ source: a.id, target: a.id, sourceHandle: "out:agent", targetHandle: "in:agent" }),
    ).toBe(false);
  });

  it("returns false for missing nodes", () => {
    const a = node("agent");
    const s = node("scenario");
    const isValid = makeIsValidConnection([a, s]);
    expect(
      isValid({ source: "ghost", target: s.id, sourceHandle: "out:agent", targetHandle: "in:agent" }),
    ).toBe(false);
  });

  it("returns true for a valid Agent -> Scenario connection", () => {
    const a = node("agent");
    const s = node("scenario");
    const isValid = makeIsValidConnection([a, s]);
    expect(
      isValid({ source: a.id, target: s.id, sourceHandle: "out:agent", targetHandle: "in:agent" }),
    ).toBe(true);
  });

  it("returns false for an invalid Tool -> Memory connection", () => {
    const t = node("tool");
    const m = node("memory");
    const isValid = makeIsValidConnection([t, m]);
    expect(
      isValid({ source: t.id, target: m.id, sourceHandle: "out:tool", targetHandle: "in:memory" }),
    ).toBe(false);
  });
});

describe("rejectionReason", () => {
  it("explains missing source handle", () => {
    expect(rejectionReason(null, "in:agent")).toMatch(/Source handle/);
  });
  it("explains missing target handle", () => {
    expect(rejectionReason("out:agent", null)).toMatch(/Target handle/);
  });
  it("explains the offending pair", () => {
    expect(rejectionReason("out:tool", "in:agent")).toMatch(/cannot connect/);
  });
});
