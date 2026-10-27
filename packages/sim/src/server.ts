#!/usr/bin/env bun
/**
 * The real Eden server (createHandler + ContextPartner, wired as in production: file-backed source map, per-tenant
 * API keys and rate limits) over simulated connectors, in its own process so a load generator in another process
 * cannot steal its CPU. Every user gets a deterministic world (by user id) and their own connectors (quota, error
 * draws, faults) over indexes shared per world.
 *
 *   bun packages/sim/src/server.ts [--port 0] [--worlds 20] [--profile realistic] [--time 1] [--accel 1]
 *     [--tenants 10] [--tenant-rps 200] [--model none|fake] [--gate-workers 0] [--source-map file|memory]
 *
 * Prints one JSON line {"listening": port} when ready. Control endpoints (no auth; a benchmark process only):
 *   GET  /sim/stats   process CPU, memory, event-loop lag, engine and source counters since the last reset
 *   POST /sim/reset   zero the counters
 *   POST /sim/gc      full GC, then stats (for memory measurements)
 *   POST /sim/fault   {"source": "gmail", "kind": "outage"|"slow"|"rate", "seconds": 30, "factor"?: 5, "rate"?: 0.5}
 *   POST /sim/exit    exit cleanly (writes a profile when started with bun --cpu-prof)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextPartner, GATE_MODULE, ItemCache, type Trace } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type ChatResponse, type Model } from "@eden/llm";
import { WorkerPool } from "@eden/primitives";
import { scopeKey, type Scope } from "@eden/protocol";
import { createHandler } from "@eden/server";
import { Rng } from "./rng";
import { IDEAL, REALISTIC, REALISTIC_ENTITIES, simIndexes, sourcesFor, type SimIndex, type SimSource } from "./sources";
import { buildWorld } from "./world";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};

const worlds = Number(arg("worlds", "20"));
const timeScale = Number(arg("time", "1"));
const accel = Number(arg("accel", "1"));
const tenants = Number(arg("tenants", "10"));
const profiles = { realistic: REALISTIC, ideal: IDEAL, entities: REALISTIC_ENTITIES }[arg("profile", "realistic")]!;

/** Which world a user lives in: the same function the load generator uses, so both sides agree. */
export function worldOf(userId: string, count: number): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (Math.imul(h, 31) + userId.charCodeAt(i)) | 0;
  return Math.abs(h) % count;
}

export const tenantKey = (k: number) => `simkey-tenant${k}-0123456789`;

if (import.meta.main) await main();

async function main() {
  const t0 = performance.now();
  const indexes: SimIndex[][] = [];
  for (let w = 0; w < worlds; w++) indexes.push(simIndexes(buildWorld({ seed: 1_000 + w })));
  const worldsMs = performance.now() - t0;

  const users = new Map<string, SimSource[]>();
  const resolver = async (scope: Scope) => {
    const key = scopeKey(scope);
    let s = users.get(key);
    if (!s) {
      s = sourcesFor(indexes[worldOf(scope.userId, worlds)]!, profiles, timeScale, users.size + 1, false);
      for (const src of s) src.fault = faults.get(src.id) ?? {};
      users.set(key, s);
    }
    return s;
  };
  const faults = new Map<string, SimSource["fault"]>();

  // A clock that can run faster than real time, for soak runs (TTL, idle sessions, daily budgets).
  const start = Date.now();
  const now = () => start + (Date.now() - start) * accel;
  const counters = { decisions: {} as Record<string, number>, modelCalls: 0, costUsd: 0, sourceCalls: 0, traces: 0 };
  const onTrace = (t: Trace) => {
    counters.traces++;
    counters.decisions[t.decision] = (counters.decisions[t.decision] ?? 0) + 1;
    counters.modelCalls += t.modelCalls;
    counters.costUsd += t.costUsd;
    counters.sourceCalls += t.sourceCalls;
  };
  const dir = mkdtempSync(join(tmpdir(), "eden-sim-"));
  const sourceMap = new SourceMap(arg("source-map", "file") === "file" ? join(dir, "source-map.db") : ":memory:");
  const gateWorkers = Number(arg("gate-workers", "0"));
  const gatePool =
    gateWorkers > 0
      ? await WorkerPool.start({
          module: GATE_MODULE,
          size: gateWorkers,
          maxQueue: 4_096,
          maxBatch: 32,
          taskTimeoutMs: 500,
          inlineBelow: 1_024,
        })
      : undefined;
  const model = arg("model", "none") === "fake" ? latencyModel(timeScale) : null;
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: resolver,
    sourceMap,
    cache,
    budget: new Budget(undefined, now),
    model,
    onTrace,
    now,
    gatePool,
    config: timeScale > 0 ? { sourceTimeoutMs: 1_500 * timeScale } : {},
  });
  const keys = new Map<string, string>();
  for (let k = 0; k < tenants; k++) keys.set(tenantKey(k), `tenant${k}`);
  const tenantRps = Number(arg("tenant-rps", "200"));
  const handle = createHandler(partner, { keys, dev: false, tenantRatePerSec: tenantRps, tenantBurst: tenantRps * 2 });

  // Event-loop lag: a 5 ms interval; lag is how late it fires.
  let lags: number[] = [];
  // Time inside the server per API request (handler entry to response), to tell server time from client queueing.
  let handled: number[] = [];
  let byKind: Record<string, number[]> = {};
  let expected = performance.now() + 5;
  setInterval(() => {
    const t = performance.now();
    lags.push(Math.max(0, t - expected));
    expected = t + 5;
  }, 5);
  let cpu0 = process.cpuUsage();
  let since = performance.now();

  const stats = () => {
    const cpu = process.cpuUsage(cpu0);
    const wall = performance.now() - since;
    const mem = process.memoryUsage();
    const sorted = [...lags].sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0);
    const bySource: Record<string, { calls: number; errors: number; limited: number }> = {};
    for (const list of users.values()) {
      for (const s of list) {
        const b = (bySource[s.id] ??= { calls: 0, errors: 0, limited: 0 });
        b.calls += s.stats.calls;
        b.errors += s.stats.errors;
        b.limited += s.stats.limited;
      }
    }
    const sessions = (partner as unknown as { sessions: Map<string, unknown> }).sessions.size;
    return {
      wallMs: Math.round(wall),
      cpuPercent: Math.round(((cpu.user + cpu.system) / 1_000 / wall) * 1_000) / 10,
      rssMb: Math.round(mem.rss / 1e5) / 10,
      heapUsedMb: Math.round(mem.heapUsed / 1e5) / 10,
      lagMs: { p50: q(0.5), p99: q(0.99), max: sorted.at(-1) ?? 0 },
      handlerMs: quantiles(handled),
      handlerMsByKind: Object.fromEntries(Object.entries(byKind).map(([k, xs]) => [k, quantiles(xs)])),
      requests: handled.length,
      users: users.size,
      cachedUsers: cache.userCount,
      sessions,
      worldsBuiltMs: Math.round(worldsMs),
      ...counters,
      sources: bySource,
    };
  };

  const server = Bun.serve({
    port: Number(arg("port", "0")),
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/sim/")) {
        if (url.pathname === "/sim/stats") return Response.json(stats());
        if (url.pathname === "/sim/reset") {
          lags = [];
          handled = [];
          byKind = {};
          cpu0 = process.cpuUsage();
          since = performance.now();
          counters.decisions = {};
          counters.modelCalls = counters.costUsd = counters.sourceCalls = counters.traces = 0;
          for (const list of users.values())
            for (const s of list) Object.assign(s.stats, { calls: 0, errors: 0, limited: 0 });
          return Response.json({ ok: true });
        }
        if (url.pathname === "/sim/exit") {
          setTimeout(() => process.exit(0), 50); // A clean exit, so a --cpu-prof profile is written.
          return Response.json({ ok: true });
        }
        if (url.pathname === "/sim/gc") {
          Bun.gc(true);
          return Response.json(stats());
        }
        if (url.pathname === "/sim/fault") {
          const f = (await req.json()) as {
            source: string;
            kind: string;
            seconds: number;
            factor?: number;
            rate?: number;
          };
          const until = performance.now() + f.seconds * 1_000;
          const fault = { ...(faults.get(f.source) ?? {}) };
          if (f.kind === "outage") fault.outageUntil = until;
          if (f.kind === "slow") Object.assign(fault, { slow: f.factor ?? 5, slowUntil: until });
          if (f.kind === "rate") Object.assign(fault, { ratePerSec: f.rate ?? 0.5, ratePerSecUntil: until });
          faults.set(f.source, fault);
          for (const list of users.values()) for (const s of list) if (s.id === f.source) s.fault = fault;
          return Response.json({ ok: true });
        }
        return new Response("no such sim route", { status: 404 });
      }
      const t = performance.now();
      // The event kind, for per-kind handler times (a clone: the handler reads the body itself).
      const kind =
        url.pathname === "/v1/events" ? (((await req.clone().json()) as { kind?: string }).kind ?? "?") : url.pathname;
      const res = await handle(req);
      const ms = performance.now() - t;
      handled.push(ms);
      (byKind[kind] ??= []).push(ms);
      return res;
    },
  });
  console.log(
    JSON.stringify({
      listening: server.port,
      worldsBuiltMs: Math.round(worldsMs),
      startupMs: Math.round(performance.now() - t0),
    }),
  );
}

function quantiles(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) =>
    s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100 : 0;
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}

/** A model stand-in with a realistic latency and token count, for exercising the model path's cost and timing. */
function latencyModel(scale: number): Model {
  const rng = new Rng(99);
  const fake = new FakeModel(() => '{"pick": []}');
  return {
    id: "fake-latency",
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const ms = rng.lognormal(900, 0.4) * scale;
      if (ms > 0) await Bun.sleep(ms);
      const res = await fake.chat(request);
      const costUsd = (res.usage.inputTokens * 0.15 + res.usage.outputTokens * 0.5) / 1e6;
      return { ...res, costUsd, latencyMs: ms };
    },
  };
}
