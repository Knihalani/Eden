import { describe, expect, test } from "bun:test";
import { withVersion, type Step, type StretchProgram } from "@eden/ir";
import { runProgram } from "./execute";

type Call = { tool: string; args: Record<string, unknown> };

/** Records call order and concurrency so tests can assert on both. */
function registry(opts: { delayMs?: number; results?: Record<string, (args: Record<string, unknown>) => unknown> } = {}) {
  const calls: Call[] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    calls,
    get peakConcurrency() {
      return peak;
    },
    registry: {
      async execute(tool: string, args: Record<string, unknown>) {
        calls.push({ tool, args });
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          if (opts.delayMs) await Bun.sleep(opts.delayMs);
          const make = opts.results?.[tool];
          if (make) return make(args);
          return { of: args.id ?? null };
        } finally {
          inFlight--;
        }
      },
    },
  };
}

function loopProgram(bodyTool: string, items: number, extra: Partial<Step> = {}): StretchProgram {
  const list = Array.from({ length: items }, (_, i) => ({ id: `I-${i}` }));
  return withVersion({
    id: "p_loop",
    name: "loop_bench",
    description: "d",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    sequence: ["listItems", bodyTool],
    steps: [
      { id: "listItems", kind: "tool", tool: "listItems", args: { q: { kind: "input", path: "q" } } },
      {
        id: "loop1",
        kind: "loop",
        over: { kind: "from", step: "listItems", path: "items" },
        item: "item_loop1",
        body: ["bodyStep"],
        ...extra,
      },
      { id: "bodyStep", kind: "tool", tool: bodyTool, args: { id: { kind: "from", step: "item_loop1", path: "id" } } },
    ],
    returns: { kind: "from", step: "loop1", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: null },
    manifest: null,
    __items: list,
  } as unknown as Omit<StretchProgram, "version">) as StretchProgram;
}

const listOf = (n: number) => ({
  listItems: () => ({ items: Array.from({ length: n }, (_, i) => ({ id: `I-${i}` })) }),
});

describe("parallel loops", () => {
  test("a read-only body runs concurrently", async () => {
    const N = 12;
    const parallel = registry({ delayMs: 25, results: listOf(N) });
    const pt0 = performance.now();
    const out = await runProgram(loopProgram("fetchDetails", N), { q: "x" }, {
      registry: parallel.registry,
      checkEnvelope: false,
    });
    const parallelMs = performance.now() - pt0;
    expect((out.value as unknown[]).length).toBe(N);
    expect(parallel.peakConcurrency).toBeGreaterThan(1);

    // Timed against a sequential run of the same work rather than an absolute
    // threshold. A fixed millisecond bound measures the machine as much as the
    // scheduler: this failed at 515ms on a box under load 56 while
    // peakConcurrency proved the concurrency was working perfectly. A ratio
    // cancels the load out, because both halves pay it.
    const sequential = registry({ delayMs: 25, results: listOf(N) });
    const st0 = performance.now();
    await runProgram(loopProgram("postComment", N), { q: "x" }, {
      registry: sequential.registry,
      checkEnvelope: false,
    });
    const sequentialMs = performance.now() - st0;
    expect(sequential.peakConcurrency).toBe(1);
    // Width 8 over 12 items is two waves against twelve, so ~3x. Assert half
    // of that, which is still impossible without real concurrency.
    expect(parallelMs).toBeLessThan(sequentialMs / 1.5);
  });

  test("a mutating body stays sequential", async () => {
    // `postComment` is not in the read vocabulary, so the runtime must not
    // reorder it — repeating a write out of order is not the same operation.
    const N = 6;
    const r = registry({ delayMs: 5, results: listOf(N) });
    await runProgram(loopProgram("postComment", N), { q: "x" }, { registry: r.registry, checkEnvelope: false });
    expect(r.peakConcurrency).toBe(1);
  });

  test("an unrecognised tool name stays sequential", async () => {
    // Safety is an allowlist: `gh_api` might do anything, so it gets the slow
    // path rather than the benefit of the doubt.
    const N = 6;
    const r = registry({ delayMs: 5, results: { ...listOf(N), gh_api: () => ({ ok: true }) } });
    await runProgram(loopProgram("gh_api", N), { q: "x" }, { registry: r.registry, checkEnvelope: false });
    expect(r.peakConcurrency).toBe(1);
  });

  test("an explicit readOnly flag opts an unrecognised tool in", async () => {
    const N = 8;
    const r = registry({ delayMs: 10, results: { ...listOf(N), gh_api: (a) => ({ of: a.id }) } });
    const program = loopProgram("gh_api", N);
    const body = program.steps.find((s) => s.id === "bodyStep") as { readOnly?: boolean };
    body.readOnly = true;
    await runProgram(program, { q: "x" }, { registry: r.registry, checkEnvelope: false });
    expect(r.peakConcurrency).toBeGreaterThan(1);
  });

  test("parallel: false forces sequential even for a read-only body", async () => {
    const N = 6;
    const r = registry({ delayMs: 5, results: listOf(N) });
    await runProgram(loopProgram("fetchDetails", N, { parallel: false } as Partial<Step>), { q: "x" }, {
      registry: r.registry,
      checkEnvelope: false,
    });
    expect(r.peakConcurrency).toBe(1);
  });

  test("loopConcurrency: 1 restores the old behaviour exactly", async () => {
    const N = 6;
    const r = registry({ delayMs: 2, results: listOf(N) });
    await runProgram(loopProgram("fetchDetails", N), { q: "x" }, {
      registry: r.registry,
      checkEnvelope: false,
      loopConcurrency: 1,
    });
    expect(r.peakConcurrency).toBe(1);
  });

  test("concurrency is bounded by the configured width", async () => {
    const N = 40;
    const r = registry({ delayMs: 15, results: listOf(N) });
    await runProgram(loopProgram("fetchDetails", N), { q: "x" }, {
      registry: r.registry,
      checkEnvelope: false,
      loopConcurrency: 4,
    });
    expect(r.peakConcurrency).toBeLessThanOrEqual(4);
    expect(r.peakConcurrency).toBeGreaterThan(1);
  });

  test("results keep item order even when completion order is scrambled", async () => {
    // Later items finish first. Collecting by completion would silently
    // reorder the receipt.
    const N = 8;
    const r = registry({
      results: {
        ...listOf(N),
        fetchDetails: (args) => ({ of: args.id }),
      },
    });
    const slow = {
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "fetchDetails") {
          const idx = Number(String(args.id).split("-")[1]);
          await Bun.sleep((N - idx) * 4); // item 0 is slowest
          return { of: args.id };
        }
        return r.registry.execute(tool, args);
      },
    };
    const out = await runProgram(loopProgram("fetchDetails", N), { q: "x" }, {
      registry: slow,
      checkEnvelope: false,
    });
    expect(out.value).toEqual(Array.from({ length: N }, (_, i) => ({ of: `I-${i}` })));
  });

  test("toolCalls is recorded in item order, not completion order", async () => {
    const N = 5;
    const slow = {
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "listItems") return { items: Array.from({ length: N }, (_, i) => ({ id: `I-${i}` })) };
        await Bun.sleep((N - Number(String(args.id).split("-")[1])) * 4);
        return { of: args.id };
      },
    };
    const out = await runProgram(loopProgram("fetchDetails", N), { q: "x" }, {
      registry: slow,
      checkEnvelope: false,
    });
    expect(out.stats.toolCalls).toEqual(["listItems", ...Array.from({ length: N }, () => "fetchDetails")]);
  });

  test("iterations cannot observe each other's loop variable", async () => {
    // The sharp edge of running iterations concurrently. Every iteration binds
    // the same `item_loop1` id, and a body step that reads it *after* an await
    // — i.e. any second step — resolves it against whatever the map holds by
    // then. On one shared map that is the most recently started iteration's
    // item, not its own. Staggering the first step so later items finish first
    // makes the collision deterministic rather than a coin flip.
    const N = 8;
    const seenBySecond: unknown[] = [];
    const reg = {
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "listItems") return { items: Array.from({ length: N }, (_, i) => ({ id: `I-${i}` })) };
        if (tool === "fetchDetails") {
          await Bun.sleep((N - Number(String(args.id).split("-")[1])) * 5);
          return { of: args.id };
        }
        seenBySecond.push(args.id);
        return { ok: true };
      },
    };
    const program = loopProgram("fetchDetails", N);
    program.steps.push({
      id: "second",
      kind: "tool",
      tool: "getSecond",
      // Reads the loop variable again, after the first step has awaited.
      args: { id: { kind: "from", step: "item_loop1", path: "id" } },
    });
    (program.steps.find((s) => s.id === "loop1") as { body: string[] }).body = ["bodyStep", "second"];
    await runProgram(program, { q: "x" }, { registry: reg, checkEnvelope: false });
    // Every item must be visited exactly once by the second step.
    expect([...seenBySecond].sort()).toEqual(Array.from({ length: N }, (_, i) => `I-${i}`).sort());
  });

  test("parallel and sequential runs agree exactly", async () => {
    const N = 10;
    const make = () => ({
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "listItems") return { items: Array.from({ length: N }, (_, i) => ({ id: `I-${i}` })) };
        await Bun.sleep(Math.random() * 5);
        return { of: args.id, n: Number(String(args.id).split("-")[1]) * 2 };
      },
    });
    const seq = await runProgram(loopProgram("fetchDetails", N), { q: "x" }, {
      registry: make(),
      checkEnvelope: false,
      loopConcurrency: 1,
    });
    const par = await runProgram(loopProgram("fetchDetails", N), { q: "x" }, {
      registry: make(),
      checkEnvelope: false,
      loopConcurrency: 8,
    });
    expect(par.value).toEqual(seq.value);
    expect(par.stats.toolCalls).toEqual(seq.stats.toolCalls);
  });

  test("a failing iteration still fails the run", async () => {
    const N = 6;
    const reg = {
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "listItems") return { items: Array.from({ length: N }, (_, i) => ({ id: `I-${i}` })) };
        if (args.id === "I-3") throw new Error("upstream exploded");
        await Bun.sleep(5);
        return { of: args.id };
      },
    };
    await expect(
      runProgram(loopProgram("fetchDetails", N), { q: "x" }, { registry: reg, checkEnvelope: false }),
    ).rejects.toThrow(/upstream exploded/);
  });

  test("a single-item loop takes the sequential path", async () => {
    const r = registry({ delayMs: 1, results: listOf(1) });
    await runProgram(loopProgram("fetchDetails", 1), { q: "x" }, { registry: r.registry, checkEnvelope: false });
    expect(r.peakConcurrency).toBe(1);
  });

  test("an empty loop yields an empty array", async () => {
    const r = registry({ results: listOf(0) });
    const out = await runProgram(loopProgram("fetchDetails", 0), { q: "x" }, {
      registry: r.registry,
      checkEnvelope: false,
    });
    expect(out.value).toEqual([]);
  });
});
