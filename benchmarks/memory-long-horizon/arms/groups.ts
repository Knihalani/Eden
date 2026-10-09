/**
 * The arms in CI test files, grouped so each file runs in under a minute locally (CI shards by file, so the slowest
 * file sets the floor). Each group has a gate file (`<group>.gate.test.ts`) and a reference file
 * (`<group>.reference.test.ts`).
 *
 * CI runs every arm's `on` state, and `off` and `shadow` only for one cheap arm per group (`FLAG_SAMPLES`). The off
 * and shadow checks are generic (kit.ts `flagChecks`), so one arm per group shows a flag regression: since P0.8
 * every arm that drives a delivery point passes them, and the arms that drive none fail `ran`. `run.ts`, which every
 * slice runs on its arms, checks every state of every arm against `arms.json`.
 */
export const GROUPS: Record<string, readonly string[]> = {
  floor: ["cross-session", "worktree", "reload-stale", "rewind", "negation", "numbered-list", "poison"],
  "floor-store": ["spawn-writers", "secrets", "migrate", "fail-open"],
  place: ["scoped", "cascade", "single-package", "fan-out", "r5-unit-rows"],
  delivery: ["nonhuman", "repeat", "compaction", "resume", "subagent", "first-touch", "residual", "shadow", "continue"],
  "delivery-soak": ["budget", "re-eligibility"],
  policy: ["policy-guard", "guard-modes", "guard-dedup", "policy-recur", "intent-expiry"],
  facts: ["repo-facts", "citation", "gotcha", "stale-episode", "restate-learn", "continuation"],
  bench: ["cuebench-code", "policy-trigger", "extraction", "alias-batch", "scale-20k", "scale-1e6"],
};

/** Per group, the flagged arm whose `off` and `shadow` states CI runs: the cheapest. */
export const FLAG_SAMPLES: Record<string, string> = {
  floor: "reload-stale",
  "floor-store": "secrets",
  place: "fan-out",
  delivery: "first-touch",
  "delivery-soak": "re-eligibility",
  policy: "guard-dedup",
  facts: "gotcha",
  bench: "cuebench-code",
};

/** The flag states CI runs for an arm of a group, out of those `arms.json` records for it. */
export function ciStates<T extends string>(group: string, id: string, recorded: readonly T[]): T[] {
  return FLAG_SAMPLES[group] === id ? [...recorded] : recorded.filter((state) => state === "on");
}
