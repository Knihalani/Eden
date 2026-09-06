import type { StretchProgram } from "@eden/ir";
import { eq, isMutating, isReadName, mayServe } from "@eden/ir";
import { isProgramReadOnly } from "./fleet";
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
  input: Record<string, unknown>;
  startedAt: number;
};

export type SpeculateTake = { hit: true; value: unknown } | { hit: false };

type SpeculateRunner = {
  live: () => StretchProgram[];
  run: (program: StretchProgram, input: Record<string, unknown>) => Promise<unknown>;
};

type Slot = {
  program: StretchProgram;
  input: Record<string, unknown>;
  startedAt: number;
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
    /* fail-open: missing runner means turnBoundary is a no-op */
  }
}

function isSafeToSpeculate(program: StretchProgram): boolean {
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

function hintInput(hint: SpeculateHint): Record<string, unknown> | undefined {
  if (hint.input && typeof hint.input === "object") return hint.input;
  if (hint.lastArgs && typeof hint.lastArgs === "object") return hint.lastArgs;
  return undefined;
}

function pick(
  live: StretchProgram[],
  hint: SpeculateHint,
): { program: StretchProgram; input: Record<string, unknown> } | null {
  const raw = hintInput(hint);
  const named =
    hint.program == null
      ? undefined
      : typeof hint.program === "string"
        ? live.find((p) => p.id === hint.program || p.name === hint.program)
        : hint.program;
  const candidates = named
    ? [named]
    : live.filter((p) => isSafeToSpeculate(p)).sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0));
  for (const program of candidates) {
    if (!isSafeToSpeculate(program)) continue;
    // Auto wrap/proxy hints include lastTool. Starting that program again
    // would duplicate the stretch (fleet GET 2×, failsafe sibling +1). An
    // explicit `hint.program` is a next-stretch prediction and may start.
    if (!named && hint.lastTool && (program.sequence ?? []).includes(hint.lastTool)) continue;
    const input = raw ? extractInput(program, raw) : {};
    if (!Object.keys(input).length) continue;
    if (!mayServe(program, input)) continue;
    return { program, input };
  }
  return null;
}

function discardSlot(slot: Slot | null): void {
  if (!slot) return;
  slot.discarded = true;
}

export function discardSpeculation(state: WrapState): void {
  try {
    const s = storeOf(state);
    discardSlot(s.slot);
    s.slot = null;
  } catch {
    /* fail-open */
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
    /* fail-open */
  }
}

function sameStretch(
  a: { programId: string; input: Record<string, unknown> } | null,
  program: StretchProgram,
  input: Record<string, unknown>,
): boolean {
  return !!a && a.programId === program.id && eq(a.input, input);
}

/**
 * Start a read-only compiled stretch at the turn boundary. Never awaits the
 * run — the caller (wrap, or a fixture before think-time) returns immediately
 * so tool latency overlaps the model's think.
 *
 * Returns a handle when a run was started; null on kill-switch, mutating,
 * nothing to guess, or any throw (fail-open).
 */
export function turnBoundary(state: WrapState, hint: SpeculateHint = {}): SpeculateHandle | null {
  try {
    if (!speculateEnabled()) return null;
    const s = storeOf(state);
    const runner = s.runner;
    if (!runner) return null;
    const live = runner.live() ?? [];
    if (!live.length) return null;
    const picked = pick(live, hint);
    if (!picked) return null;
    const { program, input } = picked;
    if (sameStretch(s.lastServed, program, input)) return null;
    const cur = s.slot;
    if (cur && !cur.discarded && cur.program.id === program.id && eq(cur.input, input)) {
      return { programId: program.id, input, startedAt: cur.startedAt };
    }
    discardSlot(cur);
    const startedAt = performance.now();
    const slot: Slot = {
      program,
      input,
      startedAt,
      discarded: false,
      promise: Promise.resolve()
        .then(() => runner.run(program, input))
        .then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        ),
    };
    s.slot = slot;
    return { programId: program.id, input, startedAt };
  } catch {
    return null;
  }
}

/**
 * Confirm-or-discard. Only a matching head call may observe the speculated
 * value. A mismatch isolates the guess; the agent runs the real path.
 */
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
      discardSlot(slot);
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
