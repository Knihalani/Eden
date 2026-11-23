/**
 * A10 measurement: eden-local's startup time, RSS floor (idle and at 3,000 items), and
 * p50/p95 of /v1/events and /v1/ask. Run: `bun scripts/local-perf.ts` (needs bun on PATH;
 * spawns `packages/server/src/main.ts` itself).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const token = randomBytes(32).toString("hex");
const home = mkdtempSync(join(tmpdir(), "eden-perf-")); // 0700, unique: no prepositioned path
const userSourcesFile = join(home, "user-sources.json");
// State-dir env the operator may have exported must not redirect the benchmark (EDEN_LOCAL_STATE_DIR
// wins over EDEN_HOME in localConfig): scrub both, then point EDEN_HOME at the scratch dir.
const env = {
  ...process.env,
  EDEN_LOCAL_STATE_DIR: undefined,
  EDEN_PERSIST: undefined,
  EDEN_LOCAL: "1",
  EDEN_LOCAL_TOKEN: token,
  EDEN_HOME: home,
  EDEN_USER_SOURCES_FILE: userSourcesFile,
};
writeFileSync(
  userSourcesFile,
  JSON.stringify({ users: { "local/u": [{ kind: "static", id: "docs", description: "d", docs: [] }] } }),
);

async function boot() {
  const t0 = performance.now();
  const child = Bun.spawn([process.execPath, "packages/server/src/main.ts"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  let port = 0;
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("eden-local exited: " + buf);
    buf += dec.decode(value);
    const m = /EDEN_LOCAL_READY (\d+)/.exec(buf);
    if (m) {
      port = Number(m[1]);
      break;
    }
  }
  const startupMs = performance.now() - t0;
  return { child, port, startupMs };
}

const rssMb = (pid: number) =>
  Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/)![1]) / 1024;

const post = (port: number, path: string, body: unknown, qs = "") =>
  fetch(`http://127.0.0.1:${port}${path}${qs}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const scope = { tenantId: "local", userId: "u", sessionId: "s" };
const item = (i: number) => ({
  ref: `doc-${i}`,
  title: `doc ${i}`,
  text: `report ${i}: priya moved the review to Tuesday ${i % 28}, budget ${1000 + i} usd. ` + "filler ".repeat(40),
  updatedAt: 1_700_000_000 + i,
});

async function timed(port: number, path: string, body: unknown, n: number) {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const r = await post(port, path, body);
    times.push(performance.now() - t);
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  }
  times.sort((a, b) => a - b);
  const p = (x: number) => times[Math.min(times.length - 1, Math.floor(times.length * x))]!.toFixed(1);
  return `p50=${p(0.5)}ms p95=${p(0.95)}ms`;
}

const first = await boot();
await post(first.port, "/v1/sources", scope); // first sighting: sources configured before items are pushed
await new Promise((r) => setTimeout(r, 300));
const idleRss = rssMb(first.child.pid);
console.log(`startup=${first.startupMs.toFixed(0)}ms idleRSS=${idleRss.toFixed(0)}MB`);

// 3,000 items over one source, 30 pushes of 100.
for (let b = 0; b < 30; b++) {
  const r = await post(first.port, "/v1/sources/items", {
    ...scope,
    sourceId: "docs",
    items: Array.from({ length: 100 }, (_, i) => item(b * 100 + i)),
  });
  if (!r.ok) throw new Error("items: " + (await r.text()));
}
await new Promise((r) => setTimeout(r, 300));
const loadedRss = rssMb(first.child.pid);
console.log(
  `loaded(3000 items) RSS=${loadedRss.toFixed(0)}MB delta=${(loadedRss - idleRss).toFixed(0)}MB perItem=${(((loadedRss - idleRss) * 1024) / 3000).toFixed(1)}KB`,
);

// Latency: an event (observe) and an ask, 60 each.
console.log(
  `/v1/events ${await timed(first.port, "/v1/events", { ...scope, at: Date.now(), kind: "user_message", text: "when is priya's review?" }, 60)}`,
);
console.log(`/v1/ask    ${await timed(first.port, "/v1/ask", { ...scope, question: "when is priya's review?" }, 60)}`);

// Races (A10d): pushes, reads and asks interleaved across ~2s; a 5xx or hang here is a bug.
const statuses = new Map<number, number>();
const tally = (r: Response) => {
  if (!r.ok) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
};
const deadline = Date.now() + 2000;
const workers = [
  (async () => {
    for (let i = 0; Date.now() < deadline; i++) {
      const r = await post(first.port, "/v1/sources/items", {
        ...scope,
        sourceId: "docs",
        items: [item(3000 + (i % 50))],
      });
      tally(r);
    }
  })(),
  (async () => {
    while (Date.now() < deadline) {
      const r = await post(first.port, "/v1/ask", { ...scope, question: "when is priya's review?" });
      tally(r);
    }
  })(),
  (async () => {
    while (Date.now() < deadline) {
      const r = await post(first.port, "/v1/events", { ...scope, at: Date.now(), kind: "user_message", text: "ping" });
      tally(r);
    }
  })(),
  (async () => {
    while (Date.now() < deadline) {
      const r = await post(first.port, "/v1/sources", scope);
      tally(r);
    }
  })(),
];
await Promise.all(workers);
console.log(
  `mixed-load (push+ask+events+sources, 2s): ${JSON.stringify(Object.fromEntries(statuses))} non-200 by status`,
);

await first.child.kill();

// Restart against the same EDEN_HOME: persistence path, no re-read.
const second = await boot();
console.log(`restart=${second.startupMs.toFixed(0)}ms RSS=${rssMb(second.child.pid).toFixed(0)}MB`);
await second.child.kill();
