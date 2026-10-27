import { inCanary } from "@eden/ir";

/**
 * Canary programs serve only the hashed 10% bucket. Empty session is the
 * operator and sees canary. Missing rollout stays 100%. A bookkeeping throw
 * drops canary tools (fail-open to raw), never silently serves them at 100%.
 *
 * Lives in its own module so proxy/anthropic can call it without importing
 * wrap-tools (that cycle left `filterCanary` undefined at runtime).
 */
export function filterCanary<T extends { rollout?: "canary" | "live" }>(
  programs: T[],
  sessionId: string | undefined | null,
): T[] {
  try {
    const out: T[] = [];
    for (const p of programs) {
      try {
        if (p.rollout !== "canary" || inCanary(sessionId)) out.push(p);
      } catch {
        /* skip this program — fail-open to raw, never 100% canary */
      }
    }
    return out;
  } catch {
    return [];
  }
}
