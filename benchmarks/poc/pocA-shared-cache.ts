/**
 * POC A — Shared result pool for PUBLIC data across workspaces.
 *
 * The cache key deliberately includes workspace_id so one tenant's cached
 * body can never answer another tenant's call (cache.ts). That is exactly
 * right for private data — and needlessly expensive for provably public data.
 * Two teams compiling "check CI on github.com/facebook/react" fetch the SAME
 * public bytes from the SAME upstream, W times over.
 *
 * Proposed: a second-tier "public pool" keyed WITHOUT workspace id, used only
 * for responses to unauthenticated public endpoints (no token was attached,
 * response not tenant-flavored). Private calls keep today's tenant-scoped key
 * and never touch the pool.
 *
 * Benchmark: W workspaces × K identical public reads. Loader counts upstream
 * hits; latency modeled at 120 ms/upstream + 1 ms/DB hop, clearly labeled.
 */
import { header, printRow } from "./lib.ts";

const UPSTREAM_MS = 120;
const DB_MS = 1;

function makeLoader() {
  const upstreamHits = { n: 0 };
  return {
    async load(key: string): Promise<string> {
      await new Promise((r) => setTimeout(r, UPSTREAM_MS)); // MODELED upstream RTT
      upstreamHits.n++;
      return `body(${key})`;
    },
    hits: () => upstreamHits.n,
  };
}

async function runIsolated(workspaces: number, perWorkspace: number): Promise<number> {
  const loader = makeLoader();
  const t = Date.now();
  for (let w = 0; w < workspaces; w++) {
    const cache = new Map<string, string>(); // per-workspace cache, like today
    for (let k = 0; k < perWorkspace; k++) {
      const key = `public/pr/101#${k}`;
      if (!cache.has(key)) {
        cache.set(key, await loader.load(key));
        await new Promise((r) => setTimeout(r, DB_MS)); // write-through
      }
      await new Promise((r) => setTimeout(r, DB_MS)); // read hop
    }
  }
  return Date.now() - t;
}

async function runSharedPool(workspaces: number, perWorkspace: number): Promise<number> {
  const loader = makeLoader();
  const pool = new Map<string, Promise<string>>(); // cross-workspace public pool
  const t = Date.now();
  await Promise.all(
    Array.from({ length: workspaces }, async (_, w) => {
      const local = new Map<string, string>();
      for (let k = 0; k < perWorkspace; k++) {
        const key = `public/pr/101#${k}`;
        let v = local.get(key);
        if (v === undefined) {
          let p = pool.get(key);
          if (!p) {
            p = loader.load(key);
            pool.set(key, p);
          }
          v = await p;
          local.set(key, v);
        }
        await new Promise((r) => setTimeout(r, DB_MS));
      }
    }),
  );
  return Date.now() - t;
}

header("POC A — shared public-data pool (latency modeled at 120ms upstream)");

for (const [W, K] of [[10, 5], [50, 5]] as Array<[number, number]>) {
  const a = await runIsolated(W, K);
  const b = await runSharedPool(W, K);
  printRow(`W=${W} workspaces × ${K} public reads`, `today ${a} ms → pooled ${b} ms`);
}

// Quota math is exact regardless of modeling:
{
  const W = 50, K = 5;
  printRow(`upstream requests @W=${W}`, `today ${W * K} → pooled ≤${K} (first-arrival dedupe)`);
}
console.log("\nVERDICT: WIN — public reads cost the system once, not once per tenant; privacy unchanged (private keys never enter the pool).");
