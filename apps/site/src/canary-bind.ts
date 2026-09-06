import { compileTraces } from "@eden/compile";
import type { IslandCaller, StretchProgram, StretchTrace, ToolRegistry } from "@eden/ir";
import { replayRegistry, shadowProgram } from "@eden/shadow";
import type { CompileTracesFn, MaybeRecompileInput, ShadowProgramFn } from "./canary";

/**
 * Production compile + shadow wiring for the drift canary.
 *
 * cluster.ts (and any other ingest path) must pass these deps into
 * `maybeRecompileWorkspace`. The canary library itself stays injectable so
 * tests can still stub; omitting these on the live path is the `no-compiler`
 * hole Wave 6.2 closes.
 *
 * Shadow replays against the recorded tape (`replayRegistry`), never the live
 * world — the same sandbox control uses for candidates. FAIL / INCONCLUSIVE
 * still queue nothing; that filter lives in canary.ts.
 */

const EMPTY_REGISTRY: ToolRegistry = {
  has: () => false,
  execute: async () => undefined,
};

function asEvent(raw: unknown): StretchTrace["events"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name : "";
  if (!name) return null;
  const args = rec.args && typeof rec.args === "object" && !Array.isArray(rec.args) ? (rec.args as Record<string, unknown>) : {};
  return {
    name,
    args,
    ok: rec.ok !== false,
    ...(rec.result !== undefined ? { result: rec.result } : {}),
    ...(typeof rec.duration_ms === "number" && Number.isFinite(rec.duration_ms) ? { duration_ms: rec.duration_ms } : {}),
    ...(rec.skipped === true ? { skipped: true } : {}),
  };
}

/** Coerce whatever gather produced into StretchTrace so compile/shadow never see a hole. */
export function asCanaryTraces(raw: unknown[]): StretchTrace[] {
  return raw.map((item, i) => {
    const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const events = Array.isArray(rec.events) ? rec.events.map(asEvent).filter((e): e is NonNullable<typeof e> => e != null) : [];
    const input = rec.input && typeof rec.input === "object" && !Array.isArray(rec.input) ? (rec.input as Record<string, unknown>) : {};
    return {
      id: typeof rec.id === "string" && rec.id ? rec.id : `canary-${i}`,
      events,
      input,
      output: rec.output,
      llmCalls: Number.isFinite(Number(rec.llmCalls)) ? Number(rec.llmCalls) : 0,
      duration_ms: Number.isFinite(Number(rec.duration_ms)) ? Number(rec.duration_ms) : 0,
      cost_cents: Number.isFinite(Number(rec.cost_cents)) ? Number(rec.cost_cents) : 0,
      ...(typeof rec.prompt_tokens === "number" ? { prompt_tokens: rec.prompt_tokens } : {}),
      ...(typeof rec.completion_tokens === "number" ? { completion_tokens: rec.completion_tokens } : {}),
      ...(typeof rec.cached_tokens === "number" ? { cached_tokens: rec.cached_tokens } : {}),
      ...(rec.complete === true ? { complete: true } : {}),
      ...(Array.isArray(rec.skipped) ? { skipped: rec.skipped.filter((n): n is string => typeof n === "string") } : {}),
    };
  });
}

export const compileTracesForCanary: CompileTracesFn = (traces) => compileTraces(asCanaryTraces(traces));

export const shadowProgramForCanary: ShadowProgramFn = async (program, traces, opts) => {
  const held = asCanaryTraces(traces);
  const registry = (opts.registry as ToolRegistry | undefined) ?? EMPTY_REGISTRY;
  return shadowProgram(program as StretchProgram, held, {
    registry,
    registryFor: (t) => replayRegistry(registry, t),
    ...(opts.island !== undefined ? { island: opts.island as IslandCaller } : {}),
    // Tape is the sandbox: replay never hits the live world. Writes that cannot
    // be answered from the recording stay unvalidatable, not live mutations.
    allowSideEffects: true,
  });
};

export function canaryWorkspaceDeps(): Omit<MaybeRecompileInput, "workspace_id" | "tool_id"> {
  return {
    compileTracesFn: compileTracesForCanary,
    shadowProgramFn: shadowProgramForCanary,
  };
}
