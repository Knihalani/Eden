import { eq, mayServe, type StretchProgram } from "@eden/ir";
import { isSafeToWarm } from "./fleet";
import { extractInput } from "./steer";
import type { WrapState } from "./wrap-tools";

export type SpeculateHint = {
  input?: Record<string, unknown>;
  program?: StretchProgram | string;
  lastTool?: string;
  lastArgs?: Record<string, unknown>;
};

export type SpeculateHandle = {
  programId: string;
};

export type SpeculateTake = { hit: true; value: unknown } | { hit: false };

type SpeculateRunner = {
  live: () => StretchProgram[];
  run: (program: StretchProgram, input: Record<string, unknown>) => Promise<unknown>;
};

type Slot = {
  program: StretchProgram;
  input: Record<string, unknown>;
  discarded: boolean;
  promise: Promise<{ ok: true; value: unknown } | { ok: false }>;
};

type Store = {
  runner?: SpeculateRunner;
  slot: Slot | null;
  lastServed: { programId: string; input: Record<string, unknown> } | null;
};

const stores = new WeakMap<WrapState, Store>();

function storeOf(state: WrapState): Store {
  let s = stores.get(state);
  if (!s) {
    s = { slot: null, lastServed: null };
    stores.set(state, s);
  }
  return s;
}

export function speculateEnabled(): boolean {
  try {
    return process.env.EDEN_SPECULATE !== "0";
  } catch {
    return false;
  }
}

export function bindSpeculateRunner(state: WrapState, runner: SpeculateRunner): void {
  try {
    storeOf(state).runner = runner;
  } catch {
  }
}

export function discardSpeculation(state: WrapState): void {
  try {
    const s = storeOf(state);
    if (s.slot) s.slot.discarded = true;
    s.slot = null;
  } catch {
  }
}

export function markStretchServed(
  state: WrapState,
  program: StretchProgram,
  input: Record<string, unknown>,
): void {
  try {
    storeOf(state).lastServed = { programId: program.id, input };
  } catch {
  }
}

export function turnBoundary(state: WrapState, hint: SpeculateHint = {}): SpeculateHandle | null {
  try {
    if (!speculateEnabled()) return null;
    const s = storeOf(state);
    const runner = s.runner;
    if (!runner) return null;
    const live = runner.live() ?? [];
    if (!live.length) return null;
    const raw = hint.input && typeof hint.input === "object" ? hint.input : hint.lastArgs && typeof hint.lastArgs === "object" ? hint.lastArgs : undefined;
    const named =
      hint.program == null
        ? undefined
        : typeof hint.program === "string"
          ? live.find((p) => p.id === hint.program || p.name === hint.program)
          : hint.program;
    const candidates = named
      ? [named]
      : live.filter((p) => isSafeToWarm(p)).sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0));
    let program: StretchProgram | undefined;
    let input: Record<string, unknown> | undefined;
    for (const cand of candidates) {
      if (!isSafeToWarm(cand)) continue;
      if (!named && hint.lastTool && (cand.sequence ?? []).includes(hint.lastTool)) continue;
      const next = raw ? extractInput(cand, raw) : {};
      if (!Object.keys(next).length) continue;
      if (!mayServe(cand, next)) continue;
      program = cand;
      input = next;
      break;
    }
    if (!program || !input) return null;
    if (s.lastServed && s.lastServed.programId === program.id && eq(s.lastServed.input, input)) return null;
    const cur = s.slot;
    if (cur && !cur.discarded && cur.program.id === program.id && eq(cur.input, input)) {
      return { programId: program.id };
    }
    if (cur) cur.discarded = true;
    const slot: Slot = {
      program,
      input,
      discarded: false,
      promise: Promise.resolve()
        .then(() => runner.run(program, input))
        .then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        ),
    };
    s.slot = slot;
    return { programId: program.id };
  } catch {
    return null;
  }
}

export async function takeSpeculation(
  state: WrapState,
  program: StretchProgram,
  input: Record<string, unknown>,
): Promise<SpeculateTake> {
  try {
    if (!speculateEnabled()) {
      discardSpeculation(state);
      return { hit: false };
    }
    const s = storeOf(state);
    const slot = s.slot;
    if (!slot || slot.discarded) return { hit: false };
    if (slot.program.id !== program.id || !eq(slot.input, input)) {
      slot.discarded = true;
      s.slot = null;
      return { hit: false };
    }
    const out = await slot.promise;
    if (slot.discarded || s.slot !== slot) return { hit: false };
    s.slot = null;
    if (!out.ok) return { hit: false };
    s.lastServed = { programId: program.id, input };
    return { hit: true, value: out.value };
  } catch {
    discardSpeculation(state);
    return { hit: false };
  }
}
