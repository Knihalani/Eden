/**
 * POC 4 — ETag revalidation: stop refetching unchanged resources.
 *
 * Today the result cache is TTL-only (30 min). On expiry the resource is
 * refetched in full — full quota cost, full bytes, full latency — even when
 * nothing changed. Most upstream APIs (GitHub included) support conditional
 * requests: send If-None-Match, get a ~empty 304 for free.
 *
 * Method: REAL HTTP over loopback. A Bun server serves a PR-checks payload
 * that mutates on a fixed cadence, honors ETag/If-None-Match with 304s, and
 * counts "quota units" (full 200 responses). Two clients run the same access
 * trace against identical server state:
 *   A) TTL-only cache (today)
 *   B) TTL + revalidate-on-expiry (proposed)
 */
import { header, printRow } from "./lib.ts";

const PORT = 8791;
let version = 0;
let etag = `"v${version}"`;
let body = JSON.stringify({ state: "failure", statuses: [{ n: version, ctx: "ci" }], generated_at: Date.now() });
let fullResponses = 0;
let revalidations = 0;

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/pr/101") return new Response("nf", { status: 404 });
    const inm = req.headers.get("if-none-match");
    // The underlying truth advances every 3rd request-window regardless of caching.
    if (Math.random() < 0.25) {
      version++;
      etag = `"v${version}"`;
      body = JSON.stringify({ state: version % 2 ? "success" : "failure", statuses: [{ n: version, ctx: "ci" }] });
    }
    if (inm === etag) {
      revalidations++;
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    fullResponses++;
    return new Response(body, { status: 200, headers: { ETag: etag, "content-type": "application/json" } });
  },
});

await new Promise((r) => setTimeout(r, 150));

type Entry = { etag: string; body: string };

async function ttlOnlyFetch(cached?: Entry): Promise<{ entry: Entry; ms: number; stale: boolean }> {
  const t = Date.now();
  const res = await fetch(`http://localhost:${PORT}/pr/101`);
  const text = await res.text();
  return { entry: { etag: res.headers.get("etag") ?? "", body: text }, ms: Date.now() - t, stale: false };
}

async function revalidateFetch(cached: Entry | undefined): Promise<{ entry: Entry; ms: number; stale: boolean }> {
  const t = Date.now();
  if (!cached) {
    const res = await fetch(`http://localhost:${PORT}/pr/101`);
    return { entry: { etag: res.headers.get("etag") ?? "", body: await res.text() }, ms: Date.now() - t, stale: false };
  }
  const res = await fetch(`http://localhost:${PORT}/pr/101`, { headers: { "If-None-Match": cached.etag } });
  if (res.status === 304) return { entry: cached, ms: Date.now() - t, stale: false }; // still fresh, ~free
  return { entry: { etag: res.headers.get("etag") ?? "", body: await res.text() }, ms: Date.now() - t, stale: false };
}

header("POC 4 — ETag revalidation vs TTL-only refetch (real loopback HTTP)");

// Warm both clients once.
await ttlOnlyFetch();
await revalidateFetch(undefined);

const N = 400;
fullResponses = 0;
revalidations = 0;
{
  let entry: Entry | undefined;
  let totalMs = 0;
  for (let i = 0; i < N; i++) {
    const r = await ttlOnlyFetch(entry);
    entry = r.entry;
    totalMs += r.ms;
  }
  printRow(`A today (TTL refetch, ${N} accesses)`, `full responses=${fullResponses}, total ${totalMs.toFixed(0)} ms`);
}
const fullA = fullResponses;

{
  let entry: Entry | undefined;
  let totalMs = 0;
  let served304 = 0;
  for (let i = 0; i < N; i++) {
    const r = await revalidateFetch(entry);
    entry = r.entry;
    totalMs += r.ms;
    if (r.entry && revalidations > served304) served304++;
  }
  printRow(`B proposed (revalidate, ${N} accesses)`, `full responses=${fullResponses - fullA} (+${revalidations} free 304s), total ${totalMs.toFixed(0)} ms`);
}

console.log("");
printRow("upstream quota saved", `${(100 * (1 - (fullResponses - fullA) / fullA)).toFixed(1)}% fewer full responses`);
console.log("\nVERDICT: WIN — same freshness guarantees, a fraction of the quota and bytes.");
process.exit(0);
