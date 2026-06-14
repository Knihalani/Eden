// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  previewYaml,
  renderYaml,
  translate,
  validate,
} from "../specTranslator";
import {
  DEFAULT_SEED,
  makeBlockNode,
  type EdenEdge,
  type EdenNode,
} from "../types";

function node(
  kind: EdenNode["data"]["kind"],
  overrides: Partial<EdenNode["data"]> = {},
  position = { x: 0, y: 0 },
): EdenNode {
  return {
    ...makeBlockNode(kind, position),
    data: { ...makeBlockNode(kind, position).data, ...overrides } as EdenNode["data"],
  };
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string,
  targetHandle?: string,
): EdenEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(targetHandle ? { targetHandle } : {}),
    data: { kind: "data" },
  };
}

describe("validate", () => {
  it("flags missing agent", () => {
    const errs = validate([node("scenario")], []);
    expect(errs.map((e) => e.code)).toContain("E_NO_AGENT");
  });

  it("flags multiple agents", () => {
    const errs = validate([node("agent"), node("agent")], []);
    expect(errs.map((e) => e.code)).toContain("E_MULTI_AGENT");
  });

  it("flags missing scenario", () => {
    const errs = validate([node("agent")], []);
    expect(errs.map((e) => e.code)).toContain("E_NO_SCENARIO");
  });

  it("flags duplicate scenario ids", () => {
    const a = node("scenario", { id: "scenario_x" });
    const b = node("scenario", { id: "scenario_x" });
    const errs = validate([node("agent"), a, b], []);
    expect(errs.map((e) => e.code)).toContain("E_DUP_SCENARIO");
  });

  it("flags bad scenario slug", () => {
    const s = node("scenario", { id: "Scenario-1!" });
    const errs = validate([node("agent"), s], []);
    expect(errs.map((e) => e.code)).toContain("E_BAD_SCENARIO_ID");
  });

  it("flags negative or non-integer seed", () => {
    const seed = node("seed", { value: -5 });
    const errs = validate([node("agent"), node("scenario"), seed], []);
    expect(errs.map((e) => e.code)).toContain("E_BAD_SEED");
  });

  it("flags multiple seeds", () => {
    const errs = validate([
      node("agent"),
      node("scenario"),
      node("seed", { value: 1 }),
      node("seed", { value: 2 }),
    ], []);
    expect(errs.map((e) => e.code)).toContain("E_MULTI_SEED");
  });

  it("passes for a minimal valid graph", () => {
    const errs = validate([node("agent"), node("scenario")], []);
    expect(errs).toEqual([]);
  });
});

describe("translate", () => {
  it("produces a valid bundle for the happy path", () => {
    const result = translate([node("agent"), node("scenario")], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.yaml).toMatch(/^target:/m);
    expect(result.bundle.yaml).toMatch(/scenarios:/);
    expect(result.bundle.yaml).toMatch(/module: agent/);
    expect(result.bundle.yaml).toMatch(/framework: langchain/);
    // makeBlockNode generates a random id per scenario, so we
    // just assert the suffix is correct.
    const paths = result.bundle.files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["agent.py", "README.md"]),
    );
    expect(paths.some((p) => /^scenarios\/scenario_[a-z0-9]+\.py$/.test(p))).toBe(true);
  });

  it("emits seed line when seed block is present", () => {
    const seed = node("seed", { value: 42 });
    const result = translate(
      [node("agent"), node("scenario"), seed],
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.yaml).toMatch(/^seed: 42$/m);
  });

  it("omits seed line when no seed block is present", () => {
    const result = translate([node("agent"), node("scenario")], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.yaml).not.toMatch(/^seed:/m);
  });

  it("clamps max_episodes to [1, 50]", () => {
    const s = node("scenario", { maxEpisodes: 9999 });
    const result = translate([node("agent"), s], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.yaml).toMatch(/max_episodes: 50/);
  });

  it("includes tools and memory sections when present", () => {
    const tool = node("tool", { name: "shell_run", toolKind: "shell" });
    const mem = node("memory", { memoryType: "long-term", capacity: 50 });
    const result = translate(
      [node("agent"), node("scenario"), tool, mem],
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.yaml).toMatch(/^tools:/m);
    expect(result.bundle.yaml).toMatch(/name: shell_run/);
    expect(result.bundle.yaml).toMatch(/^memory:/m);
    expect(result.bundle.yaml).toMatch(/capacity: 50/);
  });

  it("attaches scoring to a scenario via edges", () => {
    const agent = node("agent");
    const scenario = node("scenario", { id: "scenario_x" });
    const scoring = node("scoring", {
      criteria: [{ name: "q", kind: "quality", weight: 1 }],
    });
    const result = translate(
      [agent, scenario, scoring],
      [edge(scoring.id, scenario.id)],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.yaml).toMatch(/scoring:/);
  });

  it("returns errors when validation fails", () => {
    const result = translate([], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("renderYaml", () => {
  it("emits nested objects with 2-space indent", () => {
    const out = renderYaml({ a: { b: 1, c: 2 } });
    expect(out).toBe("a:\n  b: 1\n  c: 2");
  });

  it("quotes strings that contain special chars", () => {
    const out = renderYaml({ name: "hello world" });
    expect(out).toBe('name: "hello world"');
  });

  it("emits arrays of objects with leading dash", () => {
    const out = renderYaml({ items: [{ id: 1 }, { id: 2 }] });
    expect(out).toMatch(/^items:/m);
    expect(out).toMatch(/-\n    id: 1/);
  });

  it("sorts keys deterministically", () => {
    const out = renderYaml({ z: 1, a: 2, m: 3 });
    expect(out).toBe("a: 2\nm: 3\nz: 1");
  });
});

describe("previewYaml", () => {
  it("returns the best-effort yaml even when validation fails", () => {
    const out = previewYaml([node("agent")], []); // no scenarios
    expect(out).toMatch(/^target:/m);
    expect(out).toMatch(/scenarios: \[\]/);
  });
});

describe("DEFAULT_SEED", () => {
  it("is 42", () => {
    expect(DEFAULT_SEED).toBe(42);
  });
});
