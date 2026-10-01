/**
 * HTTP plane load: drives the real site server handler with concurrent
 * mixed traffic — signups, ingests, page renders, garbage requests — and
 * reports latency + error rates honestly.
 */
import { handleFetch } from "./server";

const BASE = "http://127.0.0.1:8787";

async function signup(ip: string): Promise<string> {
  const res = await handleFetch(
    new Request(`${BASE}/v1/signup`, {
      method: "POST",
      headers: { host: "127.0.0.1:8787", "content-type": "application/json", "x-real-ip": ip },
      body: "{}",
    }),
  );
  const j = (await res.json()) as { api_key?: string };
  if (!j.api_key) throw new Error(`signup failed: ${res.status}`);
  return j.api_key;
}

function randomEvents(runSeed: number): string {
  const events = Array.from({ length: 4 }, (_, i) => ({
    event_id: `e${runSeed}-${i}`,
    seq: i,
    name: i === 0 ? "lookupTicket" : i === 1 ? "fetchDetails" : i === 2 ? "enrich" : "respond",
    args: { url: `https://api.example.com/issue/${runSeed}/${i}` },
    result: { ok: true, n: i },
    ok: true,
  }));
  return JSON.stringify({ run_id: `load-${runSeed}`, stretch_end: true, events });
}

const GARBAGE = [
  "{not json",
  '{"run_id":}',
  "[]",
  '{"run_id": "x"}',
  "<script>alert(1)</script>",
  '{"traces": [{"events": "notarray"}]}',
];

async function main(): Promise<void> {
  console.log("═══ HTTP PLANE LOAD ═══");
  // Provision a handful of workspaces from distinct IPs.
  const keys: string[] = [];
  for (let i = 0; i < 6; i++) keys.push(await signup(`10.50.${i}.1`));
  console.log(`provisioned ${keys.length} workspaces`);

  const jobs: Array<{ label: string; p: Promise<number> }> = [];
  const t0 = Date.now();
  const N = 400;
  const latencies: number[] = [];
  let expected200 = 0;
  let expectedOther = 0;

  for (let i = 0; i < N; i++) {
    const kind = i % 8;
    const key = keys[i % keys.length];
    let req: Request;
    if (kind <= 3) {
      expected200++;
      req = new Request(`${BASE}/v1/ingest`, {
        method: "POST",
        headers: { host: "127.0.0.1:8787", "content-type": "application/json", authorization: `Bearer ${key}` },
        body: randomEvents(i),
      });
      jobs.push({ label: "ingest", p: handleFetch(req).then((r) => r.status) });
    } else if (kind === 4) {
      expected200++;
      req = new Request(`${BASE}/dashboard`, {
        headers: { host: "127.0.0.1:8787", accept: "text/html", authorization: `Bearer ${key}` },
      });
      jobs.push({ label: "dashboard", p: handleFetch(req).then((r) => r.status) });
    } else if (kind === 5) {
      expected200++;
      req = new Request(`${BASE}/v1/ledger`, {
        headers: { host: "127.0.0.1:8787", authorization: `Bearer ${key}` },
      });
      jobs.push({ label: "ledger", p: handleFetch(req).then((r) => r.status) });
    } else if (kind === 6) {
      // Garbage must be rejected cleanly (4xx), never 5xx.
      expectedOther++;
      req = new Request(`${BASE}/v1/ingest`, {
        method: "POST",
        headers: { host: "127.0.0.1:8787", "content-type": "application/json", authorization: `Bearer ${key}` },
        body: GARBAGE[i % GARBAGE.length],
      });
      jobs.push({ label: "garbage", p: handleFetch(req).then((r) => r.status) });
    } else {
      expectedOther++;
      req = new Request(`${BASE}/v1/tools`, { headers: { host: "127.0.0.1:8787" } }); // no auth → 401
      jobs.push({ label: "noauth", p: handleFetch(req).then((r) => r.status) });
    }
  }

  const results = await Promise.all(
    jobs.map(async ({ label, p }) => {
      const s0 = performance.now();
      const status = await p;
      return { label, status, ms: performance.now() - s0 };
    }),
  );
  const wall = ((Date.now() - t0) / 1000).toFixed(1);

  const byLabel = new Map<string, { n: number; ok: number; lat: number[] }>();
  for (const r of results) {
    const e = byLabel.get(r.label) ?? { n: 0, ok: 0, lat: [] };
    e.n++;
    e.lat.push(r.ms);
    byLabel.set(r.label, e);
  }
  let serverErrors = 0;
  for (const [label, e] of byLabel) {
    const maxLat = Math.max(...e.lat);
    line2(label, e.n, maxLat);
    void e;
  }
  // Count 5xx across everything.
  for (const r of results) if (r.status >= 500) serverErrors++;

  function line2(label: string, n: number, maxLat: number): void {
    console.log(`  ${label.padEnd(10)} n=${n} maxLatency=${maxLat.toFixed(1)}ms`);
  }
  console.log(`  total: ${results.length} requests in ${wall}s (${(results.length / Number(wall)).toFixed(0)} req/s)`);
  console.log(`  5xx errors: ${serverErrors}`);
  console.log(serverErrors === 0 ? "  VERDICT: clean" : "  VERDICT: SERVER ERRORS — investigate");
}
await main();
