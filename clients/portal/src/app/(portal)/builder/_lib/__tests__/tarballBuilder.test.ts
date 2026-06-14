// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";

import { buildTarball, buildTarballFile, slugify } from "../tarballBuilder";
import type { SpecBundle } from "../types";

function makeBundle(): SpecBundle {
  return {
    yaml: "target:\n  module: agent\nscenarios:\n  - id: scenario_1\n    env_class_name: SimEnv\n    max_episodes: 5\n",
    files: [
      {
        path: "scenarios/scenario_1.py",
        body: "class SimEnv:\n    pass\n",
      },
      {
        path: "agent.py",
        body: "def run(obs):\n    return {}\n",
      },
      {
        path: "README.md",
        body: "# Eden builder output\n",
      },
    ],
  };
}

describe("buildTarball", () => {
  it("returns a Uint8Array with non-zero size", () => {
    const bytes = buildTarball(makeBundle());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("starts with the PK magic (ZIP)", () => {
    const bytes = buildTarball(makeBundle());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("unzips to contain all expected files", () => {
    const bytes = buildTarball(makeBundle());
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(
      expect.arrayContaining([
        "eden-sim-eval.yaml",
        "agent.py",
        "scenarios/scenario_1.py",
        "README.md",
      ]),
    );
  });

  it("preserves the YAML body verbatim", () => {
    const bytes = buildTarball(makeBundle());
    const files = unzipSync(bytes);
    const yaml = strFromU8(files["eden-sim-eval.yaml"]!);
    expect(yaml).toMatch(/target:/);
    expect(yaml).toMatch(/max_episodes: 5/);
  });

  it("rejects paths that try to escape the root", () => {
    const bad: SpecBundle = {
      yaml: "x: 1\n",
      files: [{ path: "../escape.txt", body: "no" }],
    };
    expect(() => buildTarball(bad)).toThrow(/unsafe path/);
  });
});

describe("buildTarballFile", () => {
  it("returns a File with the slugified name and application/zip type", () => {
    const file = buildTarballFile("My Test Agent!!", makeBundle());
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("my-test-agent.zip");
    expect(file.type).toBe("application/zip");
    expect(file.size).toBeGreaterThan(0);
  });
});

describe("slugify", () => {
  it("lowercases and replaces non-alnum with dashes", () => {
    expect(slugify("My Test Agent!!")).toBe("my-test-agent");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("truncates to 64 chars", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(64);
  });

  it("returns 'agent' for empty input", () => {
    expect(slugify("")).toBe("agent");
    expect(slugify("   ")).toBe("agent");
  });
});
