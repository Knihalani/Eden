#!/usr/bin/env bun
/**
 * R1c's capacity soak (docs/research/r1-release.md, round 3): heavy users (20 connectors, 3,000 prose items each, the
 * `users.bench.ts --prose --sources=20` user that docs/DEPLOY.md §6 sizes boxes by) served for a wall-clock half hour
 * through the server's own wiring (`buildPartner` with the default, `createHandler`, persistence on with the
 * operator's encrypted disk), one process per core as `EDEN_PROCESSES` runs them, with a restart halfway. Meant to run
 * inside a cgroup shaped like the smallest recommended box (2 cores, 12 GB; see the note for the commands).
 *
 *   bun packages/sim/src/lab/soak.ts [--users 1800] [--procs 2] [--minutes 30] [--restart-at 15] [--out FILE]
 *
 * The orchestrator (this file without `--child`) starts the processes, samples their RSS (and the cgroup's usage when
 * it can read it) every 10 s, sends SIGTERM at `--restart-at` minutes into the load (each process writes its live
 * users as `main.ts` does at shutdown) and starts them again on the same directories, then prints one JSON report.
 *
 * Each process: first (not after the restart) every one of its users is backfilled through the real path (a first
 * event kicks the user's sync, D753), then the load runs until the end: each user starts a session at exponential
 * intervals of mean `--session-min` minutes (12: about a sixth of users touched within the last 2 minutes, the warm
 * bound, the peak hour's 1/6 live and 5/6 warm of D998), a session being session_start, a user message (`waitMs` 0:
 * the fast path), a tool call and result, half the time an ask, then pending and session_end, each request through the
 * HTTP handler in process (no socket: what is timed is Eden's own work). Connectors answer instantly and generate
 * their items on demand, so the item text a connector would hold elsewhere is not in this process's memory.
 * No model, no network.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFrozenDisk, type ContextPartner, type ItemCache } from "@eden/engine";
import type { ContextItem, Scope } from "@eden/protocol";
import { warmGate } from "@eden/redact";
import { buildPartner, createHandler } from "@eden/server";
import type { ListPage, Source } from "@eden/sources";
import { buildWorld } from "../world";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const USERS = Number(arg("users", "1800"));
const PROCS = Number(arg("procs", "2"));
const MINUTES = Number(arg("minutes", "30"));
const RESTART_AT = Number(arg("restart-at", "15"));
const SESSION_MIN = Number(arg("session-min", "12"));
const PER_USER = 3_000;
const SOURCES = Array.from({ length: 20 }, (_, i) => ["mail", "calendar", "docs"][i] ?? `src${i}`);
const TENANTS = 10;
const KEY = (t: number) => `soak-tenant${t}-0123456789abcdef`;
const PERSIST_KEY = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
const T0 = Date.UTC(2026, 10, 3, 9);

// ---------------------------------------------------------------------------------------------------------------
// A process serving its share of the users.

/** `users.bench.ts --prose`'s pieces: docs/ cut into 1,100-character items. */
function prosePieces(): string[] {
  const dir = new URL("../../../../docs/", import.meta.url).pathname;
  const files = [...new Bun.Glob("**/*.md").scanSync(dir)].sort();
  const joined = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  return Array.from({ length: Math.floor(joined.length / 1_100) }, (_, i) => joined.slice(i * 1_100, (i + 1) * 1_100));
}

/** A connector whose items are made on each listing (instant; nothing held between calls but the shared pools). */
class GenSource implements Source {
  readonly kind = "soak";
  readonly description = "soak";
  constructor(
    readonly id: string,
    private readonly k: number,
    private readonly u: number,
    private readonly base: { title: string; meta?: Record<string, string> }[],
    private readonly prose: string[],
  ) {}
  private item(j: number): ContextItem {
    // The user's j-th item of this source is their (j * 20 + k)-th of 3,000, as `users.bench.ts` splits them.
    const i = j * SOURCES.length + this.k;
    const b = this.base[i % this.base.length]!;
    const item: ContextItem = {
      id: `${this.id}:u${this.u}-${i}`,
      sourceId: this.id,
      ref: `u${this.u}-${i}`,
      title: b.title,
      text: `${this.prose[i % this.prose.length]!} (u${this.u})`,
      updatedAt: T0 - i * 60_000,
    };
    return b.meta ? { ...item, meta: b.meta } : item;
  }
  async search(): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const n = Math.ceil((PER_USER - this.k) / SOURCES.length);
    const at = cursor ? Number(cursor) : 0;
    const items: ContextItem[] = [];
    for (let j = at; j < Math.min(n, at + limit); j++) items.push(this.item(j));
    return { items, next: at + limit < n ? String(at + limit) : null };
  }
}

const REQUESTS = [
  "Can you reply to Dana about the budget review and move it to Friday?",
  "Book the quarterly planning call with the vendor for next Tuesday afternoon",
  "Pay the outstanding invoice before the end of the week",
  "Draft a note to the team about the deployment checklist",
  "Reschedule my 3pm with Marco to tomorrow morning",
  "Send the signed contract to legal and ask them to file it",
];
const QUESTIONS = [
  "What did Dana say about the budget review?",
  "When is the deployment freeze?",
  "Who owns the vendor contract renewal?",
  "Is there anything I should know before the planning call?",
];

interface Window {
  event: number[];
  message: number[];
  ask: number[];
  errors: number;
  status4xx: number;
  requests: number;
}
const newWindow = (): Window => ({ event: [], message: [], ask: [], errors: 0, status4xx: 0, requests: 0 });

/** When the load stops (wall clock): from `--end-at`, or the orchestrator's message once the backfill is done. */
let endAt = Number(arg("end-at", "Infinity"));

async function child(index: number, dir: string, resume: boolean): Promise<void> {
  const send = (m: unknown) => process.send?.(m);
  warmGate();
  const prose = prosePieces();
  const base = buildWorld({ seed: 1, noiseScale: 5 }).items.map((it) =>
    it.meta ? { title: it.title, meta: it.meta } : { title: it.title },
  );
  const mine: { scope: Scope; key: string; u: number }[] = [];
  for (let u = index; u < USERS; u += PROCS) {
    const t = u % TENANTS;
    mine.push({ scope: { tenantId: `t${t}`, userId: `u${u}` }, key: KEY(t), u });
  }
  const sources = new Map(
    mine.map(({ scope, u }) => [scope.userId, SOURCES.map((id, k) => new GenSource(id, k, u, base, prose))]),
  );
  const disk = new EncryptedFrozenDisk({
    dir,
    key: PERSIST_KEY,
    maxBytes: 64 * 1024 ** 3,
    maxAgeMs: 7 * 24 * 3_600_000,
    refuseForeignKey: true,
  });
  const partner: ContextPartner = buildPartner({
    sources: async (scope) => sources.get(scope.userId) ?? [],
    sourceMapPath: join(dir, "source-map.db"),
    persist: disk,
  });
  const cache = (partner as unknown as { deps: { cache: ItemCache } }).deps.cache;
  partner.startSync(60_000);
  const keys = new Map(Array.from({ length: TENANTS }, (_, t) => [KEY(t), `t${t}`] as const));
  const handle = createHandler(partner, { keys, dev: false, tenantRatePerSec: 10_000, tenantBurst: 10_000 });
  let w = newWindow();
  const post = async (key: string, path: string, body: unknown, into?: number[]) => {
    const t = performance.now();
    w.requests++;
    try {
      const r = await handle(
        new Request(`http://soak${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      await r.arrayBuffer();
      if (r.status >= 500) w.errors++;
      else if (r.status >= 400) w.status4xx++;
    } catch {
      w.errors++;
    }
    into?.push(performance.now() - t);
  };
  let stopping = false;
  process.on("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    // As main.ts: the sync stops, live users are written as frozen ones within their share of the grace.
    partner.stopSync();
    const t = performance.now();
    const n = partner.persistLive(15_000 * 0.3);
    send({ kind: "persisted", index, users: n, ms: Math.round(performance.now() - t), window: summarise(w) });
    process.exit(0);
  });

  // Backfill (first start only): each user's first event kicks their sync; a few kicks run at once (D753).
  if (!resume) {
    const b0 = performance.now();
    for (const { scope, key } of mine) {
      await post(key, "/v1/events", { userId: scope.userId, sessionId: "warm", kind: "session_start" });
      await post(key, "/v1/events?waitMs=0", {
        userId: scope.userId,
        sessionId: "warm",
        kind: "user_message",
        text: "good morning",
      });
    }
    let last = -1;
    for (;;) {
      const done = mine.reduce((s, { scope }) => s + (cache.syncedCount(scope) >= PER_USER ? 1 : 0), 0);
      if (done !== last)
        send({ kind: "backfill", index, done, of: mine.length, s: Math.round((performance.now() - b0) / 1_000) });
      last = done;
      if (done >= mine.length) break;
      await Bun.sleep(5_000);
    }
    w = newWindow();
  }
  send({ kind: "loaded", index });

  // The load: sessions at exponential intervals per user, until `endAt` (wall clock), once the orchestrator set it.
  while (!Number.isFinite(endAt)) await Bun.sleep(100);
  let seq = 0;
  const session = async ({ scope, key }: (typeof mine)[number]) => {
    const sid = `s${seq++}`;
    const who = { userId: scope.userId, sessionId: sid };
    await post(key, "/v1/events", { ...who, kind: "session_start" }, w.event);
    await post(
      key,
      "/v1/events?waitMs=0",
      { ...who, kind: "user_message", text: REQUESTS[seq % REQUESTS.length] },
      w.message,
    );
    await post(key, "/v1/events", { ...who, kind: "tool_call", tool: "search_mail", input: { q: "budget" } }, w.event);
    await post(
      key,
      "/v1/events",
      { ...who, kind: "tool_result", tool: "search_mail", output: "3 messages: budget review moved to Friday" },
      w.event,
    );
    if (Math.random() < 0.5) await post(key, "/v1/ask", { ...who, question: QUESTIONS[seq % QUESTIONS.length] }, w.ask);
    await post(key, "/v1/pending", who, w.event);
    await post(key, "/v1/events", { ...who, kind: "session_end" }, w.event);
  };
  const next = () => -Math.log(1 - Math.random()) * SESSION_MIN * 60_000;
  for (const user of mine) {
    const run = async () => {
      if (stopping || Date.now() >= endAt) return;
      await session(user);
      setTimeout(run, next());
    };
    setTimeout(run, Math.random() * SESSION_MIN * 60_000);
  }
  // Every 30 s: this window's latencies and counts, and the process's memory and cache state.
  setInterval(() => {
    const m = process.memoryUsage();
    send({
      kind: "window",
      index,
      at: Date.now(),
      rssMB: m.rss / 1_048_576,
      heapMB: m.heapUsed / 1_048_576,
      users: cache.userCount,
      frozen: cache.frozenCount,
      warm: cache.warmCount,
      onDisk: readdirSync(dir).filter((f) => f.endsWith(".blob")).length,
      window: summarise(w),
    });
    w = newWindow();
  }, 30_000);
  setInterval(() => {
    if (Date.now() >= endAt + 5_000) {
      send({ kind: "done", index });
      process.exit(0);
    }
  }, 1_000);
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100;
};
function summarise(w: Window) {
  return {
    requests: w.requests,
    errors: w.errors,
    status4xx: w.status4xx,
    event: { n: w.event.length, p50: pct(w.event, 0.5), p99: pct(w.event, 0.99) },
    message: { n: w.message.length, p50: pct(w.message, 0.5), p99: pct(w.message, 0.99) },
    ask: { n: w.ask.length, p50: pct(w.ask, 0.5), p99: pct(w.ask, 0.99) },
    raw: { event: w.event, message: w.message, ask: w.ask },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The orchestrator.

function cgroupMB(): number | null {
  for (const path of ["/sys/fs/cgroup/memory/r1soak/memory.usage_in_bytes", "/sys/fs/cgroup/memory.current"]) {
    try {
      return Number(readFileSync(path, "utf8")) / 1_048_576;
    } catch {
      // Not in that cgroup.
    }
  }
  return null;
}
function rssMB(pid: number): number {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) / 1_024 : 0;
  } catch {
    return 0;
  }
}

async function orchestrate(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "eden-soak-"));
  const dirs = Array.from({ length: PROCS }, (_, i) => join(root, `p${i}`));
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const t0 = Date.now();
  const log = (line: string) => console.error(`[${((Date.now() - t0) / 60_000).toFixed(1)} min] ${line}`);
  const samples: { min: number; phase: string; rssMB: number[]; cgroupMB: number | null }[] = [];
  const windows: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let phase = "backfill";
  let orchestratorEnd = Number.POSITIVE_INFINITY;
  let procs: ReturnType<typeof Bun.spawn>[] = [];
  const start = (resume: boolean) =>
    new Promise<void>((resolve) => {
      let loaded = 0;
      procs = dirs.map((dir, i) =>
        Bun.spawn(
          [
            "bun",
            import.meta.path,
            ...args,
            "--child",
            String(i),
            "--dir",
            dir,
            "--resume",
            resume ? "1" : "0",
            "--end-at",
            String(orchestratorEnd),
          ],
          {
            stdout: "inherit",
            stderr: "inherit",
            ipc(m: Record<string, unknown>) {
              if (m.kind === "window") {
                const { raw: _raw, ...rest } = m.window as Record<string, unknown>;
                windows.push({ ...m, window: rest, phase, min: (Date.now() - t0) / 60_000 });
                const r = m.window as { raw: { event: number[]; message: number[]; ask: number[] } };
                if (phase.startsWith("load"))
                  for (const k of ["event", "message", "ask"] as const) all[k].push(...r.raw[k]);
                const s = m.window as { errors: number; status4xx: number; requests: number };
                if (phase.startsWith("load")) {
                  totals.errors += s.errors;
                  totals.status4xx += s.status4xx;
                  totals.requests += s.requests;
                }
              } else {
                events.push({ ...m, min: (Date.now() - t0) / 60_000 });
                if (m.kind !== "window") log(JSON.stringify(m).slice(0, 300));
                if (m.kind === "loaded" && ++loaded === PROCS) resolve();
              }
            },
          },
        ),
      );
    });
  const all = { event: [] as number[], message: [] as number[], ask: [] as number[] };
  const totals = { errors: 0, status4xx: 0, requests: 0 };
  const sampler = setInterval(() => {
    samples.push({
      min: (Date.now() - t0) / 60_000,
      phase,
      rssMB: procs.map((p) => Math.round(rssMB(p.pid))),
      cgroupMB: cgroupMB() === null ? null : Math.round(cgroupMB()!),
    });
  }, 10_000);

  await start(false);
  phase = "load-1";
  const loadStart = Date.now();
  orchestratorEnd = loadStart + MINUTES * 60_000;
  log(`backfill done in ${((loadStart - t0) / 60_000).toFixed(1)} min; load until ${MINUTES} min from now`);
  // The first processes were started before the end was known: they are told it now.
  for (const p of procs) p.send({ kind: "end-at", endAt: orchestratorEnd });
  await Bun.sleep(RESTART_AT * 60_000);
  phase = "restart";
  log("SIGTERM to every process (they write their live users)");
  const r0 = Date.now();
  await Promise.all(
    procs.map((p) => {
      p.kill("SIGTERM");
      return p.exited;
    }),
  );
  const down = Date.now() - r0;
  await start(true);
  log(`restarted: down ${down} ms, up again in ${Date.now() - r0} ms`);
  phase = "load-2";
  await Promise.all(procs.map((p) => p.exited));
  clearInterval(sampler);

  const report = {
    users: USERS,
    procs: PROCS,
    minutes: MINUTES,
    restartAt: RESTART_AT,
    sessionMin: SESSION_MIN,
    backfillMin: Math.round(((loadStart - t0) / 60_000) * 10) / 10,
    restartDownMs: down,
    totals,
    latencyMs: {
      event: { n: all.event.length, p50: pct(all.event, 0.5), p99: pct(all.event, 0.99) },
      message: { n: all.message.length, p50: pct(all.message, 0.5), p99: pct(all.message, 0.99) },
      ask: { n: all.ask.length, p50: pct(all.ask, 0.5), p99: pct(all.ask, 0.99) },
    },
    samples,
    windows,
    events,
  };
  const out = arg("out", join(root, "report.json"));
  await Bun.write(out, JSON.stringify(report, null, 1));
  log(`report: ${out}`);
  console.log(JSON.stringify({ ...report, samples: undefined, windows: undefined, events: undefined }));
}

if (args.includes("--child")) {
  const index = Number(arg("child", "0"));
  process.on("message", (m: { kind?: string; endAt?: number }) => {
    if (m?.kind === "end-at" && typeof m.endAt === "number") endAt = m.endAt;
  });
  await child(index, arg("dir", ""), arg("resume", "0") === "1").catch((e) => {
    console.error(`soak child ${index}: ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(1);
  });
} else {
  await orchestrate();
}
