import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { IslandCaller, StretchProgram, StretchTrace } from "@eden/ir";
import { hashTrace } from "@eden/ir";
import { compileTraces } from "../../compile/src/index";
import { decide, type Verdict } from "../../measure/src/verdict";
import {
  compiledTokens,
  compiledToolMs,
  isSyntheticDuration,
  naiveToolMs,
  traceTokens,
} from "../../shadow/src/measure";
import { isUnrecordedCall, replayRegistry } from "../../shadow/src/replay";
import { runProgram } from "../../runtime/src/index";

const USAGE = `eden bench --traces <dir|glob> [--seed N] [--blocks N]

Paired A/B between recorded naive runs and their compiled replay.
Each trace is one block: the naive side is what the recording paid, the
compiled side replays through the shadow tape registry so nothing hits
the network. The verdict is measure's — permutation p, bootstrap CI,
and a call that can be INDISTINGUISHABLE or UNTRUSTWORTHY_INSTRUMENT.
What was not measured is reported as not measured.

  --traces   directory or glob of StretchTrace JSON files (required)
  --seed     seed for the resampling PRNGs (default 0x5eed)
  --blocks   fewest paired blocks a verdict may rest on (default 3)`;

export type BenchOpts = { seed?: number; minBlocks?: number };

export type BenchMetric = {
  delta: number | null;
  measured: boolean;
  estimated?: boolean;
};

export type BenchReport = {
  verdict: Verdict;
  n: number;
  p_value: number | null;
  ci: {
    point: number | null;
    lo: number | null;
    hi: number | null;
    relative: { point: number | null; lo: number | null; hi: number | null };
    unit: string;
  };
  tokens: BenchMetric;
  time_ms: BenchMetric;
  notes: string[];
};

const localIsland: IslandCaller = async ({ input }) => {
  const f = (input ?? {}) as Record<string, unknown>;
  const who = f.customer ?? "there";
  const what = f.issue ?? JSON.stringify(f);
  return { text: `Hi ${who}, thanks for reporting this. We are on it: ${what}` };
};

type Block = {
  task: string;
  naiveCents: number;
  compiledCents: number;
  naiveTokens?: number;
  compiledTokens?: number;
  naiveMs?: number;
  compiledMs?: number;
  syntheticClock: boolean;
};

function parseTrace(text: string, path: string): StretchTrace {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`eden bench: ${path} is not valid JSON (${(e as Error).message})`);
  }
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`eden bench: ${path} is not a trace object`);
  }
  const t = json as Record<string, unknown>;
  const need = (k: string, ok: boolean) => {
    if (!ok) throw new Error(`eden bench: ${path} has no usable "${k}" — not a StretchTrace`);
  };
  need("id", typeof t.id === "string");
  need("events", Array.isArray(t.events));
  for (const k of ["llmCalls", "duration_ms", "cost_cents"] as const) {
    need(k, typeof t[k] === "number" && Number.isFinite(t[k] as number));
  }
  return t as unknown as StretchTrace;
}

export function tracePaths(spec: string): string[] {
  const out: string[] = [];
  if (spec.includes("*") || spec.includes("?")) {
    const glob = new Bun.Glob(spec);
    for (const f of glob.scanSync({ cwd: process.cwd(), onlyFiles: true })) {
      if (f.endsWith(".json")) out.push(f.startsWith("/") ? f : join(process.cwd(), f));
    }
  } else {
    let entries: Dirent[];
    try {
      entries = readdirSync(spec, { withFileTypes: true });
    } catch {
      out.push(spec); // not a directory — treat as one file and let the reader complain
      return out.sort();
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile() && e.name.endsWith(".json")) out.push(join(spec, e.name));
    }
  }
  return out.sort();
}

export async function loadTraces(spec: string): Promise<StretchTrace[]> {
  const paths = tracePaths(spec);
  if (!paths.length) {
    throw new Error(
      `eden bench: no trace files found at ${spec} — point --traces at a directory or glob of StretchTrace JSON files`,
    );
  }
  const traces: StretchTrace[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch {
      throw new Error(`eden bench: cannot read trace file ${path} — no such file`);
    }
    traces.push(parseTrace(text, path));
  }
  return dedupeTraces(traces);
}

function dedupeTraces(traces: StretchTrace[]): StretchTrace[] {
  const seen = new Set<string>();
  const out: StretchTrace[] = [];
  for (const t of traces) {
    const h = hashTrace(t);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(t);
  }
  return out;
}

async function replayPass(
  program: StretchProgram,
  traces: StretchTrace[],
  hasIsland: boolean,
): Promise<{ blocks: Block[]; unrecorded: number; errored: number; firstError?: string }> {
  const blocks: Block[] = [];
  let unrecorded = 0;
  let errored = 0;
  let firstError: string | undefined;
  for (const t of traces) {
    try {
      const run = await runProgram(program, t.input ?? {}, {
        registry: replayRegistry(undefined, t),
        island: hasIsland ? localIsland : undefined,
        checkEnvelope: true,
        timeoutMs: 60_000,
        llmCents: 1,
      });
      // Paired like shadow's ledger: naive numbers accumulate only over the
      // traces whose compiled numbers do, so a trace the recording cannot
      // answer inflates neither side alone.
      const block: Block = {
        task: t.id,
        naiveCents: t.cost_cents,
        compiledCents: run.stats.cents,
        syntheticClock: isSyntheticDuration(t),
      };
      const naiveT = traceTokens(t);
      const compiledT = compiledTokens(t, run.stats.llmCalls, hasIsland);
      if (naiveT != null && compiledT != null) {
        block.naiveTokens = naiveT;
        block.compiledTokens = compiledT;
      }
      const toolsMs = compiledToolMs(t, run.stats.toolCalls);
      const naiveTools = naiveToolMs(t);
      if (!block.syntheticClock && naiveTools != null && toolsMs != null) {
        block.naiveMs = naiveTools;
        // Same convention as shadow's manifest: this trace's tool durations on
        // both sides, plus real wall for any island step. Blocks missing any
        // duration drop out rather than mixing clocks.
        block.compiledMs = toolsMs + (hasIsland && run.stats.llmCalls >= 1 ? run.stats.islandMs : 0);
      }
      blocks.push(block);
    } catch (err) {
      // Not necessarily a fault: the compiled program runs the checks the
      // agent skipped. The trace simply cannot pair this program, so it is
      // counted and set aside — never silently dropped.
      if (isUnrecordedCall(err)) unrecorded++;
      else {
        errored++;
        firstError ??= (err as Error).message;
      }
    }
  }
  return { blocks, unrecorded, errored, firstError };
}

const samplesOf = (
  blocks: readonly Block[],
  pick: (b: Block) => number | undefined,
): Array<{ task: string; repeat: number; value: number }> => {
  const out: Array<{ task: string; repeat: number; value: number }> = [];
  for (const b of blocks) {
    const v = pick(b);
    if (v != null) out.push({ task: b.task, repeat: 0, value: v });
  }
  return out;
};

function paired<T>(blocks: readonly Block[], x: (b: Block) => T | undefined, y: (b: Block) => T | undefined): Array<{ x: T; y: T }> {
  const out: Array<{ x: T; y: T }> = [];
  for (const b of blocks) {
    const vx = x(b);
    const vy = y(b);
    if (vx != null && vy != null) out.push({ x: vx, y: vy });
  }
  return out;
}

const meanOf = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

export async function collectBench(traces: StretchTrace[], opts: BenchOpts = {}): Promise<BenchReport> {
  const seed = opts.seed ?? 0x5eed;
  const minBlocks = Math.max(1, opts.minBlocks ?? 3);

  const mined = compileTraces(traces);
  const program = mined.programs[0];
  if (!program) {
    const why = mined.refusals[0]?.reason ?? "no repeated tool sequence found";
    throw new Error(`eden bench: could not compile a program from these traces (${why})`);
  }
  const hasIsland = program.steps.some((s) => s.kind === "island");

  const first = await replayPass(program, traces, hasIsland);
  const second = await replayPass(program, traces, hasIsland);
  const blocks = first.blocks;
  if (!blocks.length) {
    const why =
      first.unrecorded || first.errored
        ? `${first.unrecorded} made calls the recording does not contain, ${first.errored} errored${first.firstError ? ` (first: ${first.firstError})` : ""}`
        : "every replay failed";
    throw new Error(`eden bench: no paired blocks could be replayed — ${why}`);
  }

  const notes: string[] = [
    `program ${program.name}: ${program.steps.filter((s) => s.kind === "tool").length} tool steps${hasIsland ? ", island served locally (no network)" : ""}`,
  ];
  if (first.unrecorded + first.errored > 0) {
    notes.push(
      `${first.unrecorded + first.errored} of ${traces.length} traces could not be paired and are excluded: ` +
        `${first.unrecorded} made calls the recording does not contain, ${first.errored} errored` +
        `${first.firstError ? ` (first: ${first.firstError})` : ""}.`,
    );
  }

  const decision = decide({
    treatment: samplesOf(blocks, (b) => b.compiledCents),
    control: samplesOf(blocks, (b) => b.naiveCents),
    nullControl: {
      a: samplesOf(second.blocks, (b) => b.compiledCents),
      b: samplesOf(first.blocks, (b) => b.compiledCents),
    },
    higherIsBetter: false,
    minBlocks,
    seed,
  });

  const tokenPairs = paired(blocks, (b) => b.naiveTokens, (b) => b.compiledTokens);
  const timePairs = paired(blocks, (b) => b.naiveMs, (b) => b.compiledMs);
  const synthetic = blocks.some((b) => b.syntheticClock);

  let tokens: BenchMetric;
  if (tokenPairs.length < blocks.length) {
    tokens = { delta: null, measured: false };
    notes.push("tokens not measured: some traces carry no scraped usage, so the delta would mix instruments.");
  } else {
    const raw = meanOf(tokenPairs.map((p) => p.y - p.x));
    if (!Number.isFinite(raw)) {
      tokens = { delta: null, measured: false };
      notes.push("tokens not measured: the computed delta came back non-finite.");
    } else {
      const estimated = hasIsland && tokenPairs.some((p) => p.y > 0);
      tokens = { delta: raw, measured: true, estimated };
      if (estimated) {
        notes.push("tokens estimated: island usage is scaled from the recording, not metered — it cannot gate a ship decision alone.");
      }
    }
  }

  let time: BenchMetric;
  if (synthetic) {
    time = { delta: null, measured: false };
    notes.push("time not measured: trace clocks are the synthetic fixture clock (duration_ms == 200 × llmCalls).");
  } else if (timePairs.length < blocks.length) {
    time = { delta: null, measured: false };
    notes.push("time not measured: some events carry no duration_ms, so the delta would mix clocks.");
  } else {
    const raw = meanOf(timePairs.map((p) => p.y - p.x));
    if (!Number.isFinite(raw)) {
      time = { delta: null, measured: false };
      notes.push("time not measured: the computed delta came back non-finite.");
    } else {
      time = { delta: raw, measured: true };
    }
  }

  notes.push(...decision.reasons);

  // Honest numbers or absent: a non-finite statistic must never stringify to
  // null silently — it becomes an explicit null plus a note saying why.
  const p = Number.isFinite(decision.p) ? decision.p : null;
  if (p === null) notes.push("p_value not measured: the permutation test returned a non-finite p.");
  const point = Number.isFinite(decision.delta.point) ? decision.delta.point : null;
  const lo = Number.isFinite(decision.delta.lo) ? decision.delta.lo : null;
  const hi = Number.isFinite(decision.delta.hi) ? decision.delta.hi : null;
  if (point === null || lo === null || hi === null) {
    notes.push("ci not measured: the bootstrap interval returned non-finite bounds.");
  }

  return {
    verdict: decision.verdict,
    n: decision.blocks,
    p_value: p,
    ci: {
      point,
      lo,
      hi,
      relative: {
        point: Number.isFinite(decision.relative.point) ? decision.relative.point : null,
        lo: Number.isFinite(decision.relative.lo) ? decision.relative.lo : null,
        hi: Number.isFinite(decision.relative.hi) ? decision.relative.hi : null,
      },
      unit: "cents/block (compiled − naive)",
    },
    tokens,
    time_ms: time,
    notes,
  };
}

export function formatBench(report: BenchReport): string {
  return JSON.stringify(report, null, 2);
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function intArg(args: string[], flag: string): number | undefined {
  const raw = arg(args, flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`eden bench: ${flag} expects a positive integer, received ${JSON.stringify(raw)}`);
  }
  return n;
}

export async function bench(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const spec = arg(args, "--traces");
    if (!spec) {
      console.error(USAGE);
      console.error("\neden bench: --traces is required");
      return 2;
    }
    const seed = intArg(args, "--seed");
    const minBlocks = intArg(args, "--blocks");
    const traces = await loadTraces(spec);
    const report = await collectBench(traces, { seed, minBlocks });
    console.log(formatBench(report));
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
