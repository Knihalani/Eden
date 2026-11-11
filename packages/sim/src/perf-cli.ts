#!/usr/bin/env bun
/**
 * Performance scenarios against the real server in its own process (server.ts), driven by simulated agents over
 * HTTP (load.ts). Prints one JSON report per scenario.
 *
 *   bun packages/sim/src/perf-cli.ts <scenario> [--profile realistic] [--model none|fake] [--gate-workers 0]
 *     [--tenant-rps 200]
 *
 * Scenarios:
 *   steady   production-like: 300 users at real pacing and real source latency for 90 s; `--synced` (A3) runs the
 *            server with `--sync on` and backfills the users first, as the shipped default serves them
 *   ramp     saturation: pacing compressed 10x, users doubling from 100 to 3,200, 20 s per step
 *   memory   server memory after warming 250, 500, 1,000 and 2,000 users (forced GC before each reading), and
 *            edenOnly: the readings minus the zero-user one (the in-process sim worlds), MB per user.
 *            `--synced` (fix-s3b): the server runs with `--sync on` and each step's users are backfilled
 *            (`/sim/sync-warm`) before the reading, as a long-running server holds them; steps default to 100, 250
 *            and 500 users there (`--steps 100,250,500` sets either). Without it the server never syncs (the old
 *            figures' setting, kept so they stay comparable).
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

// No client timeout: `sync-warm` backfills every user first, past Bun's default 300 s on a 2-core box (D1).
const sim = async (base: string, path: string, body?: unknown) =>
  (await (
    await fetch(`${base}/sim/${path}`, {
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      timeout: false,
    } as RequestInit)
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
  const s = await startServer(["--time", "1", ...(SYNCED ? ["--sync", "on"] : [])]);
  try {
    // `--synced` (A3): the shipped default syncs (D57), so an ask answers from the user's index, not a live fan-out.
    // Each user first runs one quick session (the sync tracks users it has seen), then is backfilled before the run.
    let warming: Record<string, unknown> | undefined;
    if (SYNCED) {
      await load(s.base, { users: 300, timeScale: 0.02, durationS: 600, rampS: 2, sessionsPerUser: 1 });
      warming = await sim(s.base, "sync-warm", { maxTicks: 2_000 });
      if (Number(warming.cold) > 0) throw new Error(`${warming.cold} users never warmed`);
    }
    await sim(s.base, "reset");
    const report = await load(s.base, { users: 300, durationS: Number(arg("seconds", "90")), rampS: 10 });
    return {
      scenario: "steady",
      synced: SYNCED,
      ...(warming ? { warming } : {}),
      client: brief(report),
      server: await sim(s.base, "stats"),
    };
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

const SYNCED = args.includes("--synced");

/** `--steps a,b,c`: the user counts `memory` reads at, increasing; else its default for the mode. */
export function memorySteps(raw: string | undefined, synced: boolean): number[] {
  if (raw === undefined) return synced ? [100, 250, 500] : [250, 500, 1_000, 2_000];
  const steps = raw.split(",").map(Number);
  if (!steps.length || steps.some((n, i) => !Number.isInteger(n) || n <= 0 || (i > 0 && n <= steps[i - 1]!))) {
    throw new Error(`--steps must be increasing whole numbers above 0, not ${raw}`);
  }
  return steps;
}

async function memory() {
  const s = await startServer(["--time", "0.02", ...(SYNCED ? ["--sync", "on"] : [])]);
  try {
    const readings: Record<string, unknown>[] = [{ users: 0, ...(await sim(s.base, "gc")) }];
    const warming: Record<string, unknown>[] = [];
    let done = 0;
    const i = args.indexOf("--steps");
    for (const target of memorySteps(i >= 0 ? args[i + 1] : undefined, SYNCED)) {
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
      if (SYNCED) {
        const w = await sim(s.base, "sync-warm", { maxTicks: 2_000 });
        warming.push({ users: target, ...w });
        if (Number(w.cold) > 0) throw new Error(`${w.cold} users never warmed: the reading would not be synced users`);
      }
      readings.push({ users: target, ...(await sim(s.base, "gc")) });
    }
    return {
      scenario: "memory",
      synced: SYNCED,
      readings,
      edenOnly: edenOnly(readings),
      ...(SYNCED ? { warming } : {}),
    };
  } finally {
    s.stop();
  }
}

/**
 * Eden's own memory per user. The server process also builds the sim worlds and their sources in-process before any
 * user exists (server.ts), so its zero-user reading (1,096.8 MB rss in audit 2026-11-03b) is mostly the sim, not Eden.
 * Subtracting it leaves what the users added: per reading the Eden-only MB and MB per user, and over all readings the
 * least-squares slope through the origin (MB per user).
 */
function edenOnly(readings: Record<string, unknown>[]) {
  const zero = readings[0]!;
  const rest = readings.slice(1).filter((r) => Number(r.users) > 0);
  const added = (r: Record<string, unknown>, k: string) => Number(r[k]) - Number(zero[k]);
  const round = (x: number) => Math.round(x * 1_000) / 1_000;
  // Through the origin (sum of users x added over sum of users squared): the zero-user reading is the intercept.
  const slope = (k: string) =>
    round(
      rest.reduce((n, r) => n + Number(r.users) * added(r, k), 0) /
        Math.max(
          1,
          rest.reduce((n, r) => n + Number(r.users) ** 2, 0),
        ),
    );
  return {
    note: "readings minus the zero-user reading (the in-process sim worlds and sources)",
    baseline: { rssMb: zero.rssMb, heapUsedMb: zero.heapUsedMb },
    rssMbPerUser: slope("rssMb"),
    heapMbPerUser: slope("heapUsedMb"),
    readings: rest.map((r) => ({
      users: r.users,
      rssMb: round(added(r, "rssMb")),
      heapUsedMb: round(added(r, "heapUsedMb")),
      rssMbPerUser: round(added(r, "rssMb") / Number(r.users)),
      heapMbPerUser: round(added(r, "heapUsedMb") / Number(r.users)),
    })),
  };
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
if (import.meta.main) {
  const fn = scenarios[scenario];
  if (!fn) throw new Error(`unknown scenario ${scenario}: ${Object.keys(scenarios).join(", ")}`);
  console.log(JSON.stringify(await fn(), null, 2));
  process.exit(0);
}
