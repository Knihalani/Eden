import { describe, expect, test } from "bun:test";
import { withVersion, type Step, type StretchProgram } from "@eden/ir";
import { runProgram } from "./execute";

type Call = { tool: string; args: Record<string, unknown> };

/** Records call order and concurrency so tests can assert on both. */
function registry(
  opts: { delayMs?: number; results?: Record<string, (args: Record<string, unknown>) => unknown> } = {},
) {
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
    const out = await runProgram(
      loopProgram("fetchDetails", N),
      { q: "x" },
      {
        registry: parallel.registry,
        checkEnvelope: false,
      },
    );
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
    await runProgram(
      loopProgram("postComment", N),
      { q: "x" },
      {
        registry: sequential.registry,
        checkEnvelope: false,
      },
    );
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
    await runProgram(
      loopProgram("fetchDetails", N, { parallel: false } as Partial<Step>),
      { q: "x" },
      {
        registry: r.registry,
        checkEnvelope: false,
      },
    );
    expect(r.peakConcurrency).toBe(1);
  });

  test("loopConcurrency: 1 restores the old behaviour exactly", async () => {
    const N = 6;
    const r = registry({ delayMs: 2, results: listOf(N) });
    await runProgram(
      loopProgram("fetchDetails", N),
      { q: "x" },
      {
        registry: r.registry,
        checkEnvelope: false,
        loopConcurrency: 1,
      },
    );
    expect(r.peakConcurrency).toBe(1);
  });

  test("concurrency is bounded by the configured width", async () => {
    const N = 40;
    const r = registry({ delayMs: 15, results: listOf(N) });
    await runProgram(
      loopProgram("fetchDetails", N),
      { q: "x" },
      {
        registry: r.registry,
        checkEnvelope: false,
        loopConcurrency: 4,
      },
    );
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
    const out = await runProgram(
      loopProgram("fetchDetails", N),
      { q: "x" },
      {
        registry: slow,
        checkEnvelope: false,
      },
    );
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
    const out = await runProgram(
      loopProgram("fetchDetails", N),
      { q: "x" },
      {
        registry: slow,
        checkEnvelope: false,
      },
    );
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
    // Seeded jitter — outcomes must not depend on Math.random races.
    let s = 0xc0ffee >>> 0;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    const make = () => ({
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "listItems") return { items: Array.from({ length: N }, (_, i) => ({ id: `I-${i}` })) };
        await Bun.sleep(rand() * 5);
        return { of: args.id, n: Number(String(args.id).split("-")[1]) * 2 };
      },
    });
    const seq = await runProgram(
      loopProgram("fetchDetails", N),
      { q: "x" },
      {
        registry: make(),
        checkEnvelope: false,
        loopConcurrency: 1,
      },
    );
    const par = await runProgram(
      loopProgram("fetchDetails", N),
      { q: "x" },
      {
        registry: make(),
        checkEnvelope: false,
        loopConcurrency: 8,
      },
    );
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
    const out = await runProgram(
      loopProgram("fetchDetails", 0),
      { q: "x" },
      {
        registry: r.registry,
        checkEnvelope: false,
      },
    );
    expect(out.value).toEqual([]);
  });
});

describe("a parallel loop body sees its own results, not a sibling's", () => {
  /**
   * `lastResult` — what a bare-path assert reads as "the step before this one"
   * — was a single closure variable shared by every concurrent iteration. N
   * iterations interleave, so it held whichever one returned most recently,
   * and an assert inside a concurrent body evaluated against another
   * iteration's data. `stepIsParallelSafe` explicitly permits asserts in a
   * parallel body, and the wave scheduler already guards against exactly this
   * for its own steps; loop iterations were missed.
   */
  function assertingLoop(items: number): StretchProgram {
    return withVersion({
      id: "p_assert_loop",
      name: "assert_loop",
      description: "d",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      sequence: ["listItems", "fetchDetails"],
      steps: [
        { id: "listItems", kind: "tool", tool: "listItems", args: { q: { kind: "input", path: "q" } } },
        {
          id: "loop1",
          kind: "loop",
          over: { kind: "from", step: "listItems", path: "items" },
          item: "item_loop1",
          body: ["bodyStep", "bodyAssert"],
        },
        {
          id: "bodyStep",
          kind: "tool",
          tool: "fetchDetails",
          args: { id: { kind: "from", step: "item_loop1", path: "id" } },
        },
        // Reads the previous step's result by bare path.
        { id: "bodyAssert", kind: "assert", expr: "mine == true", onFail: "deopt" },
      ],
      returns: { kind: "from", step: "loop1", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: null },
      manifest: null,
    } as unknown as Omit<StretchProgram, "version">) as StretchProgram;
  }

  test("an assert in a concurrent body reads the result of its own iteration", async () => {
    const N = 8;
    // Every iteration's own result satisfies the assert, but they finish out
    // of order: the first-issued call returns last. With a shared "previous
    // result" the assert reads a sibling's value.
    let issued = 0;
    const reg = {
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "listItems") {
          return { items: Array.from({ length: N }, (_, i) => ({ id: `I-${i}` })) };
        }
        const n = issued++;
        await Bun.sleep((N - n) * 4);
        return { mine: true, id: args.id };
      },
      has: () => true,
    };
    const out = await runProgram(assertingLoop(N), { q: "x" }, { registry: reg, checkEnvelope: false });
    expect((out.value as unknown[]).length).toBe(N);
  });

  test("a failing assert in one iteration still fails", async () => {
    // The guard must not become "asserts in loops never fire".
    const N = 4;
    const reg = {
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "listItems") return { items: Array.from({ length: N }, (_, i) => ({ id: `I-${i}` })) };
        return { mine: args.id !== "I-2", id: args.id };
      },
      has: () => true,
    };
    await expect(runProgram(assertingLoop(N), { q: "x" }, { registry: reg, checkEnvelope: false })).rejects.toThrow();
  });
});

describe("a top-level wave holds to the same safety test as a loop body", () => {
  /**
   * Wave membership was gated on isBarrier, which rests on isMutating — a
   * fixed list of verbs. stepIsParallelSafe's own doc comment explains why
   * that is the wrong basis ("charge, refund, merge, deploy, approve") and
   * uses an allowlist instead, but only loop bodies were held to it. Two
   * independent steps whose names the verb list does not recognise were
   * batched into one wave and run concurrently.
   */
  function twoSteps(tool: string): StretchProgram {
    return withVersion({
      id: "p_wave",
      name: "wave",
      description: "d",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      sequence: [tool, tool],
      steps: [
        { id: "a", kind: "tool", tool, args: { q: { kind: "input", path: "q" } } },
        { id: "b", kind: "tool", tool, args: { q: { kind: "input", path: "q" } } },
      ],
      returns: { kind: "from", step: "b", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: null },
      manifest: null,
    } as unknown as Omit<StretchProgram, "version">) as StretchProgram;
  }

  test("two chargeCard steps do not run concurrently", async () => {
    // "charge" is in neither the mutating verb list nor the read vocabulary,
    // so it was treated as batchable by the denylist and unsafe by the
    // allowlist. The allowlist is right.
    const r = registry({ delayMs: 10 });
    await runProgram(twoSteps("chargeCard"), { q: "x" }, { registry: r.registry, checkEnvelope: false });
    expect(r.peakConcurrency).toBe(1);
  });

  test("two reads still share a wave", async () => {
    const r = registry({ delayMs: 10 });
    await runProgram(twoSteps("fetchDetails"), { q: "x" }, { registry: r.registry, checkEnvelope: false });
    expect(r.peakConcurrency).toBe(2);
  });

  test("a step the program marked readOnly still shares a wave", async () => {
    const p = twoSteps("chargeCard");
    for (const s of p.steps) (s as { readOnly?: boolean }).readOnly = true;
    const r = registry({ delayMs: 10 });
    await runProgram(p, { q: "x" }, { registry: r.registry, checkEnvelope: false });
    expect(r.peakConcurrency).toBe(2);
  });
});

describe("map-then-reduce: merge binds from the loop's collected results", () => {
  /**
   * Compiler moonshot: after foreach mapChunk, mergeReport({ rows }) must
   * take the array the loop stored at its step id — not a coincidental
   * sibling array of the same length. Runtime already writes that array to
   * scope.results[loopId]. This pin is the serve half; compile must emit it.
   */
  function mapReduceProgram(n: number): StretchProgram {
    return withVersion({
      id: "p_map_reduce",
      name: "map_reduce",
      description: "d",
      inputSchema: { type: "object", properties: { batch: { type: "string" } }, required: ["batch"] },
      sequence: ["listChunks", "mapChunk", "mergeReport"],
      steps: [
        { id: "listChunks", kind: "tool", tool: "listChunks", args: { batch: { kind: "input", path: "batch" } } },
        {
          id: "mapChunk_loop",
          kind: "loop",
          over: { kind: "from", step: "listChunks", path: "chunks" },
          item: "item_map",
          body: ["mapChunk"],
        },
        {
          id: "mapChunk",
          kind: "tool",
          tool: "mapChunk",
          args: { id: { kind: "from", step: "item_map", path: "id" } },
        },
        {
          id: "mergeReport",
          kind: "tool",
          tool: "mergeReport",
          args: { rows: { kind: "from", step: "mapChunk_loop", path: "" } },
        },
      ],
      returns: { kind: "from", step: "mergeReport", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: null },
      manifest: null,
    } as unknown as Omit<StretchProgram, "version">) as StretchProgram;
  }

  test("mergeReport receives the mapped rows in item order, not the source chunks", async () => {
    const n = 5;
    const seen: unknown[] = [];
    const reg = {
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "listChunks") {
          return { chunks: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })) };
        }
        if (tool === "mapChunk") return { row: `R-${args.id}`, id: args.id };
        if (tool === "mergeReport") {
          seen.push(args.rows);
          return { merged: true, n: Array.isArray(args.rows) ? args.rows.length : -1 };
        }
        return {};
      },
      has: () => true,
    };
    const out = await runProgram(mapReduceProgram(n), { batch: "B1" }, { registry: reg, checkEnvelope: false });
    expect(out.value).toEqual({ merged: true, n });
    expect(seen[0]).toEqual(Array.from({ length: n }, (_, i) => ({ row: `R-c${i}`, id: `c${i}` })));
  });

  test("empty chunks: mergeReport still runs with [] and does not deopt", async () => {
    const reg = {
      async execute(tool: string, args: Record<string, unknown>) {
        if (tool === "listChunks") return { chunks: [] };
        if (tool === "mergeReport") return { merged: true, n: Array.isArray(args.rows) ? args.rows.length : -1 };
        return { row: args.id };
      },
      has: () => true,
    };
    const out = await runProgram(mapReduceProgram(0), { batch: "B0" }, { registry: reg, checkEnvelope: false });
    expect(out.value).toEqual({ merged: true, n: 0 });
  });

  test("mapChunk without readOnly stays sequential; with readOnly it fans out", async () => {
    const n = 8;
    const chunks = Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));
    const make = (readOnly?: boolean) => {
      const p = mapReduceProgram(n);
      const body = p.steps.find((s) => s.id === "mapChunk") as { readOnly?: boolean };
      if (readOnly) body.readOnly = true;
      let inFlight = 0;
      let peak = 0;
      const registry = {
        async execute(tool: string, args: Record<string, unknown>) {
          if (tool === "listChunks") return { chunks };
          if (tool === "mapChunk") {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await Bun.sleep(8);
            inFlight--;
            return { row: args.id };
          }
          return { merged: true };
        },
        has: () => true,
      };
      return { p, registry, peakOf: () => peak };
    };
    const seq = make(false);
    await runProgram(seq.p, { batch: "B" }, { registry: seq.registry, checkEnvelope: false });
    expect(seq.peakOf()).toBe(1);
    const par = make(true);
    await runProgram(par.p, { batch: "B" }, { registry: par.registry, checkEnvelope: false });
    expect(par.peakOf()).toBeGreaterThan(1);
  });
});

describe("three-field object items", () => {
  test("restockLine receives sku, qty, and warehouse from each item", async () => {
    const items = [
      { sku: "A", qty: 2, warehouse: "w1" },
      { sku: "B", qty: 5, warehouse: "w2" },
    ];
    const seen: Array<Record<string, unknown>> = [];
    const p = withVersion({
      id: "p_three",
      name: "inventory",
      description: "d",
      inputSchema: { type: "object", properties: { cart: { type: "string" } }, required: ["cart"] },
      sequence: ["listBins", "restockLine", "createShipment"],
      steps: [
        { id: "listBins", kind: "tool", tool: "listBins", args: { cart: { kind: "input", path: "cart" } } },
        {
          id: "loop1",
          kind: "loop",
          over: { kind: "from", step: "listBins", path: "items" },
          item: "item_loop1",
          body: ["restockLine"],
        },
        {
          id: "restockLine",
          kind: "tool",
          tool: "restockLine",
          args: {
            sku: { kind: "from", step: "item_loop1", path: "sku" },
            qty: { kind: "from", step: "item_loop1", path: "qty" },
            warehouse: { kind: "from", step: "item_loop1", path: "warehouse" },
          },
        },
        {
          id: "createShipment",
          kind: "tool",
          tool: "createShipment",
          args: { cart: { kind: "input", path: "cart" } },
        },
      ],
      returns: { kind: "from", step: "createShipment", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: null },
      manifest: null,
    } as unknown as Omit<StretchProgram, "version">) as StretchProgram;
    const out = await runProgram(
      p,
      { cart: "C1" },
      {
        registry: {
          async execute(tool: string, args: Record<string, unknown>) {
            if (tool === "listBins") return { items };
            if (tool === "restockLine") {
              seen.push({ ...args });
              return { restocked: true };
            }
            return { shipped: true };
          },
          has: () => true,
        },
        checkEnvelope: false,
      },
    );
    expect(out.value).toEqual({ shipped: true });
    expect(seen).toEqual(items);
  });
});

describe("poll-until loops", () => {
  function pollProgram(maxIters: number): StretchProgram {
    return withVersion({
      id: "p_poll",
      name: "poll",
      description: "d",
      inputSchema: { type: "object", properties: { deploy: { type: "string" } }, required: ["deploy"] },
      sequence: ["getRollout", "verifyRollout"],
      steps: [
        {
          id: "loop1",
          kind: "loop",
          over: { kind: "literal", value: [0] },
          item: "item_loop1",
          body: ["getRollout"],
          until: "ready == true",
          maxIters,
          parallel: false,
        },
        {
          id: "getRollout",
          kind: "tool",
          tool: "getRollout",
          args: { deploy: { kind: "input", path: "deploy" } },
        },
        {
          id: "verifyRollout",
          kind: "tool",
          tool: "verifyRollout",
          args: { deploy: { kind: "input", path: "deploy" } },
        },
      ],
      returns: { kind: "from", step: "verifyRollout", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: null },
      manifest: null,
    } as unknown as Omit<StretchProgram, "version">) as StretchProgram;
  }

  test("repeats the body until ready is true, then runs the following tool", async () => {
    let n = 0;
    const seen: string[] = [];
    const out = await runProgram(
      pollProgram(5),
      { deploy: "d1" },
      {
        registry: {
          async execute(tool: string, args: Record<string, unknown>) {
            seen.push(tool);
            if (tool === "getRollout") {
              n++;
              return { deploy: args.deploy, ready: n >= 3 };
            }
            return { verified: true };
          },
          has: () => true,
        },
        checkEnvelope: false,
      },
    );
    expect(out.value).toEqual({ verified: true });
    expect(seen).toEqual(["getRollout", "getRollout", "getRollout", "verifyRollout"]);
  });

  test("deopts when ready never becomes true before maxIters", async () => {
    await expect(
      runProgram(
        pollProgram(3),
        { deploy: "d1" },
        {
          registry: {
            async execute() {
              return { ready: false };
            },
            has: () => true,
          },
          checkEnvelope: false,
        },
      ),
    ).rejects.toThrow(/exceeded maxIters/);
  });

  test("poll stays sequential even if the body is a read", async () => {
    let inFlight = 0;
    let peak = 0;
    let n = 0;
    await runProgram(
      pollProgram(5),
      { deploy: "d1" },
      {
        registry: {
          async execute(tool: string) {
            if (tool === "getRollout") {
              inFlight++;
              peak = Math.max(peak, inFlight);
              await Bun.sleep(8);
              inFlight--;
              n++;
              return { ready: n >= 3 };
            }
            return { verified: true };
          },
          has: () => true,
        },
        checkEnvelope: false,
      },
    );
    expect(peak).toBe(1);
  });

  test("retry-until catches tool throws and succeeds on a later attempt", async () => {
    let n = 0;
    const p = withVersion({
      id: "p_retry",
      name: "retry",
      description: "d",
      inputSchema: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
      sequence: ["pushImage", "tagRelease"],
      steps: [
        {
          id: "loop1",
          kind: "loop",
          over: { kind: "literal", value: [0] },
          item: "item_loop1",
          body: ["pushImage"],
          until: "pushed == true",
          maxIters: 3,
          parallel: false,
        },
        {
          id: "pushImage",
          kind: "tool",
          tool: "pushImage",
          args: { tag: { kind: "input", path: "tag" } },
        },
        {
          id: "tagRelease",
          kind: "tool",
          tool: "tagRelease",
          args: { tag: { kind: "input", path: "tag" } },
        },
      ],
      returns: { kind: "from", step: "tagRelease", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: null },
      manifest: null,
    } as unknown as Omit<StretchProgram, "version">) as StretchProgram;
    const out = await runProgram(
      p,
      { tag: "img-0" },
      {
        registry: {
          async execute(tool: string) {
            if (tool === "pushImage") {
              n++;
              if (n < 3) throw new Error("429 rate limited");
              return { pushed: true, tag: "img-0" };
            }
            return { released: true };
          },
          has: () => true,
        },
        checkEnvelope: false,
      },
    );
    expect(n).toBe(3);
    expect(out.value).toEqual({ released: true });
  });
});

describe("nested loop-item paths", () => {
  test("updateIssue receives node.id and node.title from each edge", async () => {
    const edges = [{ node: { id: "I-1", title: "one" } }, { node: { id: "I-2", title: "two" } }];
    const seen: Array<Record<string, unknown>> = [];
    const p = withVersion({
      id: "p_relay",
      name: "relay",
      description: "d",
      inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
      sequence: ["listIssues", "updateIssue", "publishDigest"],
      steps: [
        { id: "listIssues", kind: "tool", tool: "listIssues", args: { repo: { kind: "input", path: "repo" } } },
        {
          id: "loop1",
          kind: "loop",
          over: { kind: "from", step: "listIssues", path: "edges" },
          item: "item_loop1",
          body: ["updateIssue"],
        },
        {
          id: "updateIssue",
          kind: "tool",
          tool: "updateIssue",
          args: {
            id: { kind: "from", step: "item_loop1", path: "node.id" },
            title: { kind: "from", step: "item_loop1", path: "node.title" },
          },
        },
        {
          id: "publishDigest",
          kind: "tool",
          tool: "publishDigest",
          args: { repo: { kind: "input", path: "repo" } },
        },
      ],
      returns: { kind: "from", step: "publishDigest", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: null },
      manifest: null,
    } as unknown as Omit<StretchProgram, "version">) as StretchProgram;
    const out = await runProgram(
      p,
      { repo: "acme" },
      {
        registry: {
          async execute(tool: string, args: Record<string, unknown>) {
            if (tool === "listIssues") return { edges };
            if (tool === "updateIssue") {
              seen.push({ ...args });
              return { updated: true };
            }
            return { published: true };
          },
          has: () => true,
        },
        checkEnvelope: false,
      },
    );
    expect(out.value).toEqual({ published: true });
    expect(seen).toEqual([
      { id: "I-1", title: "one" },
      { id: "I-2", title: "two" },
    ]);
  });
});
