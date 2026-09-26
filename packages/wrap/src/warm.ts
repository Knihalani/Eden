import { eq, isBarrierName, isMutating, isReadName, mayServe, type StretchProgram } from "@eden/ir";
import { evalArgs } from "@eden/runtime";
import { isProgramReadOnly, isSafeToWarm } from "./fleet";
import { extractInput, namedProgram } from "./steer";
import type { WrapState } from "./wrap-tools";

export type WarmHint = {
  input?: Record<string, unknown>;
  program?: StretchProgram | string;
};

export type WarmHandle = {
  programId: string;
  tools: string[];
};

export type WarmTake = { hit: true; value: unknown } | { hit: false };

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
  lastServedId: string | null;
  follows: Map<string, Map<string, number>>;
};

const stores = new WeakMap<WrapState, Store>();
const MAX_ENTRIES = 64;

function storeOf(state: WrapState): Store {
  let s = stores.get(state);
  if (!s) {
    s = { entries: [], lastServedId: null, follows: new Map() };
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
  } catch {}
}

export function firstWaveReads(
  program: StretchProgram,
  input: Record<string, unknown>,
): Array<{ tool: string; args: Record<string, unknown> }> {
  const owned = new Set<string>();
  for (const s of program.steps ?? []) {
    if (s.kind === "loop") for (const id of s.body) owned.add(id);
    if (s.kind === "branch") {
      for (const id of s.then) owned.add(id);
      for (const id of s.else ?? []) owned.add(id);
      for (const c of s.cases ?? []) for (const id of c.steps) owned.add(id);
    }
  }
  const pending = (program.steps ?? []).filter((s) => !owned.has(s.id));
  const wave: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const scope = { input, results: new Map<string, unknown>() };
  for (const step of pending) {
    if (step.kind !== "tool") break;
    if (isMutating(step.tool) || isBarrierName(step.tool) || !(step.readOnly === true || isReadName(step.tool)) || !Object.values(step.args).every((b) => {
      let cur = b;
      while (cur.kind === "transform") cur = cur.of;
      return cur.kind !== "from";
    })) break;
    try {
      const args = evalArgs(step.args, scope);
      wave.push({ tool: step.tool, args });
    } catch {
      break;
    }
  }
  return wave;
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
  } catch {}
}

export function discardWarm(state: WrapState): void {
  try {
    const s = storeOf(state);
    for (const e of s.entries) e.discarded = true;
    s.entries = [];
  } catch {}
}

export async function takeWarm(
  state: WrapState,
  program: StretchProgram,
  tool: string,
  args: Record<string, unknown>,
): Promise<WarmTake> {
  try {
    const s = storeOf(state);
    if (!watchWarmEnabled()) return { hit: false };
    const entry = s.entries.findLast((e) => !e.discarded && e.programId === program.id && e.tool === tool && eq(e.args, args));
    if (!entry || entry.discarded) return { hit: false };
    const out = await entry.promise;
    if (entry.discarded || !out.ok) return { hit: false };
    return { hit: true, value: out.value };
  } catch {
    return { hit: false };
  }
}

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
    const prev = s.lastServedId;
    if (prev && prev !== current.id) {
      let row = s.follows.get(prev);
      if (!row) {
        row = new Map();
        s.follows.set(prev, row);
      }
      row.set(current.id, (row.get(current.id) ?? 0) + 1);
    }
    s.lastServedId = current.id;
    const currentInput = hint.input && typeof hint.input === "object" ? hint.input : {};
    const named = namedProgram(live, hint.program);
    const candidates = named
      ? named.id !== current.id && isSafeToWarm(named) ? [named] : []
      : live
          .filter((p) => p.id !== current.id && isSafeToWarm(p))
          .sort((a, b) => {
            const fa = s.follows.get(current.id)?.get(a.id) ?? 0;
            const fb = s.follows.get(current.id)?.get(b.id) ?? 0;
            if (fb !== fa) return fb - fa;
            return (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0);
          });
    let program: StretchProgram | undefined;
    let input: Record<string, unknown> | undefined;
    for (const cand of candidates) {
      const next = extractInput(cand, currentInput);
      if (!Object.keys(next).length) continue;
      if (!mayServe(cand, next)) continue;
      if (!firstWaveReads(cand, next).length) continue;
      program = cand;
      input = next;
      break;
    }
    if (!program || !input) return null;
    const wave = firstWaveReads(program, input);
    if (wave.every((w) => s.entries.findLast((e) => !e.discarded && e.programId === program.id && e.tool === w.tool && eq(e.args, w.args)))) {
      return { programId: program.id, tools: wave.map((w) => w.tool) };
    }
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
          .then(() => runner.execute(w.tool, w.args))
          .then(
            (value) => ({ ok: true as const, value }),
            () => ({ ok: false as const }),
          ),
      };
      s.entries.push(entry);
    }
    if (s.entries.length > MAX_ENTRIES) s.entries.splice(0, s.entries.length - MAX_ENTRIES / 2);
    if (!tools.length) return null;
    return { programId: program.id, tools };
  } catch {
    return null;
  }
}
