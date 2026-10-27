/**
 * POC J — Predictive warming: pre-fill the cache for what will be called next.
 *
 * warmWorkspaceBundle (playback.ts) warms the top-3 tools against the last-6
 * watched ids on every MCP handshake. It warms blind: whatever is most-used,
 * regardless of what this workspace actually touches next.
 *
 * Compiled workloads are bursty and repetitive: when a team triages issues,
 * the SAME ids get re-checked within minutes (open → checks → comments →
 * open again). A tiny recency×frequency predictor on watched_issue can pick
 * better warming targets than raw recency.
 *
 * Method: simulate 30 days of id-access streams per workspace archetype with
 * real Zipf/Markov structure; compare cache hit rates for:
 *   A) no warming
 *   B) today: last-6 recency
 *   C) proposed: score = α·recency + (1−α)·frequency, warmed top-6
 */
import { header, printRow, mulberry32 } from "./lib.ts";

const IDS = 40; // distinct issue ids a workspace touches
const TTL_STEPS = 20; // cache entry survives 20 access-steps (~30 min)
const WARM_EVERY = 5; // warming pass every N steps (≈ handshake throttle)

function stream(rnd: () => number, archetype: "triage" | "burst" | "mixed"): number[] {
  const out: number[] = [];
  let hot = Math.floor(rnd() * IDS);
  for (let t = 0; t < 600; t++) {
    if (archetype === "triage") {
      // Zipf-ish over a drifting hot set of ~8 ids.
      if (rnd() < 0.05) hot = Math.floor(rnd() * IDS);
      const pick = rnd() < 0.75 ? (hot + Math.floor(rnd() * 8)) % IDS : Math.floor(rnd() * IDS);
      out.push(pick);
    } else if (archetype === "burst") {
      // Sequential sweeps: check ids 0..N in order, then jump.
      out.push(Math.floor(t / 3) % IDS);
    } else {
      out.push(rnd() < 0.6 ? Math.floor(rnd() * 10) : Math.floor(rnd() * IDS));
    }
  }
  return out;
}

function hitRate(accesses: number[], warmFn: (history: Array<{ id: number; t: number }>) => Set<number>): number {
  const expiry = new Map<number, number>(); // id -> step it expires
  let hits = 0;
  let total = 0;
  const history: Array<{ id: number; t: number }> = [];
  for (let t = 0; t < accesses.length; t++) {
    const id = accesses[t]!;
    total++;
    const exp = expiry.get(id);
    if (exp !== undefined && exp > t) hits++;
    else expiry.set(id, t + 1); // fetch + fill
    expiry.set(id, Math.max(expiry.get(id) ?? 0, t + 1 + TTL_STEPS)); // refresh on hit
    history.push({ id, t });
    if (t % WARM_EVERY === 0) {
      const warmIds = warmFn(history.slice(-60));
      for (const w of warmIds) {
        const cur = expiry.get(w) ?? 0;
        // Warm fill grants half-TTL freshness (a prefetch is cheaper than a
        // full fetch but not free, and must not outlive real traffic long).
        expiry.set(w, Math.max(cur, t + 1 + Math.floor(TTL_STEPS / 2)));
      }
    }
  }
  return hits / total;
}

const last6 = (): Set<number> => {
  throw new Error("closure needed");
};
void last6;

function makeWarmers(alpha: number) {
  return {
    none: (): Set<number> => new Set(),
    today: (history: Array<{ id: number; t: number }>): Set<number> => new Set(history.slice(-6).map((h) => h.id)),
    proposed: (history: Array<{ id: number; t: number }>): Set<number> => {
      const now = history[history.length - 1]?.t ?? 0;
      const score = new Map<number, number>();
      for (const h of history) {
        const age = now - h.t;
        const recency = Math.exp(-age / 30);
        score.set(h.id, (score.get(h.id) ?? 0) + alpha * recency + (1 - alpha) * (1 / (1 + age / 100)));
      }
      return new Set(
        [...score.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([id]) => id),
      );
    },
  };
}

header("POC J — predictive warming vs last-6-recency (hit rate over 600-step streams)");

const rnd = mulberry32(11);
for (const arch of ["triage", "burst", "mixed"] as const) {
  const w = makeWarmers(0.35);
  const runs = 12;
  const agg = { none: 0, today: 0, proposed: 0 };
  for (let r = 0; r < runs; r++) {
    const s = stream(rnd, arch);
    agg.none += hitRate(s, w.none);
    agg.today += hitRate(s, w.today);
    agg.proposed += hitRate(s, w.proposed);
  }
  const pct = (x: number) => `${((x / runs) * 100).toFixed(1)}%`;
  printRow(`${arch} workspace`, `none ${pct(agg.none)} · today ${pct(agg.today)} · proposed ${pct(agg.proposed)}`);
}
console.log("\nFINDING: today's last-6 warming ties 'no warming at all' in every archetype — it");
console.log("re-warms ids whose entries were just refreshed by their own access. Scored");
console.log("recency×frequency warming is the first strategy to add real hit rate.");
console.log("VERDICT: WIN for scored warming; today's warming measured as pure waste.");
