/**
 * The cluster router (D992) on one host: three machines (`main.ts`, one process each, persistence to a shared
 * S3-compatible store: `fakeS3`, in this process), the cluster router in this process, USERS users each holding a
 * static source's items. Measures:
 *
 * 1. latency per event, direct to the owning node against through the cluster router, at a fixed request rate;
 * 2. a node added (3 -> 4): buckets moved, users released, the rebalance's wall time;
 * 3. a node removed (4 -> 3, planned): the same;
 * 4. a node killed: time from the kill until the router routes around it (with the router's default probe timing),
 *    and its users' next requests.
 *
 *   bun packages/server/bench/cluster.bench.ts [users=300] [rate=100] [events=1000]
 *
 * One host: every process shares its cores, and the store is in memory with no network, so this measures the
 * router's hop and the protocol's own work, not a real network's latency (add a round trip per hop for that).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster } from "../src/cluster";
import { fakeS3 } from "../src/fixtures/fake-s3";

const args = process.argv.slice(2);
const USERS = Number(args[0] ?? 300);
const RATE = Number(args[1] ?? 100);
const EVENTS = Number(args[2] ?? 1_000);
const KEY = "k_bench_0123456789abcdef";
const CLUSTER_KEY = "cluster-key-0123456789abcdef";
const root = mkdtempSync(join(tmpdir(), "eden-cluster-bench-"));
const s3 = fakeS3("eden-frozen");
const procs: ReturnType<typeof Bun.spawn>[] = [];
const MAIN = join(import.meta.dir, "../src/main.ts");

const sources = join(root, "sources.json");
const docs = Array.from({ length: 200 }, (_, i) => ({
  ref: `d${i}`,
  title: `Account ${i} renewal`,
  text: `Account ${i}: Dana Lee wants ${i % 30}% off the renewal, decision by Friday; owner Priya Raman, region ${i % 7}`,
}));
writeFileSync(sources, JSON.stringify({ sources: [{ id: "crm", description: "deals", docs }] }));

async function machine(id: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("EDEN_")) env[k] = v;
  Object.assign(env, {
    PORT: "0",
    HOST: "127.0.0.1",
    EDEN_HOME: join(root, id),
    EDEN_API_KEYS: `bench:${KEY}`,
    EDEN_SOURCES_FILE: sources,
    EDEN_PROCESSES: "1",
    EDEN_PERSIST_KEY: "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0",
    EDEN_PERSIST_STORE: "s3://eden-frozen/frozen/",
    EDEN_S3_ENDPOINT: s3.url,
    EDEN_S3_ACCESS_KEY_ID: "bench",
    EDEN_S3_SECRET_ACCESS_KEY: "bench-secret-0123456789",
    EDEN_CLUSTER_KEY: CLUSTER_KEY,
    EDEN_CLUSTER_SIZE: "3",
    EDEN_TENANT_RPS: "1000000",
    EDEN_TENANT_BURST: "1000000",
  });
  const proc = Bun.spawn(["bun", MAIN], { env, stdout: "pipe", stderr: "inherit" });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${id} exited`);
    out += new TextDecoder().decode(value);
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    if (m) {
      reader.releaseLock();
      return { id, url: `http://127.0.0.1:${m[1]}`, proc };
    }
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100;
};

let session = 0;
async function send(base: string, userId: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      userId,
      sessionId: `s${session++}`,
      kind: "user_message",
      text: `Account ${userId.length} renewal with Dana Lee: what discount?`,
    }),
  });
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return performance.now() - t0;
}

/** EVENTS events at RATE per second, users in turn; `target` picks the URL per user. */
async function paced(target: (u: string) => string): Promise<{ p50: number; p99: number; max: number }> {
  const times: number[] = [];
  const t0 = performance.now();
  const inflight: Promise<void>[] = [];
  for (let i = 0; i < EVENTS; i++) {
    const due = t0 + (i * 1_000) / RATE;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    const u = `user-${i % USERS}`;
    inflight.push(send(target(u), u).then((ms) => void times.push(ms)));
  }
  await Promise.all(inflight);
  return { p50: pct(times, 0.5), p99: pct(times, 0.99), max: pct(times, 1) };
}

try {
  const nodes = await Promise.all(["a", "b", "c"].map(machine));
  const cluster = await startCluster({
    config: {
      port: 0,
      host: "127.0.0.1",
      keys: new Map([[KEY, "bench"]]),
      dev: false,
      cluster: { key: CLUSTER_KEY, size: 3 },
    },
    nodes: nodes.map(({ id, url }) => ({ id, url })),
    log: () => {},
  });
  const via = `http://127.0.0.1:${cluster.port}`;
  const { bucketOf } = await import("@eden/protocol");
  const ownerUrl = (u: string) => nodes.find((n) => n.id === cluster.owner(bucketOf("bench", u)))!.url;
  // Warm every user (their first event looks the source up and fills their cache).
  for (let i = 0; i < USERS; i += 50) {
    await Promise.all(Array.from({ length: Math.min(50, USERS - i) }, (_, j) => send(via, `user-${i + j}`)));
  }
  const direct = await paced(ownerUrl);
  const routed = await paced(() => via);
  const direct2 = await paced(ownerUrl);
  const routed2 = await paced(() => via);

  const d = await machine("d");
  const added = await cluster.setNodes([...nodes, d].map(({ id, url }) => ({ id, url })));
  nodes.push(d);
  const afterAdd = await paced(() => via);
  const removed = await cluster.setNodes(nodes.filter((n) => n.id !== "d").map(({ id, url }) => ({ id, url })));
  const afterRemove = await paced(() => via);

  // A node killed: the router's own timer (2 s probes, 3 failures) finds it.
  const b = nodes.find((n) => n.id === "b")!;
  const before = cluster.rebalances.length;
  const tKill = performance.now();
  b.proc.kill("SIGKILL");
  while (cluster.rebalances.length === before) await Bun.sleep(50);
  const detectMs = Math.round(performance.now() - tKill);
  const failover = cluster.rebalances.at(-1)!;
  const afterKill = await paced(() => via);

  console.log(
    JSON.stringify(
      {
        users: USERS,
        rate: RATE,
        events: EVENTS,
        latencyMs: { direct: [direct, direct2], throughRouter: [routed, routed2] },
        added,
        afterAdd,
        removed,
        afterRemove,
        killed: { detectMs, rebalance: failover, after: afterKill },
        storeObjects: s3.objects.size,
      },
      null,
      1,
    ),
  );
  await cluster.stop();
} finally {
  for (const p of procs) p.kill("SIGKILL");
  s3.stop();
  rmSync(root, { recursive: true, force: true });
}
