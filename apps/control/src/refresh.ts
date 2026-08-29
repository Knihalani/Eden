import type { IslandCaller, StretchProgram, StretchTrace, ToolRegistry } from "@eden/ir";
import { compileTraces } from "@eden/compile";
import { shadowProgram } from "@eden/shadow";
import type { Store } from "./store";

/**
 * Control-plane drift refresh. Site canary writes workshop drafts; the desk
 * a person actually Approves is this store's candidate list. Same human gate:
 * this module never writes `state = "live"`.
 */

export const REFRESH_ID_PREFIX = "rc:";

export const REFRESH_WAITING_COPY =
  "The outside world renamed a field. A replacement is waiting. The live tool is unchanged until you Approve.";

export function refreshCandidateId(toolId: string): string {
  return `${REFRESH_ID_PREFIX}${toolId}`;
}

export function isRefreshCandidate(id: string): boolean {
  return id.startsWith(REFRESH_ID_PREFIX);
}

const WINDOW_MS = 24 * 60 * 60_000;
const THRESHOLD = 2;

function deoptCount(store: Store, toolId: string, windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  return store.receiptsFor(toolId).filter((row) => {
    if (row.created_at < cutoff) return false;
    if (row.ok !== 0) return false;
    if (!row.payload) return false;
    try {
      const extra = JSON.parse(row.payload) as { early?: unknown; outcome?: unknown; deoptReason?: unknown };
      if (extra.early === true) return false;
      return extra.outcome === "deopt" || typeof extra.deoptReason === "string";
    } catch {
      return false;
    }
  }).length;
}

function sameStretch(live: StretchProgram, next: StretchProgram): boolean {
  const a = live.sequence ?? [];
  const b = next.sequence ?? [];
  if (!a.length || !b.length) return false;
  if (a.length !== b.length) return false;
  return a.every((name, i) => name === b[i]);
}

export type RefreshCtx = {
  store: Store;
  registry?: ToolRegistry;
  island?: IslandCaller;
  sandboxFor?: (t: StretchTrace) => ToolRegistry;
};

export type RefreshOutcome = "queued" | "below-threshold" | "pending" | "no-live" | "refused" | "inconclusive";

/**
 * After a live run deopts, try to queue a replacement candidate. Fire-and-forget
 * from the wrap-run path — a throw here must not change the deopt response.
 */
export async function maybeQueueRefresh(ctx: RefreshCtx, toolId: string): Promise<RefreshOutcome> {
  const live = ctx.store.tool(toolId);
  if (!live || live.state !== "live") return "no-live";
  if (ctx.store.candidate(refreshCandidateId(toolId))) return "pending";
  if (deoptCount(ctx.store, toolId, WINDOW_MS) < THRESHOLD) return "below-threshold";

  const traces = ctx.store.traces();
  if (traces.length < 3) return "refused";

  let compiled: { programs: StretchProgram[] };
  try {
    compiled = compileTraces(traces);
  } catch {
    return "refused";
  }
  const program = compiled.programs.find((p) => sameStretch(live.program, p)) ?? compiled.programs[0];
  if (!program) return "refused";

  const sandbox = ctx.sandboxFor;
  const registry = ctx.registry ?? { has: () => false, execute: async () => undefined };
  let verdict: { verdict: string; reasons?: string[]; manifest?: StretchProgram["manifest"] };
  try {
    verdict = await shadowProgram(program, traces, {
      registry,
      ...(sandbox ? { registryFor: sandbox } : {}),
      ...(ctx.island ? { island: ctx.island } : {}),
      allowSideEffects: Boolean(sandbox),
    });
  } catch {
    return "inconclusive";
  }
  if (verdict.verdict !== "PASS") return verdict.verdict === "INCONCLUSIVE" ? "inconclusive" : "refused";

  // Keep the live tool's id so Approve replaces in place (prev stack), never a
  // second On tool. The candidate row id is rc:<live> so compile's clear cannot
  // confuse it with a first-mine candidate.
  const shipped: StretchProgram = {
    ...program,
    id: live.id,
    name: live.name,
    description: REFRESH_WAITING_COPY,
    ...(verdict.manifest ? { manifest: verdict.manifest } : {}),
  };
  ctx.store.putCandidate({
    id: refreshCandidateId(toolId),
    sequence: shipped.sequence ?? [],
    program: shipped,
    refusal: null,
    verdict: "PASS",
    manifest: shipped.manifest ?? null,
    created_at: Date.now(),
  });
  return "queued";
}
