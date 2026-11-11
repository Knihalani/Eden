#!/usr/bin/env bun
/**
 * A deploy check against a running Eden (one box or the cluster router; docs/DEPLOY.md §12): readiness, metrics,
 * and USERS users' events answered 200, each in a session of its own. Exits 1 on the first failure.
 *
 *   EDEN_API_KEY=<a tenant key> bun deploy/scripts/cluster-smoke.ts https://eden.example.com [users=30]
 *
 * Without EDEN_API_KEY it uses the local cluster's test key (deploy/compose/local-cluster).
 */
const base = (process.argv[2] ?? "http://127.0.0.1:18790").replace(/\/+$/, "");
const users = Number(process.argv[3] ?? 30);
const key = process.env.EDEN_API_KEY ?? "k_local_cluster_0123456789abcdef";
const run = Date.now().toString(36);

function fail(why: string): never {
  console.error(`smoke: FAIL ${why}`);
  process.exit(1);
}

for (let i = 0; i < 60; i++) {
  const ok = await fetch(`${base}/readyz`).then(
    (r) => r.ok,
    () => false,
  );
  if (ok) break;
  if (i === 59) fail("/readyz never answered 200");
  await Bun.sleep(1_000);
}
const ready = (await (await fetch(`${base}/readyz`)).json()) as Record<string, unknown>;
console.log(`smoke: ready ${JSON.stringify(ready)}`);

const times: number[] = [];
for (let u = 0; u < users; u++) {
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/events?waitMs=2000`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      userId: `smoke-${u}`,
      sessionId: `smoke-${run}-${u}`,
      kind: "user_message",
      text: "Globex renewal with Dana Lee: what discount?",
    }),
  });
  times.push(performance.now() - t0);
  if (res.status !== 200) fail(`event for smoke-${u}: HTTP ${res.status} ${await res.text()}`);
  await res.arrayBuffer();
}
times.sort((a, b) => a - b);
console.log(
  `smoke: ${users} events 200; p50 ${times[Math.floor(users / 2)]!.toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms`,
);

const metrics = await fetch(`${base}/metrics`).then(
  (r) => (r.ok ? r.text() : ""),
  () => "",
);
const held = /^eden_users_held (\S+)$/m.exec(metrics)?.[1];
const nodes = /^eden_cluster_nodes_up (\S+)$/m.exec(metrics)?.[1];
console.log(`smoke: metrics users held ${held ?? "(not served here)"}, cluster nodes up ${nodes ?? "(not a cluster)"}`);
console.log("smoke: OK");
