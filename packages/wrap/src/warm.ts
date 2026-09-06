import type { Binding, Step, StretchProgram, ToolRegistry } from "@eden/ir";
import { eq, isMutating, isReadName, isBarrierName, mayServe } from "@eden/ir";
import { evalArgs } from "@eden/runtime";
import { isProgramReadOnly } from "./fleet";
import { extractInput } from "./steer";
import type { WrapState } from "./wrap-tools";

export type WarmHint = {
  input?: Record<string, unknown>;
  program?: StretchProgram | string;
};

export type WarmHandle = {
  programId: string;
  input: Record<string, unknown>;
  tools: string[];
  startedAt: number;
};

export type WarmTake = { hit: true; value: unknown } | { hit: false };

export type WarmProgramStats = { lookups: number; hits: number };

export type WarmStats = {
  lookups: number;
  hits: number;
  mutatingExecutes: number;
  byProgram: Record<string, WarmProgramStats>;
};

export type WarmRunner = {
  live: () => StretchProgram[];
  execute: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
};

type Entry = {
  programId: string;
  tool: string;
  args: Record<string, unknown>;
  discarded: boolean;
  promise: Promise<{ ok: true; value: unknown } | { ok: false }>;
};

type Store = {
  runner?: WarmRunner;
  entries: Entry[];
  stats: WarmStats;
  lastServedId: string | null;
  follows: Map<string, Map<string, number>>;
};

const stores = new WeakMap<WrapState, Store>();
const MAX_ENTRIES = 64;

function emptyStats(): WarmStats {
  return { lookups: 0, hits: 0, mutatingExecutes: 0, byProgram: {} };
}

function storeOf(state: WrapState): Store {
  let s = stores.get(state);
  if (!s) {
    s = { entries: [], stats: emptyStats(), lastServedId: null, follows: new Map() };
    stores.set(state, s);
  }
  return s;
}

export function watchWarmEnabled(): boolean {
  try {
    return process.env.EDEN_WATCH_WARM !== "0";
  } catch {
    return false;
  }
}

export function bindWarmRunner(state: WrapState, runner: WarmRunner): void {
  try {
    storeOf(state).runner = runner;
  } catch {
    /* fail-open: missing runner means watchWarm is a no-op */
  }
}

function bindingDependsOnStep(b: Binding): boolean {
  if (b.kind === "from") return true;
  if (b.kind === "transform") return bindingDependsOnStep(b.of);
  return false;
}

function bodyOwned(program: StretchProgram): Set<string> {
  const owned = new Set<string>();
  for (const s of program.steps ?? []) {
    if (s.kind === "loop") for (const id of s.body) owned.add(id);
    if (s.kind === "branch") {
      for (const id of s.then) owned.add(id);
      for (const id of s.else ?? []) owned.add(id);
      for (const c of s.cases ?? []) for (const id of c.steps) owned.add(id);
    }
  }
  return owned;
}

function isSafeReadTool(step: Step): step is Step & { kind: "tool" } {
  if (step.kind !== "tool") return false;
  if (isMutating(step.tool) || isBarrierName(step.tool)) return false;
  if (!(step.readOnly === true || isReadName(step.tool))) return false;
  return Object.values(step.args).every((b) => !bindingDependsOnStep(b));
}

export function firstWaveReads(
  program: StretchProgram,
  input: Record<string, unknown>,
): Array<{ tool: string; args: Record<string, unknown> }> {
  const owned = bodyOwned(program);
  const pending = (program.steps ?? []).filter((s) => !owned.has(s.id));
  const wave: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const scope = { input, results: new Map<string, unknown>() };
  for (const step of pending) {
    if (!isSafeReadTool(step)) break;
    try {
      const args = evalArgs(step.args, scope);
      wave.push({ tool: step.tool, args });
    } catch {
      break;
    }
  }
  return wave;
}

function isSafeToWarm(program: StretchProgram): boolean {
  if (!isProgramReadOnly(program)) return false;
  const seq = program.sequence ?? [];
  if (!seq.length) return false;
  if (!seq.every((n) => isReadName(n) && !isMutating(n))) return false;
  for (const step of program.steps ?? []) {
    if (step.kind === "island") return false;
    if (step.kind === "tool" && (isMutating(step.tool) || !isReadName(step.tool))) return false;
  }
  return true;
}

function hintInput(currentInput: Record<string, unknown>, hint: WarmHint): Record<string, unknown> {
  if (hint.input && typeof hint.input === "object") return hint.input;
  return currentInput;
}

function followScore(s: Store, fromId: string, toId: string): number {
  return s.follows.get(fromId)?.get(toId) ?? 0;
}

function noteFollow(s: Store, currentId: string): void {
  const prev = s.lastServedId;
  if (prev && prev !== currentId) {
    let row = s.follows.get(prev);
    if (!row) {
      row = new Map();
      s.follows.set(prev, row);
    }
    row.set(currentId, (row.get(currentId) ?? 0) + 1);
  }
  s.lastServedId = currentId;
}

function pickNext(
  s: Store,
  live: StretchProgram[],
  current: StretchProgram,
  currentInput: Record<string, unknown>,
  hint: WarmHint,
): { program: StretchProgram; input: Record<string, unknown> } | null {
  const raw = hintInput(currentInput, hint);
  const named =
    hint.program == null
      ? undefined
      : typeof hint.program === "string"
        ? live.find((p) => p.id === hint.program || p.name === hint.program)
        : hint.program;
  const candidates = named
    ? [named]
    : live
        .filter((p) => p.id !== current.id && isSafeToWarm(p))
        .sort((a, b) => {
          const fa = followScore(s, current.id, a.id);
          const fb = followScore(s, current.id, b.id);
          if (fb !== fa) return fb - fa;
          return (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0);
        });
  for (const program of candidates) {
    if (program.id === current.id) continue;
    if (!isSafeToWarm(program)) continue;
    const input = extractInput(program, raw);
    if (!Object.keys(input).length) continue;
    if (!mayServe(program, input)) continue;
    if (!firstWaveReads(program, input).length) continue;
    return { program, input };
  }
  return null;
}

function findEntry(entries: Entry[], programId: string, tool: string, args: Record<string, unknown>): Entry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.discarded) continue;
    if (e.programId === programId && e.tool === tool && eq(e.args, args)) return e;
  }
  return undefined;
}

function trimEntries(s: Store): void {
  if (s.entries.length <= MAX_ENTRIES) return;
  s.entries.splice(0, s.entries.length - MAX_ENTRIES / 2);
}

function programStats(s: Store, programId: string): WarmProgramStats {
  const cur = s.stats.byProgram[programId];
  if (cur) return cur;
  const fresh = { lookups: 0, hits: 0 };
  s.stats.byProgram[programId] = fresh;
  return fresh;
}

function sameWarm(
  entries: Entry[],
  programId: string,
  wave: Array<{ tool: string; args: Record<string, unknown> }>,
): boolean {
  if (!wave.length) return false;
  return wave.every((w) => findEntry(entries, programId, w.tool, w.args));
}

export function claimWarm(state: WrapState, program: StretchProgram, input: Record<string, unknown>): void {
  try {
    const wave = firstWaveReads(program, input);
    const s = storeOf(state);
    for (const e of s.entries) {
      if (e.programId !== program.id) continue;
      const match = wave.some((w) => w.tool === e.tool && eq(w.args, e.args));
      if (!match) e.discarded = true;
    }
  } catch {
    /* fail-open */
  }
}

export function discardWarm(state: WrapState): void {
  try {
    const s = storeOf(state);
    for (const e of s.entries) e.discarded = true;
    s.entries = [];
  } catch {
    /* fail-open */
  }
}

export function warmStats(state: WrapState): WarmStats {
  try {
    const s = storeOf(state).stats;
    return {
      lookups: s.lookups,
      hits: s.hits,
      mutatingExecutes: s.mutatingExecutes,
      byProgram: { ...s.byProgram },
    };
  } catch {
    return emptyStats();
  }
}

export function warmHitRate(state: WrapState, programId?: string): { hits: number; lookups: number; rate: number } {
  try {
    const s = storeOf(state).stats;
    const slice = programId ? (s.byProgram[programId] ?? { hits: 0, lookups: 0 }) : s;
    const lookups = slice.lookups;
    const hits = slice.hits;
    return { hits, lookups, rate: lookups === 0 ? 0 : hits / lookups };
  } catch {
    return { hits: 0, lookups: 0, rate: 0 };
  }
}

/**
 * Confirm-or-miss for one tool call of a compiled run. Only a matching
 * first-wave lookup of the warmed program may observe the value. A mismatch
 * isolates the guess; the agent runs the real path.
 */
export async function takeWarm(
  state: WrapState,
  program: StretchProgram,
  input: Record<string, unknown>,
  tool: string,
  args: Record<string, unknown>,
): Promise<WarmTake> {
  try {
    const s = storeOf(state);
    const wave = firstWaveReads(program, input);
    const inWave = wave.some((w) => w.tool === tool && eq(w.args, args));
    if (inWave) {
      const ps = programStats(s, program.id);
      ps.lookups++;
      s.stats.lookups++;
    }
    if (!watchWarmEnabled()) return { hit: false };
    const entry = findEntry(s.entries, program.id, tool, args);
    if (!entry || entry.discarded) return { hit: false };
    const out = await entry.promise;
    if (entry.discarded || !out.ok) return { hit: false };
    if (inWave) {
      const ps = programStats(s, program.id);
      ps.hits++;
      s.stats.hits++;
    }
    return { hit: true, value: out.value };
  } catch {
    return { hit: false };
  }
}

/**
 * Registry wrapper: first-wave reads of this program join an in-flight warm
 * (or take a completed one). Everything else goes to the real registry.
 * Fail-open: a warm miss or error executes for real.
 */
export function withWarmLookup(
  state: WrapState,
  program: StretchProgram,
  input: Record<string, unknown>,
  registry: ToolRegistry,
): ToolRegistry {
  return {
    ...(registry.has ? { has: (name: string) => registry.has!(name) } : {}),
    execute: async (name, args, ctx) => {
      try {
        const taken = await takeWarm(state, program, input, name, args);
        if (taken.hit) return taken.value;
      } catch {
        /* fail-open to real execute */
      }
      return registry.execute(name, args, ctx);
    },
  };
}

/**
 * Start first-wave read-only work of the next likely compiled program.
 * Never awaits the tools — the caller (`runCompiled`) proceeds so warming
 * overlaps the current stretch. Never starts a mutating tool or the whole
 * next stretch.
 *
 * Returns a handle when work was started; null on kill-switch, mutating,
 * nothing to guess, or any throw (fail-open).
 */
export function watchWarm(
  state: WrapState,
  current: StretchProgram,
  hint: WarmHint = {},
): WarmHandle | null {
  try {
    if (!watchWarmEnabled()) return null;
    if (!isProgramReadOnly(current)) {
      discardWarm(state);
      return null;
    }
    const s = storeOf(state);
    const runner = s.runner;
    if (!runner) return null;
    const live = runner.live() ?? [];
    if (!live.length) return null;
    noteFollow(s, current.id);
    const currentInput = hint.input && typeof hint.input === "object" ? hint.input : {};
    const picked = pickNext(s, live, current, currentInput, hint);
    if (!picked) return null;
    const { program, input } = picked;
    const wave = firstWaveReads(program, input);
    if (!wave.length) return null;
    if (sameWarm(s.entries, program.id, wave)) {
      return { programId: program.id, input, tools: wave.map((w) => w.tool), startedAt: performance.now() };
    }
    const startedAt = performance.now();
    const tools: string[] = [];
    for (const w of wave) {
      if (isMutating(w.tool) || !isReadName(w.tool) || isBarrierName(w.tool)) {
        continue;
      }
      tools.push(w.tool);
      const entry: Entry = {
        programId: program.id,
        tool: w.tool,
        args: w.args,
        discarded: false,
        promise: Promise.resolve()
          .then(() => {
            if (isMutating(w.tool) || !isReadName(w.tool)) {
              s.stats.mutatingExecutes++;
              return { ok: false as const };
            }
            return runner.execute(w.tool, w.args).then(
              (value) => ({ ok: true as const, value }),
              () => ({ ok: false as const }),
            );
          })
          .then(
            (out) => out,
            () => ({ ok: false as const }),
          ),
      };
      s.entries.push(entry);
    }
    trimEntries(s);
    if (!tools.length) return null;
    return { programId: program.id, input, tools, startedAt };
  } catch {
    return null;
  }
}
