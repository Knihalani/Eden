/**
 * I1's pair checker (D471, trial `pushCheck`, off by default; docs/research/i1-checker.md): a small cross-encoder
 * that scores each (request, item) pair of the push's pool for "about the same person, thing and date as the request,
 * and bears on it", distilled from a strong teacher's labels on the lab's near-miss pairs. The engine only calls an
 * injected scorer: the lab wires a CPU sidecar (`packages/sim/lab/i1/sidecar.py`); no server wires one, so the
 * servers refuse the switch (`NEEDS_DEP`). Not a paid model call: a local scorer with bounded input (at most
 * `READER_POOL_CAP` items of cached, redacted text and the redacted request), bounded by `pushCheckWaitMs`, failing
 * open to the default's candidates on a timeout, an error or an answer of the wrong length.
 */
import type { Scope } from "@eden/protocol";

/** One pool item as the checker reads it: what the cache holds (redacted at store, D10). */
export interface CheckPair {
  id: string;
  title: string;
  text: string;
}

export interface PairChecker {
  /** One score in [0, 1] per item, in order (the chance the item is about the request's own person, thing and date). */
  score(scope: Scope, request: string, items: readonly CheckPair[], signal: AbortSignal): Promise<readonly number[]>;
}

/**
 * The scores by item id, or null (fail open) when the checker errs, is aborted, misses `waitMs`, or answers a list of
 * the wrong length or with a value outside [0, 1].
 */
export async function checkPool(
  checker: PairChecker,
  scope: Scope,
  request: string,
  items: readonly CheckPair[],
  waitMs: number,
): Promise<Map<string, number> | null> {
  if (items.length === 0) return new Map();
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((done) => {
    timer = setTimeout(() => {
      ctl.abort();
      done(null);
    }, waitMs);
  });
  try {
    const got = await Promise.race([checker.score(scope, request, items, ctl.signal).catch(() => null), late]);
    if (!got || got.length !== items.length || got.some((v) => !(v >= 0 && v <= 1))) return null;
    return new Map(items.map((it, i) => [it.id, got[i]!]));
  } finally {
    clearTimeout(timer);
  }
}
