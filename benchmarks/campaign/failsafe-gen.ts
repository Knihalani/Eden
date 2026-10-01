/**
 * Wave 1.4 failsafe property-fuzz generator.
 *
 * Grammar per case:
 *   sequence  — 3–8 tools from TOOL_POOL; head is always a read (lookup|fetch)
 *   width     — optional fan-out: repeat one read name 1–4 extra times
 *   island    — optional draft island at index >= 1 (incl. after a write / at end)
 *   fault     — none | timeout | throw500 | corruptJson | abort
 *
 * Deterministic via mulberry32(seed). Never Math.random.
 */
import { mulberry32 } from "@eden/measure";
import { withVersion, type Step, type StretchProgram } from "@eden/ir";
import type { ToolDef } from "@eden/wrap";

export const FUZZ_SEED = 0xf5a1;
export const N_CASES = 10000;
export const N_FAST = 50;
/** Cap timeout-fault cases so the 10k suite stays well under the wall budget. */
export const MAX_TIMEOUT_CASES = 50;
/** Cheap wrap cases fan out; keep this under wrap's per-state arming cap. */
export const FUZZ_CONCURRENCY = 32;

export const TOOL_POOL = ["lookup", "fetch", "writeA", "writeB", "audit", "notify"] as const;
export type ToolName = (typeof TOOL_POOL)[number];

export const MUTATING_TOOLS = new Set<string>(["writeA", "writeB", "notify"]);
export const READ_TOOLS = new Set<string>(["lookup", "fetch", "audit"]);

export type FaultKind = "none" | "timeout" | "throw500" | "corruptJson" | "abort";
export type IslandBehavior = "success" | "throw" | "timeout" | "abort" | "corrupt";

export type FuzzCase = {
  index: number;
  id: string;
  /** Tool names the oblivious agent fires (no island). */
  sequence: string[];
  /**
   * Insert island *before* this index in `sequence` (1..length inclusive).
   * `length` means after the last tool. Null = no island.
   */
  islandAt: number | null;
  islandBehavior: IslandBehavior;
  fault: FaultKind;
  /** Index into `sequence` of the tool that carries the fault behavior. */
  faultAt: number;
};

export type MutationMap = Record<string, number>;

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

function int(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function drawFault(rng: () => number, timeoutLeft: { n: number }): FaultKind {
  // Weight: none heavy; faults rarer; timeout gated by budget.
  const r = rng();
  if (r < 0.45) return "none";
  if (r < 0.6) return "throw500";
  if (r < 0.75) return "corruptJson";
  if (r < 0.88) return "abort";
  if (timeoutLeft.n > 0) {
    timeoutLeft.n--;
    return "timeout";
  }
  return "none";
}

function drawIslandBehavior(rng: () => number, fault: FaultKind): IslandBehavior {
  if (fault === "corruptJson") return pick(rng, ["corrupt", "throw"] as const);
  if (fault === "abort") return pick(rng, ["abort", "throw"] as const);
  if (fault === "timeout") return pick(rng, ["timeout", "success", "throw"] as const);
  return pick(rng, ["success", "throw", "abort", "corrupt"] as const);
}

/** Build one case. `timeoutLeft` is mutated when a timeout fault is assigned. */
export function generateCase(rng: () => number, index: number, timeoutLeft: { n: number }): FuzzCase {
  const len = int(rng, 3, 8);
  const sequence: string[] = [];
  // Head must be a steerable read.
  sequence.push(pick(rng, ["lookup", "fetch"] as const));
  while (sequence.length < len) {
    sequence.push(pick(rng, TOOL_POOL));
  }

  // Optional width: fan-out one read already in the tail (or inject one).
  if (rng() < 0.35) {
    const readCandidates = sequence.filter((t, i) => i > 0 && READ_TOOLS.has(t));
    const tool = readCandidates.length ? pick(rng, readCandidates) : pick(rng, ["lookup", "fetch", "audit"] as const);
    const fanout = int(rng, 1, 4);
    const insertAt = Math.max(1, int(rng, 1, sequence.length));
    for (let k = 0; k < fanout; k++) sequence.splice(insertAt, 0, tool);
  }

  // Prefer at least one mutating tool so exactly-once is testable.
  if (!sequence.some((t) => MUTATING_TOOLS.has(t)) && rng() < 0.85) {
    sequence[int(rng, 1, sequence.length - 1)] = pick(rng, ["writeA", "writeB", "notify"] as const);
  }

  const fault = drawFault(rng, timeoutLeft);

  // Island at index >= 1 (never before head). Bias toward after a write when present.
  let islandAt: number | null = null;
  let islandBehavior: IslandBehavior = "success";
  const wantIsland = fault === "corruptJson" || rng() < 0.4;
  if (wantIsland) {
    const afterWrite: number[] = [];
    for (let i = 1; i <= sequence.length; i++) {
      if (i > 0 && MUTATING_TOOLS.has(sequence[i - 1]!)) afterWrite.push(i);
    }
    islandAt = afterWrite.length && rng() < 0.7 ? pick(rng, afterWrite) : int(rng, 1, sequence.length);
    islandBehavior = drawIslandBehavior(rng, fault);
    // At most one sleep path per case; island-timeout spends the same budget.
    if (islandBehavior === "timeout") {
      if (fault === "timeout" || timeoutLeft.n <= 0) islandBehavior = "throw";
      else timeoutLeft.n--;
    }
  }

  // Fault carrier: for timeout, prefer a non-mutating mid tool (P3 shape).
  let faultAt = int(rng, 1, sequence.length - 1);
  if (fault === "timeout") {
    const slowCandidates = sequence.map((t, i) => ({ t, i })).filter(({ t, i }) => i > 0 && !MUTATING_TOOLS.has(t));
    if (slowCandidates.length) faultAt = pick(rng, slowCandidates).i;
  } else if (fault === "throw500" || fault === "abort") {
    faultAt = int(rng, 0, sequence.length - 1);
  } else if (fault === "corruptJson" && islandAt == null) {
    // No island: make a mid tool return a weird thenable.
    faultAt = int(rng, 1, sequence.length - 1);
  }

  return {
    index,
    id: `F-${index}`,
    sequence,
    islandAt,
    islandBehavior,
    fault,
    faultAt,
  };
}

export function generateSuite(seed = FUZZ_SEED, n = N_CASES): FuzzCase[] {
  const rng = mulberry32(seed);
  const timeoutLeft = { n: MAX_TIMEOUT_CASES };
  const out: FuzzCase[] = [];
  for (let i = 0; i < n; i++) out.push(generateCase(rng, i, timeoutLeft));
  return out;
}

/** Bounded worker pool. Single-threaded increment; no Math.random. */
export async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]!, i);
      }
    }),
  );
}

/** Unique step id when the same tool appears more than once. */
function stepId(tool: string, occurrence: number): string {
  return occurrence === 0 ? tool : `${tool}_${occurrence}`;
}

export function buildProgram(spec: FuzzCase): StretchProgram {
  const steps: Step[] = [];
  const sequence: string[] = [];
  const seen = new Map<string, number>();

  const pushTool = (tool: string, isHead: boolean) => {
    const n = seen.get(tool) ?? 0;
    seen.set(tool, n + 1);
    const id = stepId(tool, n);
    sequence.push(tool);
    steps.push({
      id,
      kind: "tool",
      tool,
      args: {
        id: { kind: "input", path: "id" },
        ...(isHead ? { text: { kind: "input", path: "text" } } : {}),
      },
    });
  };

  for (let i = 0; i < spec.sequence.length; i++) {
    if (spec.islandAt === i) {
      sequence.push("draft");
      steps.push({
        id: "draft",
        kind: "island",
        input: { kind: "input", path: "" },
        system: "s",
        outputSchema: {},
      });
    }
    pushTool(spec.sequence[i]!, i === 0);
  }
  if (spec.islandAt === spec.sequence.length) {
    sequence.push("draft");
    steps.push({
      id: "draft",
      kind: "island",
      input: { kind: "input", path: "" },
      system: "s",
      outputSchema: {},
    });
  }

  const lastId = steps[steps.length - 1]!.id;
  return withVersion({
    id: `fuzz_${spec.index}`,
    name: `fuzz_${spec.index}`,
    description: "failsafe fuzz",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" } },
      required: ["id", "text"],
    },
    sequence,
    steps,
    returns: { kind: "from", step: lastId, path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
    manifest: {
      llmReduction: 5,
      latencyReduction: 2,
      costReduction: 5,
      skipRateBefore: 0,
      skipRateAfter: 0,
      nShadow: 3,
    },
  }) as StretchProgram;
}

export function makeIsland(spec: FuzzCase): (req: unknown) => Promise<unknown> {
  const behavior = spec.islandBehavior;
  return async () => {
    switch (behavior) {
      case "success":
        return { drafted: true };
      case "throw":
        throw new Error("island boom");
      case "timeout":
        await Bun.sleep(200);
        return { drafted: true };
      case "abort": {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      case "corrupt":
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      default:
        return { drafted: true };
    }
  };
}

export function buildScript(spec: FuzzCase): Array<{ tool: string; args: Record<string, unknown> }> {
  return spec.sequence.map((tool, i) => ({
    tool,
    args: i === 0 ? { id: spec.id, text: `t-${spec.index}` } : { id: spec.id },
  }));
}

export function buildTools(spec: FuzzCase, mutations: MutationMap): Record<string, ToolDef> {
  const faultTool = spec.sequence[spec.faultAt]!;
  const tools: Record<string, ToolDef> = {};
  for (const name of TOOL_POOL) {
    tools[name] = {
      description: name,
      execute: async (args: Record<string, unknown>) => {
        if (name === faultTool) {
          if (spec.fault === "timeout") {
            await Bun.sleep(100);
          } else if (spec.fault === "throw500") {
            throw new Error("500");
          } else if (spec.fault === "abort") {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          } else if (spec.fault === "corruptJson" && spec.islandAt == null) {
            // Thenable-shaped junk — wrap must not hang or double-write.
            return { then: 1 };
          }
        }

        if (MUTATING_TOOLS.has(name)) {
          const key = `${name}:${String(args.id)}`;
          mutations[key] = (mutations[key] ?? 0) + 1;
        }
        return { name, id: args.id, ok: true };
      },
    };
  }
  return tools;
}

/** Oblivious driver: full script concurrently (sibling race). */
export async function fireOblivious(
  wrapped: Record<string, ToolDef>,
  script: Array<{ tool: string; args: Record<string, unknown> }>,
): Promise<void> {
  await Promise.all(
    script.map(async (c) => {
      try {
        await wrapped[c.tool]!.execute(c.args);
      } catch {
        // Tool throws (injected fault) — agent continues; we only care about mutations.
      }
    }),
  );
}

export function mutKeys(sequence: string[], id: string): string[] {
  return [...new Set(sequence.filter((t) => MUTATING_TOOLS.has(t)).map((t) => `${t}:${id}`))];
}

export function formatCase(spec: FuzzCase, raw: MutationMap, wrapped: MutationMap): string {
  return [
    `seed=${FUZZ_SEED}`,
    `case=${spec.index}`,
    `id=${spec.id}`,
    `seq=[${spec.sequence.join(",")}]`,
    `islandAt=${spec.islandAt}`,
    `island=${spec.islandBehavior}`,
    `fault=${spec.fault}@${spec.faultAt}`,
    `raw=${JSON.stringify(raw)}`,
    `wrapped=${JSON.stringify(wrapped)}`,
  ].join(" ");
}

export function assertEdenAbsentEquivalent(spec: FuzzCase, raw: MutationMap, wrapped: MutationMap): void {
  const keys = new Set([...Object.keys(raw), ...Object.keys(wrapped), ...mutKeys(spec.sequence, spec.id)]);
  for (const key of keys) {
    const w = wrapped[key] ?? 0;
    const r = raw[key] ?? 0;
    // Hard fail: never more writes than raw for the same entity.
    if (w > r) {
      throw new Error(`divergence wrapped>raw ${key} wrapped=${w} raw=${r} | ${formatCase(spec, raw, wrapped)}`);
    }
    // Never more than the program itself issues (tool appears N times → ≤N).
    const tool = key.slice(0, key.lastIndexOf(":"));
    const programmed = spec.sequence.filter((t) => t === tool).length;
    if (w > programmed) {
      throw new Error(
        `divergence wrapped>programmed ${key} wrapped=${w} programmed=${programmed} | ${formatCase(spec, raw, wrapped)}`,
      );
    }
  }
}
