#!/usr/bin/env bun
/**
 * Performance scenarios against the real server in its own process (server.ts), driven by simulated agents over
 * HTTP (load.ts). Prints one JSON report per scenario.
 *
 *   bun packages/sim/src/perf-cli.ts <scenario> [--profile realistic] [--model none|fake] [--gate-workers 0]
 *     [--tenant-rps 200]
 *
 * Scenarios:
 *   steady   production-like: 300 users at real pacing and real source latency for 90 s
 *   ramp     saturation: pacing compressed 10x, users doubling from 100 to 3,200, 20 s per step
 *   memory   server memory after warming 250, 500, 1,000 and 2,000 users (forced GC before each reading)
 *   soak     --minutes 10 with the server clock at 144x (10 minutes = a simulated day: TTLs, idle sessions,
 *            daily budgets)
 *   faults   300 users; Gmail down for 30 s, then Drive 5x slower for 30 s, then a CRM 429 storm for 30 s
 *   cold     server start-up, first request, first lookup for a new user against a warm one
 */
import { runLoad, type LoadOptions } from "./load";

const args = process.argv.slice(2);
const scenario = args[0] ?? "steady";
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const WORLDS = Number(arg("worlds", "20"));
const TENANTS = 10;

interface Server {
  base: string;
  startupMs: number;
  listenMs: number;
  stop(): void;
}

async function startServer(extra: string[]): Promise<Server> {
  const t0 = performance.now();
  // PROFILE=<dir> profiles the server process (written on /sim/exit) into that directory.
  const profile = process.env.PROFILE;
  const proc = Bun.spawn(
    [
      "bun",
      ...(profile ? ["--cpu-prof", `--cpu-prof-dir=${profile}`] : []),
      new URL("./server.ts", import.meta.url).pathname,
      "--worlds",
      String(WORLDS),
      "--tenants",
      String(TENANTS),
      "--profile",
      arg("profile", "realistic"),
      "--model",
      arg("model", "none"),
      "--gate-workers",
      arg("gate-workers", "0"),
      "--tenant-rps",
      arg("tenant-rps", "200"),
      "--source-map",
      arg("source-map", "file"),
      ...extra,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const reader = proc.stdout.getReader();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("server exited before listening");
    buf += new TextDecoder().decode(value);
  }
  const line = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as { listening: number; startupMs: number };
  return {
    base: `http://127.0.0.1:${line.listening}`,
    startupMs: line.startupMs,
    listenMs: Math.round(performance.now() - t0),
    stop: () => {
      void fetch(`http://127.0.0.1:${line.listening}/sim/exit`, { method: "POST" }).catch(() => {});
      setTimeout(() => proc.kill(), 3_000).unref();
    },
  };
}

const sim = async (base: string, path: string, body?: unknown) =>
  (await (
    await fetch(`${base}/sim/${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })
  ).json()) as Record<string, unknown>;

const load = (base: string, o: Partial<LoadOptions>) =>
  runLoad({
    baseUrl: base,
    users: 100,
    tenants: TENANTS,
    worlds: WORLDS,
    timeScale: 1,
    durationS: 30,
    waitMs: 0,
    askRate: 0.2,
    seed: 1,
    ...o,
  });

/** A load report without its per-window series (kept for scenarios that are about time). */
const brief = ({ windows: _w, ...rest }: Awaited<ReturnType<typeof runLoad>>) => rest;

async function steady() {
  const s = await startServer(["--time", "1"]);
  try {
    await sim(s.base, "reset");
    const report = await load(s.base, { users: 300, durationS: Number(arg("seconds", "90")), rampS: 10 });
    return { scenario: "steady", client: brief(report), server: await sim(s.base, "stats") };
  } finally {
    s.stop();
  }
}

async function ramp() {
  const s = await startServer(["--time", "0.1"]);
  const steps = [];
  try {
    let warm = 0;
    for (const users of [100, 200, 400, 800, 1_600, 3_200, 6_400]) {
      await sim(s.base, "reset");
      const report = await load(s.base, { users, timeScale: 0.1, durationS: 20, rampS: 2 });
      warm = Math.max(warm, users);
      const server = await sim(s.base, "stats");
      steps.push({ users, client: brief(report), server });
      const p99 = report.latency.observe?.p99 ?? 0;
      if (p99 > 2_000 || report.failedOpenRate > 0.05) break; // Past saturation: no point going further.
    }
    return {
      scenario: "ramp",
      note: "pacing and source latency compressed 10x: each user sends ~10x real traffic",
      steps,
    };
  } finally {
    s.stop();
  }
}

async function memory() {
  const s = await startServer(["--time", "0.02"]);
  try {
    const readings = [{ users: 0, ...(await sim(s.base, "gc")) }];
    let done = 0;
    for (const target of [250, 500, 1_000, 2_000]) {
      // Each new user runs three sessions quickly: their cache fills from real lookups.
      await load(s.base, {
        users: target - done,
        first: done,
        timeScale: 0.02,
        durationS: 600,
        rampS: 2,
        sessionsPerUser: 3,
        askRate: 0.3,
      });
      done = target;
      readings.push({ users: target, ...(await sim(s.base, "gc")) });
    }
    return { scenario: "memory", readings };
  } finally {
    s.stop();
  }
}

async function soak() {
  const minutes = Number(arg("minutes", "10"));
  const s = await startServer(["--time", "1", "--accel", "144"]);
  try {
    const samples: Record<string, unknown>[] = [];
    const run = load(s.base, { users: 300, durationS: minutes * 60, rampS: 10, sessionsPerUser: 400 });
    const t0 = performance.now();
    while (performance.now() - t0 < minutes * 60_000) {
      await Bun.sleep(60_000);
      const st = await sim(s.base, "gc");
      const elapsed = performance.now() - t0;
      samples.push({
        minute: Math.round(elapsed / 60_000),
        simulatedHours: Math.round((elapsed * 144) / 3_600_000),
        ...st,
      });
    }
    const report = await run;
    return { scenario: "soak", minutes, client: brief(report), samples };
  } finally {
    s.stop();
  }
}

async function faults() {
  const s = await startServer(["--time", "1"]);
  try {
    await sim(s.base, "reset");
    const run = load(s.base, { users: 300, durationS: 165, rampS: 10 });
    // Each fault starts this many seconds after the previous one.
    const after = async (sec: number, f: unknown) => {
      await Bun.sleep(sec * 1_000);
      await sim(s.base, "fault", f);
    };
    const schedule = (async () => {
      await after(30, { source: "gmail", kind: "outage", seconds: 30 });
      await after(45, { source: "drive", kind: "slow", seconds: 30, factor: 5 });
      await after(45, { source: "crm", kind: "rate", seconds: 30, rate: 0.2 });
    })();
    const report = await run;
    await schedule;
    return {
      scenario: "faults",
      faults: [
        { fromS: 30, toS: 60, what: "gmail outage" },
        { fromS: 75, toS: 105, what: "drive 5x slower" },
        { fromS: 120, toS: 150, what: "crm limited to 0.2 req/s per user" },
      ],
      client: report,
      server: await sim(s.base, "stats"),
    };
  } finally {
    s.stop();
  }
}

async function cold() {
  const s = await startServer(["--time", "1"]);
  try {
    const t0 = performance.now();
    await fetch(`${s.base}/healthz`);
    const firstRequestMs = performance.now() - t0;
    const timeOf = async (userId: string, text: string) => {
      const a = performance.now();
      await fetch(`${s.base}/v1/events?waitMs=5000`, {
        method: "POST",
        headers: { authorization: "Bearer simkey-tenant0-0123456789" },
        body: JSON.stringify({ userId, sessionId: "s1", kind: "user_message", text, at: Date.now() }),
      });
      return Math.round((performance.now() - a) * 10) / 10;
    };
    const coldUser = await timeOf("cold1", "Prep me for the Globex call");
    const warmSame = await timeOf("cold1", "Prep me for the Globex call with Sam Ortiz please");
    const coldUser2 = await timeOf("cold2", "Prep me for the Globex call");
    return {
      scenario: "cold",
      serverStartupMs: s.startupMs,
      spawnToListeningMs: s.listenMs,
      firstRequestMs: Math.round(firstRequestMs * 10) / 10,
      firstLookupColdUserMs: coldUser,
      secondLookupSameUserMs: warmSame,
      firstLookupAnotherColdUserMs: coldUser2,
      note: "lookup times include real (simulated) source latency, waitMs=5000",
    };
  } finally {
    s.stop();
  }
}

/** One saturating step, for profiling the server (PROFILE=<dir>). */
async function hot() {
  const s = await startServer(["--time", "0.1"]);
  try {
    await load(s.base, { users: 800, timeScale: 0.1, durationS: 15, rampS: 2 }); // Warm caches first.
    await sim(s.base, "reset");
    const report = await load(s.base, {
      users: 2_400,
      first: 800,
      prefix: "u",
      timeScale: 0.1,
      durationS: 20,
      rampS: 2,
    });
    return { scenario: "hot", client: brief(report), server: await sim(s.base, "stats") };
  } finally {
    s.stop();
    await Bun.sleep(1_500);
  }
}

const scenarios: Record<string, () => Promise<unknown>> = { steady, ramp, memory, soak, faults, cold, hot };
const fn = scenarios[scenario];
if (!fn) throw new Error(`unknown scenario ${scenario}: ${Object.keys(scenarios).join(", ")}`);
console.log(JSON.stringify(await fn(), null, 2));
process.exit(0);
