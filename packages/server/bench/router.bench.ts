/**
 * The multi-process router's gate (D163): events per second the whole server sustains with observe p99 at or under a
 * fixed target, for one process (main.ts with EDEN_PROCESSES=1; unset is the core count since D178), the router over
 * one child (the hop's cost alone) and the router over N children. D163 made N > 1 the default only at >= 1.5x on 4
 * cores; D172 decided it on repetitions: the median of the per-repetition ratios at least 1.5x, the lowest 1.2x.
 *
 * Each server runs in its own process tree, never in this one: this process is only the load generator (it competes
 * for the same cores, as any co-located client would; the figure is a lower bound on a box with a separate client).
 * The load is closed-loop: C concurrent clients, each sending `/v1/events?waitMs=${WAIT}` for its own users in turn, so
 * a request returns when its slow path has (the work an event costs, not only the fast path). Users are many (USERS)
 * and spread over tenants; every server holds the same static source of DOCS generated documents, so each slow path
 * searches and scores. That source is an in-process `StaticSource` index, not a network source: its search is a large
 * share of each event's CPU, so the figure says how the router spreads that work, and moves when StaticSource does.
 * C steps up (1, 2, 3, 4, 6, ...) until p99 passes twice the target; the arm's figure is the best throughput among
 * steps within the target. No model (OPENROUTER_* removed), no network.
 *
 * Noise (D172): one run of this bench has landed on both sides of 1.5x on a shared box (1.32 to 3.70), since a server
 * process can sit in a slow or a fast mode for a whole arm and one step past p99 drops a level. So each arm runs REPS
 * times (at least 3), the arms alternate (the order rotates every repetition, so drift in box load falls on each arm
 * alike), steps last 5 s by default, and the result reports every arm's median, min and max, each repetition's ratio
 * (router over N against the single process of the same repetition), their median and the lowest.
 *
 * The router reads each body once to find its user (`userOf`); the hop is measured on its own at the end: `userOf`
 * on a typical event body and on a 1 MB `/v1/sources/items` body.
 *
 *   bun packages/server/bench/router.bench.ts [children=4] [secondsPerStep=5] [p99TargetMs=100] [waitMs=0] [reps=3]
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { startRouter, userOf } from "../src/router";

const MAIN = join(import.meta.dir, "../src/main.ts");
const USERS = 400;
const TENANTS = 8;
const DOCS = 400;
/** Concurrent clients per step: doubling with a step between, so the best step within the target is not too coarse. */
const LADDER = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];
const key = (t: number) => `bench-tenant-${t}-key-0123456789`;

// `--serve-router N`: the router arm's server process (the router in its own process, children under it).
if (process.argv[2] === "--serve-router") {
  const n = Number(process.argv[3]);
  // The children's output is dropped: their own listening lines must not be taken for the router's.
  const router = await startRouter({ config: { ...loadConfig(), port: 0, processes: n }, onOutput: () => {} });
  console.log(`eden router listening on http://127.0.0.1:${router.port}`);
  process.on("SIGTERM", () => void router.stop().then(() => process.exit(0)));
} else {
  await main();
}

async function main() {
  const args = process.argv.slice(2);
  const N = Number(args[0] ?? 4);
  const SECONDS = Number(args[1] ?? 5);
  const TARGET = Number(args[2] ?? 100);
  const WAIT = Number(args[3] ?? 0);
  const REPS = Math.max(1, Math.floor(Number(args[4] ?? 3)));
  const dir = mkdtempSync(join(tmpdir(), "eden-router-bench-"));
  const words = (
    "renewal budget launch contract invoice roadmap hiring security audit migration pricing deadline " +
    "outage review onboarding forecast vendor quarterly incident proposal"
  ).split(" ");
  const people = ["Dana Lee", "Raj Patel", "Mia Chen", "Omar Haddad", "Lena Novak", "Tom Ruiz", "Ava King", "Ben Ito"];
  const orgs = ["Globex", "Initech", "Umbrella", "Hooli", "Stark", "Wayne", "Acme", "Soylent"];
  const pick = <T>(xs: T[], i: number) => xs[i % xs.length]!;
  const docs = Array.from({ length: DOCS }, (_, i) => ({
    ref: `d${i}`,
    title: `${pick(orgs, i)} ${pick(words, i * 7)} ${i}`,
    text:
      `${pick(people, i * 3)} says the ${pick(orgs, i)} ${pick(words, i * 7)} moves to ${1 + (i % 28)} March; ` +
      `${pick(people, i * 5 + 1)} owns the ${pick(words, i * 11 + 3)} and wants a ${pick(words, i * 13)} first. `.repeat(
        3,
      ),
  }));
  const sourcesFile = join(dir, "sources.json");
  writeFileSync(sourcesFile, JSON.stringify({ sources: [{ id: "crm", description: "deals and notes", docs }] }));

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("OPENROUTER_") && !k.startsWith("EDEN_")) env[k] = v;
  }
  Object.assign(env, {
    EDEN_HOME: dir,
    EDEN_SOURCES_FILE: sourcesFile,
    EDEN_API_KEYS: Array.from({ length: TENANTS }, (_, t) => `t${t}:${key(t)}`).join(","),
    // The rate limit is not what is measured.
    EDEN_TENANT_RPS: "1000000",
    EDEN_TENANT_BURST: "1000000",
    PORT: "0",
    // The single arm is one process: unset, main.ts would start the router over the core count (D178). The router
    // arms set their own N (`--serve-router`), and their children ignore it (EDEN_ROUTER_CHILD).
    EDEN_PROCESSES: "1",
  });

  const bodies = Array.from({ length: USERS }, (_, u) => (turn: number) => {
    const i = u * 31 + turn;
    return JSON.stringify({
      userId: `user-${u}`,
      sessionId: `s-${u}`,
      kind: "user_message",
      text: `Can you check the ${pick(orgs, i)} ${pick(words, i * 7)} with ${pick(people, i * 3)} before ${pick(words, i)}?`,
    });
  });

  interface Step {
    clients: number;
    eventsPerSec: number;
    p50: number;
    p99: number;
    errors: number;
  }

  async function step(base: string, clients: number): Promise<Step> {
    const lat: number[] = [];
    let errors = 0;
    const stopAt = performance.now() + SECONDS * 1_000;
    const turns = new Array<number>(USERS).fill(0);
    let next = 0;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: clients }, async () => {
        while (performance.now() < stopAt) {
          const u = next++ % USERS;
          const body = bodies[u]!(turns[u]!++);
          const s = performance.now();
          const res = await fetch(`${base}/v1/events?waitMs=${WAIT}`, {
            method: "POST",
            headers: { authorization: `Bearer ${key(u % TENANTS)}`, "content-type": "application/json" },
            body,
          });
          await res.arrayBuffer();
          if (res.status !== 200) errors++;
          lat.push(performance.now() - s);
        }
      }),
    );
    const secs = (performance.now() - t0) / 1_000;
    lat.sort((x, y) => x - y);
    const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? NaN;
    return { clients, eventsPerSec: lat.length / secs, p50: q(0.5), p99: q(0.99), errors };
  }

  async function arm(name: string, cmd: string[], who: "partner" | "router") {
    const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "inherit" });
    const reader = proc.stdout.getReader();
    let text = "";
    let port = 0;
    while (!port) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`${name}: server exited before listening`);
      text += new TextDecoder().decode(value);
      // The arm's own line: the load must go where the arm says (a child's line once sent it past the router).
      const m = new RegExp(`eden ${who} listening on http://[^:]+:(\\d+)`).exec(text);
      if (m) port = Number(m[1]);
    }
    void (async () => {
      while (!(await reader.read()).done);
    })();
    const base = `http://127.0.0.1:${port}`;
    // Warm every user once (session, cache, JIT) before measuring.
    await Promise.all(
      Array.from({ length: 16 }, async (_, c) => {
        for (let u = c; u < USERS; u += 16) {
          await (
            await fetch(`${base}/v1/events?waitMs=${WAIT}`, {
              method: "POST",
              headers: { authorization: `Bearer ${key(u % TENANTS)}` },
              body: bodies[u]!(1_000),
            })
          ).arrayBuffer();
        }
      }),
    );
    const steps: Step[] = [];
    for (const c of LADDER) {
      const r = await step(base, c);
      steps.push(r);
      console.error(
        `  ${name} C=${c}: ${r.eventsPerSec.toFixed(0)} ev/s, p50 ${r.p50.toFixed(1)} ms, p99 ${r.p99.toFixed(1)} ms` +
          (r.errors ? `, ${r.errors} errors` : ""),
      );
      if (r.p99 > TARGET * 2) break;
    }
    proc.kill("SIGTERM");
    await proc.exited;
    const within = steps.filter((s) => s.p99 <= TARGET && s.errors === 0);
    const best = within.reduce<Step | null>((b, s) => (!b || s.eventsPerSec > b.eventsPerSec ? s : b), null);
    return { name, best, steps };
  }

  const source = `an in-process StaticSource of ${DOCS} generated docs (no network source)`;
  console.error(
    `router bench: ${N} children, ${SECONDS} s per step, p99 target ${TARGET} ms, ${USERS} users, ${REPS} ` +
      `repetitions per arm, alternating; source: ${source}`,
  );
  if (REPS < 3) console.error(`  note: D172 decides on at least 3 repetitions per arm; this run has ${REPS}`);
  const specs = [
    { name: "single", cmd: [process.execPath, MAIN], who: "partner" as const },
    { name: "router×1", cmd: [process.execPath, import.meta.path, "--serve-router", "1"], who: "router" as const },
    {
      name: `router×${N}`,
      cmd: [process.execPath, import.meta.path, "--serve-router", String(N)],
      who: "router" as const,
    },
  ];
  // runs[a][r]: arm a's best events/s in repetition r (0 when no step met the target).
  const runs: number[][] = specs.map(() => []);
  for (let r = 0; r < REPS; r++) {
    for (let k = 0; k < specs.length; k++) {
      const a = (k + r) % specs.length; // rotate the order: each arm runs first, second and third in turn
      const spec = specs[a]!;
      console.error(`repetition ${r + 1}/${REPS}, ${spec.name}:`);
      const res = await arm(spec.name, spec.cmd, spec.who);
      runs[a]![r] = res.best?.eventsPerSec ?? 0;
    }
  }

  // The parse hop on its own: a typical event body, and a 1 MB items body.
  const enc = new TextEncoder();
  const small = enc.encode(bodies[0]!(0));
  const items = Array.from({ length: 500 }, (_, i) => ({ ref: `r${i}`, title: `t${i}`, text: "x".repeat(2_000) }));
  const large = enc.encode(JSON.stringify({ userId: "user-1", sourceId: "crm", items }));
  const time = (body: Uint8Array, reps: number) => {
    for (let i = 0; i < Math.min(reps, 100); i++) userOf(body);
    const t = performance.now();
    for (let i = 0; i < reps; i++) userOf(body);
    return ((performance.now() - t) * 1_000) / reps;
  };
  const parse = {
    eventBytes: small.byteLength,
    eventUs: +time(small, 50_000).toFixed(2),
    itemsBytes: large.byteLength,
    itemsUs: +time(large, 50).toFixed(0),
  };

  const median = (xs: number[]) => {
    const s = [...xs].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const round2 = (x: number) => +x.toFixed(2);
  // Paired by repetition: each ratio divides by the single process measured in the same repetition.
  const ratios = runs[2]!.map((m, r) => (runs[0]![r]! > 0 ? m / runs[0]![r]! : 0));
  const hopRatios = runs[1]!.map((h, r) => (runs[0]![r]! > 0 ? h / runs[0]![r]! : 0));
  const medianRatio = round2(median(ratios));
  const lowestRatio = round2(Math.min(...ratios));
  const result = {
    children: N,
    p99TargetMs: TARGET,
    secondsPerStep: SECONDS,
    users: USERS,
    repetitions: REPS,
    source,
    arms: specs.map((spec, a) => ({
      name: spec.name,
      eventsPerSec: runs[a]!.map((x) => +x.toFixed(0)),
      median: +median(runs[a]!).toFixed(0),
      min: +Math.min(...runs[a]!).toFixed(0),
      max: +Math.max(...runs[a]!).toFixed(0),
    })),
    ratios: ratios.map(round2),
    medianRatio,
    lowestRatio,
    hopRatios: hopRatios.map(round2),
    medianHopRatio: round2(median(hopRatios)),
    // D172's bar for making N > 1 the default; one run is evidence for the decision, never the decision itself.
    meetsD172: REPS >= 3 && medianRatio >= 1.5 && lowestRatio >= 1.2,
    parseHop: parse,
  };
  console.log(JSON.stringify(result, null, 2));
  rmSync(dir, { recursive: true, force: true });
}
