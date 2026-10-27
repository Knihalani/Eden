import { isUsableOutput } from "./signals";
import type { StretchTrace } from "./types";

export type Grounding = {
  grounded: boolean | "unknown";
  cached: boolean;
};

const MEMO = new WeakMap<StretchTrace, boolean | "unknown">();

/**
 * Selective offline grounding when `t.output` is absent.
 *
 * Not an LLM-as-judge on every run. Structural: a usable output plus no
 * failed/absent evidence is grounded; missing output without evidence is
 * unknown; empty-but-ok is not grounded. Cached on the trace object so a
 * flush does not re-hash the same events.
 */
export function judgeGrounding(t: StretchTrace): Grounding {
  const hit = MEMO.get(t);
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

  MEMO.set(t, grounded);
  return { grounded, cached: false };
}

export function usableTrace(t: Pick<StretchTrace, "complete" | "output">): boolean {
  return t.complete === true && isUsableOutput(t.output);
}
