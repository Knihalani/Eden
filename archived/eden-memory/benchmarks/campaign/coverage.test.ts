/**
 * Coverage for Wave 1.3 worlds, including the 100-stretch smoke (CI, not
 * gated behind bench --long) and the bindable-pagination compile pin.
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "@eden/compile";
import { mulberry32 } from "@eden/measure";
import { createNoise } from "./negative-worlds";
import {
  HIGH_CARD_SEQUENCE,
  LONG_SESSION_IDS,
  PAGE_ITEMS,
  PARTIAL_HITS,
  PARTIAL_READS,
  armSlowToolLive,
  collectSequence,
  createHighCard,
  createLongSession,
  createPagination,
  createPaginationBindable,
  createPartialIteration,
  createSlowTool,
} from "./coverage-worlds";
import { blockSeed, type CallResult, type World } from "./worlds";

// 1 ms of simulated think time per agent call. Setting CAMPAIGN_THINK_MS here would be too
// late: session.ts reads it when it is imported, which happens before this line runs.
const THINK = { thinkMs: 1 };
process.env.CAMPAIGN_WRAP_TIMEOUT_MS = "120";

const TIMEOUT = 30_000;

async function driveOnce(world: World, goal: Record<string, unknown>, seed = 1): Promise<void> {
  const tools = world.tools();
  const gen = world.script(goal, mulberry32(seed >>> 0));
  let sent: CallResult | undefined;
  for (;;) {
    const next = await gen.next(sent as never);
    if (next.done) break;
    const { tool, args } = next.value;
    try {
      const v = await tools[tool]!.execute(args);
      sent = { ok: true, value: v };
    } catch (err) {
      sent = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

describe("coverage worlds: scripts complete", () => {
  test(
    "slow-tool: one stretch completes and check is clean",
    async () => {
      armSlowToolLive(true);
      try {
        const w = createSlowTool();
        await driveOnce(w, { id: "S-1" });
        expect(w.check([{ id: "S-1" }])).toEqual([]);
      } finally {
        armSlowToolLive(false);
      }
    },
    TIMEOUT,
  );

  test(
    "long-session: two scripts over cycling pool stay clean",
    async () => {
      const w = createLongSession();
      await driveOnce(w, { id: "LS-1" }, 1);
      await driveOnce(w, { id: "LS-2" }, 2);
      expect(w.check([{ id: "LS-1" }, { id: "LS-2" }])).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "high-card: unique ids share identical sequence (unlike noise)",
    async () => {
      const a = await collectSequence(createHighCard(), { id: "H-0-1" }, 1);
      const b = await collectSequence(createHighCard(), { id: "H-0-2" }, 2);
      expect(a).toEqual([...HIGH_CARD_SEQUENCE]);
      expect(b).toEqual([...HIGH_CARD_SEQUENCE]);
      expect(a).toEqual(b);

      const n1 = await collectSequence(createNoise(), { id: "N-1" }, 1);
      const n2 = await collectSequence(createNoise(), { id: "N-2" }, 2);
      expect(n1).not.toEqual(n2);
    },
    TIMEOUT,
  );

  test(
    "pagination: walks 3 pages then writes each item once",
    async () => {
      const w = createPagination();
      const seq = await collectSequence(w, { batch: "B1" }, 1);
      const listCalls = seq.filter((t) => t === "listPage");
      const writes = seq.filter((t) => t === "writeItem");
      expect(listCalls.length).toBe(3);
      expect(writes.length).toBe(PAGE_ITEMS.length);
      expect(seq.at(-1)).toBe("sealBatch");
      expect(w.check([{ batch: "B1" }])).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("coverage worlds: check() catches duplicated mutations", () => {
  test(
    "slow-tool: double applyCredit fires check",
    async () => {
      const w = createSlowTool();
      const tools = w.tools();
      await tools.applyCredit!.execute({ id: "S-dup" });
      await tools.applyCredit!.execute({ id: "S-dup" });
      const bad = w.check([{ id: "S-dup" }]);
      expect(bad.some((v) => v.includes("applyCredit") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "high-card: double commitWrite fires check",
    async () => {
      const w = createHighCard();
      const tools = w.tools();
      await tools.commitWrite!.execute({ id: "H-dup" });
      await tools.commitWrite!.execute({ id: "H-dup" });
      const bad = w.check([{ id: "H-dup" }]);
      expect(bad.some((v) => v.includes("commitWrite") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "long-session: double finalize fires check",
    async () => {
      const w = createLongSession();
      const tools = w.tools();
      await tools.finalize!.execute({ id: "LS-dup" });
      await tools.finalize!.execute({ id: "LS-dup" });
      const bad = w.check([{ id: "LS-dup" }]);
      expect(bad.some((v) => v.includes("finalize") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "pagination: double writeItem fires check",
    async () => {
      const w = createPagination();
      const tools = w.tools();
      await tools.writeItem!.execute({ id: "P-a" });
      await tools.writeItem!.execute({ id: "P-a" });
      const bad = w.check([{ batch: "B-dup" }]);
      expect(bad.some((v) => v.includes("P-a") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "pagination: seal without writing catalog fires missing (read-set hole)",
    async () => {
      // World contract: check() must catch missing mutations, not only dups.
      // A program that returns sealBatch after listing pages but skipping
      // writeItem would otherwise look clean and could be claimed as WIN.
      const w = createPagination();
      const bad = w.check([{ batch: "B-empty" }]);
      expect(bad.some((v) => v.includes("P-a") && v.includes("missing"))).toBe(true);
      expect(bad.filter((v) => v.includes("missing")).length).toBe(PAGE_ITEMS.length);
    },
    TIMEOUT,
  );
});

describe("coverage worlds: 100-stretch + bindable pagination", () => {
  test("very-long-session: 100 stretches over cycling pool stay clean", async () => {
    const w = createLongSession();
    const goals: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 100; i++) {
      const id = LONG_SESSION_IDS[i % LONG_SESSION_IDS.length]!;
      await driveOnce(w, { id }, i + 1);
      goals.push({ id });
    }
    expect(w.check(goals)).toEqual([]);
  }, 120_000);

  test("very-long-session wrap path: 100 live stretches after goLive stay clean", async () => {
    const { Session } = await import("./session");
    const pool = [...LONG_SESSION_IDS].map((id) => ({ id }));
    const s = new Session([["long-session", createLongSession]], true, THINK);
    for (let i = 0; i < 13; i++) {
      await s.stretch("long-session", pool[i % pool.length]!, blockSeed(`vl-w-${i}`, i));
    }
    const r = await s.goLive("long-session", {
      compile: 10,
      holdout: 3,
      sandbox: createLongSession,
      maxGram: 16,
    });
    expect(r.program).not.toBeNull();
    for (let i = 0; i < 100; i++) {
      await s.stretch("long-session", pool[i % pool.length]!, blockSeed(`vl-l-${i}`, 200 + i));
    }
    const st = s.finish();
    expect(st.violations).toEqual([]);
    expect(st.completed).toBe(113);
  }, 180_000);

  test(
    "pagination-bindable: one listAll then write each item; check clean",
    async () => {
      const w = createPaginationBindable();
      const seq = await collectSequence(w, { batch: "B1" }, 1);
      expect(seq.filter((t) => t === "listAll").length).toBe(1);
      expect(seq.filter((t) => t === "writeItem").length).toBe(PAGE_ITEMS.length);
      expect(seq.at(-1)).toBe("sealBatch");
      expect(w.check([{ batch: "B1" }])).toEqual([]);
    },
    TIMEOUT,
  );

  test("pagination-bindable traces mine a foreach; cursor pagination mines until+flatten", () => {
    const bindable = Array.from({ length: 3 }, (_, i) => ({
      id: `pb${i}`,
      llmCalls: 8,
      duration_ms: 100,
      cost_cents: 5,
      input: { batch: `B${i}` },
      complete: true as const,
      events: [
        { name: "listAll", args: { batch: `B${i}` }, result: { items: [...PAGE_ITEMS] }, ok: true },
        ...PAGE_ITEMS.flatMap((id) => [
          { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
          { name: "writeItem", args: { id }, result: { written: true, id }, ok: true },
        ]),
        { name: "sealBatch", args: { batch: `B${i}` }, result: { sealed: true }, ok: true },
      ],
    }));
    const bound = compileTraces(bindable);
    expect(bound.refusals.filter((r) => r.reason.includes("without a bindable foreach"))).toEqual([]);
    expect(bound.programs[0]?.steps.some((s) => s.kind === "loop")).toBe(true);

    const cursor = Array.from({ length: 3 }, (_, i) => ({
      id: `pc${i}`,
      llmCalls: 16,
      duration_ms: 100,
      cost_cents: 5,
      input: { batch: `C${i}` },
      complete: true as const,
      events: [
        {
          name: "listPage",
          args: { cursor: null, batch: `C${i}` },
          result: { items: ["P-a", "P-b"], nextCursor: "1" },
          ok: true,
        },
        {
          name: "listPage",
          args: { cursor: "1", batch: `C${i}` },
          result: { items: ["P-c", "P-d"], nextCursor: "2" },
          ok: true,
        },
        {
          name: "listPage",
          args: { cursor: "2", batch: `C${i}` },
          result: { items: ["P-e", "P-f"], nextCursor: null },
          ok: true,
        },
        ...PAGE_ITEMS.flatMap((id) => [
          { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
          { name: "writeItem", args: { id }, result: { written: true, id }, ok: true },
        ]),
        { name: "sealBatch", args: { batch: `C${i}` }, result: { sealed: true }, ok: true },
      ],
    }));
    const compiled = compileTraces(cursor);
    expect(compiled.refusals.filter((r) => r.code === "unbound_foreach" && r.reason.includes("listPage"))).toEqual([]);
    expect(compiled.programs.some((p) => p.steps.some((s) => s.kind === "loop" && s.until))).toBe(true);
    expect(
      compiled.programs.some((p) =>
        p.steps.some((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "flatten"),
      ),
    ).toBe(true);
  });

  test("partial-iteration (Wave 3 rotation): 12 hits / 6 reads is a named read-set miss", async () => {
    const w = createPartialIteration();
    const seq = await collectSequence(w, { topic: "auth-flow" }, 1);
    expect(seq.filter((t) => t === "readFile").length).toBe(PARTIAL_READS);
    expect(seq.filter((t) => t === "grepCode").length).toBe(1);
    const traces = Array.from({ length: 3 }, (_, i) => {
      const hits = Array.from({ length: PARTIAL_HITS }, (_, j) => `src/m${j}/t${i}.ts`);
      return {
        id: `pi${i}`,
        llmCalls: 8,
        duration_ms: 80,
        cost_cents: 4,
        complete: true as const,
        input: { topic: `t${i}` },
        events: [
          { name: "grepCode", args: { pattern: `t${i}` }, result: { hits }, ok: true },
          ...hits.slice(0, PARTIAL_READS).map((path) => ({
            name: "readFile",
            args: { path },
            result: { path, lines: ["ok"] },
            ok: true,
          })),
          { name: "writeNotes", args: { topic: `t${i}` }, result: { notesWritten: true }, ok: true },
        ],
      };
    });
    const r = compileTraces(traces);
    const miss = r.refusals.find((x) => x.code === "read_set_mismatch");
    expect(miss).toBeTruthy();
    expect(miss!.readSet).toBe(PARTIAL_HITS);
    expect(miss!.repeats).toBe(PARTIAL_READS);
    expect(miss!.reason).toMatch(/without a bindable foreach/);
    expect(r.programs.filter((p) => p.steps.some((s) => s.kind === "loop"))).toEqual([]);
  });
});
