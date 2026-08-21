import { hashTrace } from "./hash";
import { isUsableOutput } from "./signals";
import type { StretchTrace } from "./types";

export type Grounding = {
  grounded: boolean | "unknown";
  cached: boolean;
};

const CACHE = new Map<string, boolean | "unknown">();
const CACHE_MAX = 256;

/**
 * Selective offline grounding when `t.output` is absent.
 *
 * Not an LLM-as-judge on every run. Structural: a usable output plus no
 * failed/absent evidence is grounded; missing output without evidence is
 * unknown; empty-but-ok is not grounded. Optional LLM is env-gated and
 * cached on the trace hash.
 */
export function judgeGrounding(t: StretchTrace): Grounding {
  const key = hashTrace(t);
  const hit = CACHE.get(key);
  if (hit !== undefined) return { grounded: hit, cached: true };

  let grounded: boolean | "unknown";
  if (isUsableOutput(t.output)) {
    const failed = t.evidence?.failed.length ?? 0;
    const absent = t.evidence?.absent.length ?? 0;
    grounded = failed === 0 && absent === 0;
  } else if (t.output === undefined) {
    const present = t.evidence?.present.length ?? 0;
    const lastOk = [...t.events].reverse().find((e) => e.ok && !e.skipped);
    grounded = present > 0 && isUsableOutput(lastOk?.result) ? "unknown" : false;
  } else {
    grounded = false;
  }

  if (CACHE.size >= CACHE_MAX) {
    const first = CACHE.keys().next().value;
    if (first !== undefined) CACHE.delete(first);
  }
  CACHE.set(key, grounded);
  return { grounded, cached: false };
}

export function usableTrace(t: Pick<StretchTrace, "complete" | "output">): boolean {
  return t.complete === true && isUsableOutput(t.output);
}
