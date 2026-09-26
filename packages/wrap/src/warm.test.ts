import { afterEach, describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import { registryFrom } from "@eden/runtime";
import {
  bindWarmRunner,
  createState,
  discardWarm,
  firstWaveReads,
  runCompiled,
  takeWarm,
  watchWarm,
  watchWarmEnabled,
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

function currentProgram(ids: string[] = ["T-100"]): StretchProgram {
  return {
    id: "fetch-issue",
    version: "1",
    name: "fetch_issue",
    description: "Read-only issue + comments.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["getIssue", "getComments"],
    steps: [
      { id: "issue", kind: "tool", tool: "getIssue", args: { id: { kind: "input", path: "id" } }, readOnly: true },
      {
        id: "comments",
        kind: "tool",
        tool: "getComments",
        args: { id: { kind: "from", step: "issue", path: "id" } },
        readOnly: true,
      },
    ],
    returns: { kind: "from", step: "comments", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: { inputs: { id: ids } } },
    manifest: liveManifest,
  };
}

function nextProgram(ids: string[] = ["T-100"]): StretchProgram {
  return {
    id: "fetch-meta",
    version: "1",
    name: "fetch_meta",
    description: "Read-only labels + assignees + timeline.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["getLabels", "getAssignees", "getTimeline"],
    steps: [
      { id: "labels", kind: "tool", tool: "getLabels", args: { id: { kind: "input", path: "id" } }, readOnly: true },
      {
        id: "assignees",
        kind: "tool",
        tool: "getAssignees",
        args: { id: { kind: "input", path: "id" } },
        readOnly: true,
      },
      {
        id: "timeline",
        kind: "tool",
        tool: "getTimeline",
        args: { id: { kind: "from", step: "labels", path: "id" } },
        readOnly: true,
      },
    ],
    returns: { kind: "from", step: "timeline", path: "" },
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
  const sleep = async (ms: number) => {
    await Bun.sleep(ms);
  };
  return {
    getIssue: {
      description: "GET issue",
      execute: async ({ id }: Record<string, unknown>) => {
        log.push(`getIssue:${id}`);
        await sleep(24);
        return { id, title: titles[String(id)] ?? "missing" };
      },
    },
    getComments: {
      description: "GET comments",
      execute: async ({ id }: Record<string, unknown>) => {
        log.push(`getComments:${id}`);
        await sleep(24);
        return { id, comments: [`c-${id}`] };
      },
    },
    getLabels: {
      description: "GET labels",
      execute: async ({ id }: Record<string, unknown>) => {
        log.push(`getLabels:${id}`);
        await sleep(8);
        return { id, labels: ["bug"] };
      },
    },
    getAssignees: {
      description: "GET assignees",
      execute: async ({ id }: Record<string, unknown>) => {
        log.push(`getAssignees:${id}`);
        await sleep(8);
        return { id, assignees: ["kai"] };
      },
    },
    getTimeline: {
      description: "GET timeline",
      execute: async ({ id }: Record<string, unknown>) => {
        log.push(`getTimeline:${id}`);
        return { id, events: ["opened"] };
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

function bind(state: ReturnType<typeof createState>, log: string[]) {
  const defs = tools(log);
  const registry = registryFrom(
    Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v.execute])),
  );
  bindWarmRunner(state, {
    live: () => state.programs,
    execute: (tool, args) => registry.execute(tool, args),
  });
  return defs;
}

afterEach(() => {
  delete process.env.EDEN_WATCH_WARM;
  delete process.env.EDEN_SPECULATE;
});

describe("watch-time warming", () => {
  test("first-wave is input-bound reads only — later from-deps are excluded", () => {
    const next = nextProgram();
    const wave = firstWaveReads(next, { id: "T-100" });
    expect(wave.map((w) => w.tool).sort()).toEqual(["getAssignees", "getLabels"]);
    expect(wave.every((w) => w.args.id === "T-100")).toBe(true);
    const current = currentProgram();
    expect(firstWaveReads(current, { id: "T-100" }).map((w) => w.tool)).toEqual(["getIssue"]);
  });

  test("n-way branch cases ids are owned — first-wave does not warm arm tools", () => {
    const prog: StretchProgram = {
      id: "nary-warm",
      version: "1",
      name: "nary_warm",
      description: "Prefix read plus n-way branch of input-bound reads.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sequence: ["getStatus", "branch_sev"],
      steps: [
        { id: "check", kind: "tool", tool: "getStatus", args: { id: { kind: "input", path: "id" } }, readOnly: true },
        { id: "arm_a", kind: "tool", tool: "getPage", args: { id: { kind: "input", path: "id" } }, readOnly: true },
        { id: "arm_b", kind: "tool", tool: "getTicket", args: { id: { kind: "input", path: "id" } }, readOnly: true },
        { id: "arm_c", kind: "tool", tool: "getLog", args: { id: { kind: "input", path: "id" } }, readOnly: true },
        {
          id: "br",
          kind: "branch",
          expr: 'sev == "p0"',
          then: ["arm_a"],
          cases: [{ expr: 'sev == "p1"', steps: ["arm_b"] }],
          else: ["arm_c"],
        },
      ],
      returns: { kind: "from", step: "br", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: { inputs: { id: ["T-100"] } } },
      manifest: liveManifest,
    };
    const wave = firstWaveReads(prog, { id: "T-100" });
    expect(wave.map((w) => w.tool)).toEqual(["getStatus"]);
    expect(wave.some((w) => w.tool === "getTicket" || w.tool === "getPage" || w.tool === "getLog")).toBe(false);
  });

  test("next program's first-wave reads start while the current stretch is still running", async () => {
    const log: string[] = [];
    const current = currentProgram();
    const next = nextProgram();
    const state = createState({ programs: [current, next] });
    const defs = bind(state, log);
    const handle = watchWarm(state, current, { input: { id: "T-100" } });
    expect(handle).not.toBeNull();
    expect(handle?.programId).toBe("fetch-meta");
    expect(handle?.tools.sort()).toEqual(["getAssignees", "getLabels"]);
    const running = runCompiled(state, current, { id: "T-100" }, defs);
    await Bun.sleep(12);
    expect(log.some((e) => e.startsWith("getLabels") || e.startsWith("getAssignees"))).toBe(true);
    expect(log.filter((e) => e.startsWith("getComments")).length).toBe(0);
    await running;
    expect(log.filter((e) => e.startsWith("getTimeline"))).toHaveLength(0);
  });

  test("when the next stretch runs, first-wave reads are cache hits (not re-executed)", async () => {
    const log: string[] = [];
    const current = currentProgram();
    const next = nextProgram();
    const state = createState({ programs: [current, next] });
    const defs = bind(state, log);
    await runCompiled(state, current, { id: "T-100" }, defs);
    await Bun.sleep(20);
    const before = log.filter((e) => e.startsWith("getLabels") || e.startsWith("getAssignees")).length;
    expect(before).toBe(2);
    await runCompiled(state, next, { id: "T-100" }, defs);
    expect(log.filter((e) => e.startsWith("getLabels"))).toHaveLength(1);
    expect(log.filter((e) => e.startsWith("getAssignees"))).toHaveLength(1);
    expect(log.filter((e) => e.startsWith("getTimeline"))).toHaveLength(1);
  });

  test("mutating programs are never pre-executed", async () => {
    const log: string[] = [];
    const current = currentProgram();
    const write = writeProgram();
    const state = createState({ programs: [current, write] });
    const defs = bind(state, log);
    const handle = watchWarm(state, current, { input: { id: "T-100" }, program: "mutate" });
    expect(handle).toBeNull();
    await runCompiled(state, current, { id: "T-100" }, defs);
    await Bun.sleep(15);
    expect(log.filter((e) => e.startsWith("writeRecord"))).toHaveLength(0);
  });

  test("a wrong guess discards — the agent never sees the unconfirmed value", async () => {
    const log: string[] = [];
    const current = currentProgram(["T-100", "T-200"]);
    const next = nextProgram(["T-100", "T-200"]);
    const state = createState({ programs: [current, next] });
    const defs = bind(state, log);
    expect(watchWarm(state, current, { input: { id: "T-100" }, program: "fetch-meta" })).not.toBeNull();
    await Bun.sleep(20);
    expect(log.some((e) => e.endsWith(":T-100"))).toBe(true);
    const value = await runCompiled(state, next, { id: "T-200" }, defs);
    expect(value).toMatchObject({ id: "T-200" });
    expect(value).not.toMatchObject({ labels: expect.anything() });
    const leaked = await takeWarm(state, next, "getLabels", { id: "T-100" });
    expect(leaked.hit).toBe(false);
  });

  test("EDEN_WATCH_WARM=0 is off", async () => {
    process.env.EDEN_WATCH_WARM = "0";
    expect(watchWarmEnabled()).toBe(false);
    const log: string[] = [];
    const current = currentProgram();
    const next = nextProgram();
    const state = createState({ programs: [current, next] });
    bind(state, log);
    expect(watchWarm(state, current, { input: { id: "T-100" } })).toBeNull();
    await Bun.sleep(15);
    expect(log.filter((e) => e.startsWith("getLabels") || e.startsWith("getAssignees"))).toEqual([]);
  });

  test("fail-open: a throwing warm execute does not break the current stretch", async () => {
    const log: string[] = [];
    const current = currentProgram();
    const next = nextProgram();
    const state = createState({ programs: [current, next] });
    const defs = tools(log);
    bindWarmRunner(state, {
      live: () => [current, next],
      execute: async () => {
        throw new Error("boom");
      },
    });
    expect(() => watchWarm(state, current, { input: { id: "T-100" } })).not.toThrow();
    const value = await runCompiled(state, current, { id: "T-100" }, defs);
    expect(value).toMatchObject({ id: "T-100", comments: ["c-T-100"] });
  });

  test("fail-open: watchWarm without a runner is a no-op, never throws", () => {
    const state = createState({ programs: [currentProgram(), nextProgram()] });
    expect(() => watchWarm(state, currentProgram(), { input: { id: "T-100" } })).not.toThrow();
    expect(watchWarm(state, currentProgram(), { input: { id: "T-100" } })).toBeNull();
  });

  test("discardWarm isolates an in-flight guess", async () => {
    const log: string[] = [];
    const current = currentProgram();
    const next = nextProgram();
    const state = createState({ programs: [current, next] });
    bind(state, log);
    watchWarm(state, current, { input: { id: "T-100" } });
    discardWarm(state);
    const taken = await takeWarm(state, next, "getLabels", { id: "T-100" });
    expect(taken.hit).toBe(false);
  });

  test("wrapTools runCompiled start warms the next program; speculate stays off this path", async () => {
    process.env.EDEN_SPECULATE = "0";
    const log: string[] = [];
    const current = currentProgram();
    const next = nextProgram();
    const state = createState({ programs: [current, next] });
    const wrapped = wrapTools(tools(log), state);
    await wrapped.fetch_issue.execute({ id: "T-100" });
    await Bun.sleep(20);
    expect(log.filter((e) => e.startsWith("getLabels"))).toHaveLength(1);
    expect(log.filter((e) => e.startsWith("getAssignees"))).toHaveLength(1);
    expect(log.filter((e) => e.startsWith("getTimeline"))).toHaveLength(0);
    await wrapped.fetch_meta.execute({ id: "T-100" });
    expect(log.filter((e) => e.startsWith("getLabels"))).toHaveLength(1);
    expect(log.filter((e) => e.startsWith("getTimeline"))).toHaveLength(1);
  });

  test("next likely follows witnessed successors, not the longest other program", () => {
    const log: string[] = [];
    const current = currentProgram();
    const short: StretchProgram = {
      ...nextProgram(),
      id: "fetch-short",
      name: "fetch_short",
      sequence: ["getLabels"],
      steps: [{ id: "labels", kind: "tool", tool: "getLabels", args: { id: { kind: "input", path: "id" } }, readOnly: true }],
      returns: { kind: "from", step: "labels", path: "" },
    };
    const long = nextProgram();
    const state = createState({ programs: [current, short, long] });
    bind(state, log);
    const first = watchWarm(state, current, { input: { id: "T-100" } });
    expect(first?.programId).toBe("fetch-meta");
    watchWarm(state, short, { input: { id: "T-100" } });
    discardWarm(state);
    const again = watchWarm(state, current, { input: { id: "T-100" } });
    expect(again?.programId).toBe("fetch-short");
  });
});
