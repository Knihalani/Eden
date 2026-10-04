/**
 * The arms in CI test files, grouped so each file runs in about a minute locally (CI shards by file, so the slowest
 * file sets the floor). Each group has a gate file (`<group>.gate.test.ts`) and a reference file
 * (`<group>.reference.test.ts`).
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
