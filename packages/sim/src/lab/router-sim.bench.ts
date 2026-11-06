#!/usr/bin/env bun
/**
 * The router gate (D163, D172) on simulated connectors (audit 2026-11-06 F23). `packages/server/bench/router.bench.ts`
 * serves one in-process 400-doc StaticSource, so each event's cost there is mostly that index's search and none of
 * what real users bring: per-user connectors with network latency, rate limits and errors, background sync listing
 * them, and per-user synced caches. Here every server process serves the shipped wiring (`buildPartner`: the
 * default, D112, sync on, no model key) over per-(tenant, user) `SimSource` connectors (REALISTIC, or a market
 * latency profile over it) at time scale 1, i.e. with the profiles' assumed latency in real time. Events are
 * generated sessions over each user's own world, so searches find what that world holds.
 *
 * Arms, as in router.bench.ts: this file as one server process (`--child`, what EDEN_PROCESSES unset runs), the real
 * router (`startRouter`) over 1 child (the hop) and over N children, each child this file again (`entry`). The load is
 * closed-loop: C clients each send `/v1/events?waitMs=W` for the next user in turn; C steps up the ladder until p99
 * passes twice the target; an arm's figure is its best events/s among steps within the target with no errors. Each
 * arm runs REPS times, the arm order rotating every repetition (D172), and the summary is D172's: per-repetition
 * ratios, their median and lowest. Every server process writes its memory and connector counters to a file each
 * second, so the result reports RSS per process at start (worlds built, no users) and at the end of the arm, and how
 * many source calls (searches, sync lists) were made. Before the ladder each arm settles under light load (`--settle`,
 * default 75 s) past the sync timer's first tick (once a minute), so the steps see users whose sources are synced.
 *
 * The worlds are built in every process (sim data, not Eden's): read memory as end minus start.
 *
 *   bun packages/sim/src/lab/router-sim.bench.ts [--children 4] [--seconds 5] [--p99 100] [--wait 0] [--reps 3]
 *     [--profile realistic|direct|hosted] [--users 400] [--worlds 8] [--time 1] [--settle 75]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmGate } from "@eden/redact";
import { buildPartner, createHandler, loadConfig, startGatePool } from "@eden/server";
import { startRouter } from "../../../server/src/router";
import { worldOf } from "../server";
import { buildWorld } from "../world";
import { gateSummary, median, profilesNamed, simResolver, userEventBodies, worldIndexes } from "./router-sim";

const TENANTS = 8;
const LADDER = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];
const key = (t: number) => `bench-tenant-${t}-key-0123456789`;

// What every server process reads (not EDEN_*: the router passes the whole environment to its children).
const SIM = {
  profile: process.env.ROUTER_SIM_PROFILE ?? "realistic",
  worlds: Number(process.env.ROUTER_SIM_WORLDS ?? 8),
  time: Number(process.env.ROUTER_SIM_TIME ?? 1),
  statsDir: process.env.ROUTER_SIM_STATS ?? "",
};

if (process.argv[2] === "--child" || process.env.EDEN_ROUTER_CHILD) {
  await serveChild();
} else if (process.argv[2] === "--serve-router") {
  const n = Number(process.argv[3]);
  const router = await startRouter({
    config: { ...loadConfig(), port: 0, processes: n },
    entry: import.meta.path,
    onOutput: () => {},
  });
  console.log(`eden router listening on http://127.0.0.1:${router.port}`);
  process.on("SIGTERM", () => void router.stop().then(() => process.exit(0)));
} else {
  await main();
}

/** One server process: main.ts's `serve` with the sources swapped for per-user SimSources. */
async function serveChild(): Promise<void> {
  const config = loadConfig();
  const t0 = performance.now();
  const { resolver, users } = simResolver(worldIndexes(SIM.worlds), profilesNamed(SIM.profile), SIM.time);
  const worldsMs = Math.round(performance.now() - t0);
  const gatePool = await startGatePool(config.gateWorkers);
  const partner = buildPartner({
    gatePool,
    sources: resolver,
    sourceMapPath: config.sourceMapPath,
    queryPlanner: config.queryPlanner,
    processes: config.child?.count ?? 1,
  });
  warmGate();
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    maxRequestBodySize: config.maxBodyBytes,
    fetch: createHandler(partner, config),
  });
  const writeStats = () => {
    if (!SIM.statsDir) return;
    const totals = { calls: 0, lists: 0, errors: 0, limited: 0, aborted: 0 };
    for (const list of users.values()) {
      for (const s of list) {
        totals.calls += s.stats.calls;
        totals.lists += s.stats.lists;
        totals.errors += s.stats.errors;
        totals.limited += s.stats.limited;
        totals.aborted += s.stats.aborted;
      }
    }
    const mem = process.memoryUsage();
    const line = { pid: process.pid, worldsMs, users: users.size, rss: mem.rss, heapUsed: mem.heapUsed, ...totals };
    writeFileSync(join(SIM.statsDir, `${process.pid}.json`), JSON.stringify(line));
  };
  writeStats();
  setInterval(writeStats, 1_000);
  console.log(`eden partner listening on http://${server.hostname}:${server.port} (sim ${SIM.profile})`);
  if (config.child) {
    process.send?.({ edenListening: server.port });
    process.on("disconnect", () => process.exit(0));
  }
}

interface Step {
  clients: number;
  eventsPerSec: number;
  p50: number;
  p99: number;
  errors: number;
}

interface ProcStats {
  pid: number;
  users: number;
  rss: number;
  calls: number;
  lists: number;
  errors: number;
  limited: number;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1]! : fallback;
  };
  const N = Number(opt("children", "4"));
  const SECONDS = Number(opt("seconds", "5"));
  const TARGET = Number(opt("p99", "100"));
  const WAIT = Number(opt("wait", "0"));
  const REPS = Math.max(1, Math.floor(Number(opt("reps", "3"))));
  const USERS = Number(opt("users", "400"));
  const profile = opt("profile", "realistic");
  const worlds = Number(opt("worlds", "8"));
  const time = Number(opt("time", "1"));
  const SETTLE = Number(opt("settle", "75"));
  profilesNamed(profile); // fail here on a bad name, not in every child
  const dir = mkdtempSync(join(tmpdir(), "eden-router-sim-"));

  // Each user's events, generated before any clock starts (the generator's work, not the server's).
  const built = new Map<number, ReturnType<typeof buildWorld>>();
  const bodies = Array.from({ length: USERS }, (_, u) => {
    const userId = `user-${u}`;
    const w = worldOf(userId, worlds);
    let world = built.get(w);
    if (!world) built.set(w, (world = buildWorld({ seed: 1_000 + w })));
    return userEventBodies(world, userId, 3, 7_919 + u);
  });
  const events = bodies.reduce((n, b) => n + b.length, 0);

  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("OPENROUTER_") && !k.startsWith("EDEN_") && !k.startsWith("ROUTER_SIM_")) {
      baseEnv[k] = v;
    }
  }
  Object.assign(baseEnv, {
    EDEN_API_KEYS: Array.from({ length: TENANTS }, (_, t) => `t${t}:${key(t)}`).join(","),
    EDEN_TENANT_RPS: "1000000", // the rate limit is not what is measured
    EDEN_TENANT_BURST: "1000000",
    PORT: "0",
    ROUTER_SIM_PROFILE: profile,
    ROUTER_SIM_WORLDS: String(worlds),
    ROUTER_SIM_TIME: String(time),
  });

  const turns = new Array<number>(USERS).fill(0);
  const nextBody = (u: number) => {
    const list = bodies[u]!;
    return list[turns[u]!++ % list.length]!;
  };
  const send = (base: string, u: number) =>
    fetch(`${base}/v1/events?waitMs=${WAIT}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key(u % TENANTS)}`, "content-type": "application/json" },
      body: nextBody(u),
    });

  async function step(base: string, clients: number, seconds = SECONDS): Promise<Step> {
    const lat: number[] = [];
    let errors = 0;
    const stopAt = performance.now() + seconds * 1_000;
    let next = 0;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: clients }, async () => {
        while (performance.now() < stopAt) {
          const u = next++ % USERS;
          const s = performance.now();
          const res = await send(base, u);
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

  const readStats = (statsDir: string): ProcStats[] =>
    readdirSync(statsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(statsDir, f), "utf8")) as ProcStats);

  async function arm(name: string, cmd: string[], who: "partner" | "router", tag: string) {
    const home = join(dir, tag);
    const statsDir = join(home, "stats");
    mkdirSync(statsDir, { recursive: true });
    const env = { ...baseEnv, EDEN_HOME: home, ROUTER_SIM_STATS: statsDir };
    const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "inherit" });
    const reader = proc.stdout.getReader();
    let text = "";
    let port = 0;
    while (!port) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`${name}: server exited before listening`);
      text += new TextDecoder().decode(value);
      const m = new RegExp(`eden ${who} listening on http://[^:]+:(\\d+)`).exec(text);
      if (m) port = Number(m[1]);
    }
    void (async () => {
      while (!(await reader.read()).done);
    })();
    const base = `http://127.0.0.1:${port}`;
    const start = readStats(statsDir);
    // Warm every user once (session, connectors, cache, JIT) before measuring.
    await Promise.all(
      Array.from({ length: 16 }, async (_, c) => {
        for (let u = c; u < USERS; u += 16) await (await send(base, u)).arrayBuffer();
      }),
    );
    // The sync timer ticks once a minute (`startSync`): settle under light load past the first tick or two, so the
    // ladder measures the steady state, with users' sources backfilled and polled, not a server's first minute.
    if (SETTLE > 0) {
      const settled = await step(base, 4, SETTLE);
      const lists = readStats(statsDir).reduce((n, s) => n + s.lists, 0);
      console.error(
        `  ${name} settle ${SETTLE} s at C=4: ${settled.eventsPerSec.toFixed(0)} ev/s, ${lists} sync lists`,
      );
    }
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
    await Bun.sleep(1_100); // one more stats write after the last step
    const end = readStats(statsDir);
    proc.kill("SIGTERM");
    await proc.exited;
    const within = steps.filter((s) => s.p99 <= TARGET && s.errors === 0);
    const best = within.reduce<Step | null>((b, s) => (!b || s.eventsPerSec > b.eventsPerSec ? s : b), null);
    const mb = (b: number) => +(b / 1_048_576).toFixed(1);
    const startRss = new Map(start.map((s) => [s.pid, s.rss]));
    const procs = end.map((s) => ({
      users: s.users,
      rssStartMb: mb(startRss.get(s.pid) ?? NaN),
      rssEndMb: mb(s.rss),
      calls: s.calls,
      lists: s.lists,
      errors: s.errors,
      limited: s.limited,
    }));
    return { best, procs };
  }

  const source = `per-user SimSource connectors, ${profile} profile, time scale ${time}, ${worlds} worlds, sync on`;
  console.error(
    `router-sim bench: ${N} children, ${SECONDS} s per step, p99 target ${TARGET} ms, ${USERS} users ` +
      `(${events} events), ${REPS} repetitions per arm, alternating; source: ${source}`,
  );
  const specs = [
    { name: "single", cmd: [process.execPath, import.meta.path, "--child"], who: "partner" as const },
    { name: "router×1", cmd: [process.execPath, import.meta.path, "--serve-router", "1"], who: "router" as const },
    {
      name: `router×${N}`,
      cmd: [process.execPath, import.meta.path, "--serve-router", String(N)],
      who: "router" as const,
    },
  ];
  const runs: number[][] = specs.map(() => []);
  const procs: Array<Array<Awaited<ReturnType<typeof arm>>["procs"]>> = specs.map(() => []);
  for (let r = 0; r < REPS; r++) {
    for (let k = 0; k < specs.length; k++) {
      const a = (k + r) % specs.length;
      const spec = specs[a]!;
      console.error(`repetition ${r + 1}/${REPS}, ${spec.name}:`);
      const res = await arm(spec.name, spec.cmd, spec.who, `r${r}-a${a}`);
      runs[a]![r] = res.best?.eventsPerSec ?? 0;
      procs[a]![r] = res.procs;
    }
  }

  const result = {
    children: N,
    p99TargetMs: TARGET,
    secondsPerStep: SECONDS,
    waitMs: WAIT,
    settleSeconds: SETTLE,
    users: USERS,
    repetitions: REPS,
    source,
    arms: specs.map((spec, a) => {
      const all = procs[a]!.flat();
      return {
        name: spec.name,
        eventsPerSec: runs[a]!.map((x) => +x.toFixed(0)),
        median: +median(runs[a]!).toFixed(0),
        min: +Math.min(...runs[a]!).toFixed(0),
        max: +Math.max(...runs[a]!).toFixed(0),
        // Every server process of the arm (the children for a router arm), each repetition: memory and calls.
        processes: procs[a],
        medianRssEndMbPerProcess: +median(all.map((p) => p.rssEndMb)).toFixed(1),
        medianRssGrowthMbPerProcess: +median(all.map((p) => p.rssEndMb - p.rssStartMb)).toFixed(1),
      };
    }),
    ...gateSummary(runs),
  };
  console.log(JSON.stringify(result, null, 2));
  rmSync(dir, { recursive: true, force: true });
}
