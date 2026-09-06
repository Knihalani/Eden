import { afterEach, describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import {
  bindSpeculateRunner,
  createState,
  discardSpeculation,
  markStretchServed,
  speculateEnabled,
  takeSpeculation,
  turnBoundary,
  wrapTools,
} from "./index";

const liveManifest = {
  llmReduction: 8,
  latencyReduction: 8,
  costReduction: 8,
  skipRateBefore: 0.2,
  skipRateAfter: 0,
  nShadow: 6,
};

function readProgram(ids: string[] = ["T-100"]): StretchProgram {
  return {
    id: "gh-review",
    version: "1",
    name: "review_issue",
    description: "Read-only GitHub-like review.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["getIssue", "getComments", "getChecks"],
    steps: [
      { id: "issue", kind: "tool", tool: "getIssue", args: { id: { kind: "input", path: "id" } } },
      {
        id: "comments",
        kind: "tool",
        tool: "getComments",
        args: { id: { kind: "from", step: "issue", path: "id" } },
      },
      {
        id: "checks",
        kind: "tool",
        tool: "getChecks",
        args: { id: { kind: "from", step: "comments", path: "id" } },
      },
    ],
    returns: { kind: "from", step: "checks", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: { inputs: { id: ids } } },
    manifest: liveManifest,
  };
}

function writeProgram(): StretchProgram {
  return {
    id: "mutate",
    version: "1",
    name: "close_issue",
    description: "Mutating close.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["getIssue", "writeRecord"],
    steps: [
      { id: "issue", kind: "tool", tool: "getIssue", args: { id: { kind: "input", path: "id" } } },
      { id: "write", kind: "tool", tool: "writeRecord", args: { id: { kind: "input", path: "id" } } },
    ],
    returns: { kind: "from", step: "write", path: "" },
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: true,
      envelope: { inputs: { id: ["T-100"] } },
    },
    manifest: liveManifest,
  };
}

function tools(log: string[], titles: Record<string, string> = { "T-100": "alpha", "T-200": "beta" }) {
  const sleep = async () => {
    await Bun.sleep(8);
  };
  return {
    getIssue: {
      description: "GET issue",
      execute: async ({ id }: Record<string, unknown>) => {
        log.push(`getIssue:${id}`);
        await sleep();
        return { id, title: titles[String(id)] ?? "missing" };
      },
    },
    getComments: {
      description: "GET comments",
      execute: async ({ id }: Record<string, unknown>) => {
        log.push(`getComments:${id}`);
        await sleep();
        return { id, comments: [`c-${id}`] };
      },
    },
    getChecks: {
      description: "GET checks",
      execute: async ({ id }: Record<string, unknown>) => {
        log.push(`getChecks:${id}`);
        await sleep();
        return { id, checks: ["ok"], title: titles[String(id)] ?? "missing" };
      },
    },
    writeRecord: {
      description: "POST write",
      execute: async ({ id }: Record<string, unknown>) => {
        log.push(`writeRecord:${id}`);
        return { written: true, id };
      },
    },
  };
}

afterEach(() => {
  delete process.env.EDEN_SPECULATE;
});

describe("turn-boundary speculation", () => {
  test("read-only stretch is started at the turn boundary before the head call", async () => {
    const log: string[] = [];
    const program = readProgram();
    const state = createState({ programs: [program] });
    const wrapped = wrapTools(tools(log), state);
    const handle = turnBoundary(state, { input: { id: "T-100" } });
    expect(handle).not.toBeNull();
    expect(handle?.programId).toBe("gh-review");
    await Bun.sleep(20);
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.startsWith("getIssue"))).toBe(true);
    const value = await wrapped.getIssue.execute({ id: "T-100" });
    expect(log.filter((e) => e.startsWith("getIssue"))).toHaveLength(1);
    expect(log.filter((e) => e.startsWith("getComments"))).toHaveLength(1);
    expect(log.filter((e) => e.startsWith("getChecks"))).toHaveLength(1);
    expect(value).toMatchObject({ id: "T-100", checks: ["ok"] });
  });

  test("mutating programs are never started", async () => {
    const log: string[] = [];
    const state = createState({ programs: [writeProgram()] });
    wrapTools(tools(log), state);
    const handle = turnBoundary(state, { input: { id: "T-100" } });
    expect(handle).toBeNull();
    await Bun.sleep(15);
    expect(log).toEqual([]);
    expect(log.includes("writeRecord:T-100")).toBe(false);
  });

  test("a miss discards — the agent never sees the unconfirmed value", async () => {
    const log: string[] = [];
    const program = readProgram(["T-100", "T-200"]);
    const state = createState({ programs: [program] });
    const wrapped = wrapTools(tools(log), state);
    expect(turnBoundary(state, { input: { id: "T-100" } })).not.toBeNull();
    await Bun.sleep(30);
    expect(log.some((e) => e.endsWith(":T-100"))).toBe(true);
    const value = await wrapped.getIssue.execute({ id: "T-200" });
    expect(value).toMatchObject({ id: "T-200", title: "beta" });
    expect(value).not.toMatchObject({ title: "alpha" });
    const leaked = await takeSpeculation(state, program, { id: "T-100" });
    expect(leaked.hit).toBe(false);
  });

  test("EDEN_SPECULATE=0 is off", async () => {
    process.env.EDEN_SPECULATE = "0";
    expect(speculateEnabled()).toBe(false);
    const log: string[] = [];
    const state = createState({ programs: [readProgram()] });
    wrapTools(tools(log), state);
    expect(turnBoundary(state, { input: { id: "T-100" } })).toBeNull();
    await Bun.sleep(15);
    expect(log).toEqual([]);
  });

  test("fail-open: a throwing runner does not break the agent's call", async () => {
    const log: string[] = [];
    const program = readProgram();
    const state = createState({ programs: [program] });
    const wrapped = wrapTools(tools(log), state);
    bindSpeculateRunner(state, {
      live: () => [program],
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(() => turnBoundary(state, { input: { id: "T-100" } })).not.toThrow();
    const handle = turnBoundary(state, { input: { id: "T-100" } });
    expect(handle).not.toBeNull();
    const value = await wrapped.getIssue.execute({ id: "T-100" });
    expect(value).toMatchObject({ id: "T-100", checks: ["ok"] });
  });

  test("fail-open: turnBoundary without a runner is a no-op, never throws", () => {
    const state = createState({ programs: [readProgram()] });
    expect(() => turnBoundary(state, { input: { id: "T-100" } })).not.toThrow();
    expect(turnBoundary(state, { input: { id: "T-100" } })).toBeNull();
  });

  test("discardSpeculation isolates an in-flight guess", async () => {
    const log: string[] = [];
    const program = readProgram();
    const state = createState({ programs: [program] });
    wrapTools(tools(log), state);
    turnBoundary(state, { input: { id: "T-100" } });
    discardSpeculation(state);
    const taken = await takeSpeculation(state, program, { id: "T-100" });
    expect(taken.hit).toBe(false);
  });

  test("wrap-style lastTool in-sequence does not restart the stretch; explicit program does", async () => {
    const log: string[] = [];
    const program = readProgram();
    const state = createState({ programs: [program] });
    wrapTools(tools(log), state);
    expect(
      turnBoundary(state, { lastTool: "getIssue", lastArgs: { id: "T-100" }, input: { id: "T-100" } }),
    ).toBeNull();
    const handle = turnBoundary(state, { program: "gh-review", input: { id: "T-100" } });
    expect(handle).not.toBeNull();
    markStretchServed(state, program, { id: "T-100" });
    discardSpeculation(state);
    expect(turnBoundary(state, { program: "gh-review", input: { id: "T-100" } })).toBeNull();
  });
});
