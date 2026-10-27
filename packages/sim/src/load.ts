/**
 * Load from simulated agents, over HTTP, through the real client SDK. Each user runs generated sessions as an agent
 * loop: every event is observed, then pending context is collected (the SDK's documented loop, two requests per
 * event); between events it waits as a real agent would (model think time, tool calls, the user's next message),
 * multiplied by `timeScale`. The server must run with the same time scale so source latency keeps its proportion.
 *
 * Measures what an integrator sees: latency of every call by endpoint and event kind, calls that failed open,
 * time from a request to the arrival of the context it needed, whether that arrived before the agent answered,
 * and the same per five-second window so faults and saturation show up over time.
 */
import { EdenClient } from "@eden/client";
import type { Injection } from "@eden/protocol";
import { Rng } from "./rng";
import { buildSessions, type SimSession, type SimTurn } from "./sessions";
import { worldOf, tenantKey } from "./server";
import { buildWorld, type World } from "./world";

export interface LoadOptions {
  baseUrl: string;
  /** User ids are `${prefix}${i}` for i in [first, first + users). */
  users: number;
  first?: number;
  prefix?: string;
  tenants: number;
  worlds: number;
  timeScale: number;
  durationS: number;
  waitMs: number;
  /** Probability the agent also calls ask() (as a tool) on a turn that needs context. */
  askRate: number;
  seed: number;
  /** Spread user starts over this many seconds. */
  rampS?: number;
  /** Sessions each user runs, at most. */
  sessionsPerUser?: number;
}

export interface Window {
  t: number;
  events: number;
  observeP50: number;
  observeP99: number;
  failed: number;
  needTurns: number;
  needInTime: number;
}

export interface LoadReport {
  users: number;
  durationS: number;
  generatorCpuPercent: number;
  generatorLagMs: { p50: number; p99: number; max: number };
  events: number;
  requests: number;
  eventsPerSec: number;
  requestsPerSec: number;
  failedOpen: number;
  failedOpenRate: number;
  /** Failed calls by cause: 429 (a rate limit), timeout (the SDK's 800 ms), 5xx, other. */
  failedBy: Record<string, number>;
  latency: Record<string, { n: number; p50: number; p95: number; p99: number; max: number }>;
  /** For need turns: ms from the event's send to the arrival of a must fact, when one arrived. */
  timeToContext: { n: number; p50: number; p95: number; p99: number };
  /** Need turns whose must fact arrived before the agent's answer, over need turns (all routes Eden offers). */
  inTimeRate: number;
  needTurns: number;
  injections: number;
  asks: number;
  windows: Window[];
}

const worldCache = new Map<number, { world: World; byId: Map<string, World["items"][number]> }>();
function worldFor(index: number) {
  let w = worldCache.get(index);
  if (!w) {
    const world = buildWorld({ seed: 1_000 + index });
    worldCache.set(index, (w = { world, byId: new Map(world.items.map((i) => [i.id, i])) }));
  }
  return w;
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100;
};

export async function runLoad(o: LoadOptions): Promise<LoadReport> {
  const lat = new Map<string, number[]>();
  const record = (k: string, ms: number) => {
    let a = lat.get(k);
    if (!a) lat.set(k, (a = []));
    a.push(ms);
  };
  const windows = new Map<number, { obs: number[]; failed: number; need: number; inTime: number }>();
  const win = (t: number) => {
    const k = Math.floor((t - t0) / 5_000);
    let w = windows.get(k);
    if (!w) windows.set(k, (w = { obs: [], failed: 0, need: 0, inTime: 0 }));
    return w;
  };
  let events = 0;
  let requests = 0;
  let failed = 0;
  const reasons: Record<string, number> = {};
  let injections = 0;
  let asks = 0;
  let needTurns = 0;
  let inTime = 0;
  const ttc: number[] = [];
  const prefix = o.prefix ?? "u";
  const first = o.first ?? 0;
  // Sessions are generated before the clock starts: building them is the generator's work, not load on the server,
  // and doing it as users start would stall the generator's event loop and inflate every latency it measures.
  const plans = Array.from({ length: o.users }, (_, i) => {
    const userId = `${prefix}${first + i}`;
    const w = worldFor(worldOf(userId, o.worlds));
    const { sessions } = buildSessions(w.world, {
      seed: o.seed * 104_729 + first + i,
      sessions: o.sessionsPerUser ?? 12,
    });
    return { userId, ...w, sessions };
  });
  // The generator's own event-loop lag: if it is high, the generator, not the server, limits what is measured.
  const genLags: number[] = [];
  let expected = performance.now() + 5;
  const probe = setInterval(() => {
    const t = performance.now();
    genLags.push(Math.max(0, t - expected));
    expected = t + 5;
  }, 5);
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const end = t0 + o.durationS * 1_000;

  async function user(i: number): Promise<void> {
    const { userId, world, byId, sessions } = plans[i]!;
    const r = new Rng(o.seed * 7_919 + first + i);
    await Bun.sleep(r.next() * (o.rampS ?? 5) * 1_000);
    const tenant = (first + i) % o.tenants;
    for (let si = 0; si < sessions.length && performance.now() < end; si++) {
      await session(sessions[si]!, `${userId}-s${si}`, userId, tenant, world, byId, r);
    }
  }

  async function session(
    s: SimSession,
    sessionId: string,
    userId: string,
    tenant: number,
    world: World,
    byId: Map<string, World["items"][number]>,
    r: Rng,
  ) {
    let failedHere = 0;
    const client = new EdenClient({
      apiKey: tenantKey(tenant),
      userId,
      sessionId,
      baseUrl: o.baseUrl,
      onError: (e) => {
        failedHere++;
        const m = String(e);
        const why = /: 429/.test(m)
          ? "429"
          : /timed? ?out|TimeoutError|aborted/i.test(m)
            ? "timeout"
            : /: 5\d\d/.test(m)
              ? "5xx"
              : "other";
        reasons[why] = (reasons[why] ?? 0) + 1;
      },
    });
    const turns: SimTurn[] = [
      { event: { kind: "session_start" }, label: { kind: "context", ok: [] } },
      ...s.tasks.flatMap((t) => t.turns),
    ];
    const known = new Set<string>();
    // Open need turns: the facts still awaited, when the turn was sent, and the index of the agent's answer.
    const open: { must: Set<string>; sentAt: number; answerAt: number; done: boolean }[] = [];
    const take = (injs: Injection[], at: number, now: number) => {
      for (const inj of injs) {
        injections++;
        for (const c of inj.citations) {
          const item = byId.get(c.itemId);
          for (const f of item?.facts ?? []) {
            known.add(f);
            for (const n of open) {
              if (n.done || !n.must.has(f)) continue;
              n.done = true;
              ttc.push(now - n.sentAt);
              if (at < n.answerAt) {
                inTime++;
                win(n.sentAt).inTime++;
              }
            }
          }
        }
      }
    };
    for (let i = 0; i < turns.length && performance.now() < end; i++) {
      const turn = turns[i]!;
      let ev = turn.event;
      if (ev.kind === "agent_message" && turn.uses) {
        const details = turn.uses.filter((f) => known.has(f)).map((f) => world.facts.get(f)!.detail);
        ev = {
          ...ev,
          text: details.length ? `${ev.text} ${details.join("; ")}.` : `${ev.text} I couldn't find the details yet.`,
        };
      }
      for (const f of turn.fetched ?? []) known.add(f);
      const sent = performance.now();
      if (turn.label.kind === "need") {
        let answerAt = turns.length;
        for (let j = i + 1; j < turns.length; j++) {
          if (turns[j]!.event.kind === "agent_message") {
            answerAt = j;
            break;
          }
        }
        open.push({ must: new Set(turn.label.must), sentAt: sent, answerAt, done: false });
        needTurns++;
        win(sent).need++;
        if (r.chance(o.askRate) && "text" in ev) {
          asks++;
          const question = ev.text;
          const a0 = performance.now();
          void client.ask(question, { maxItems: 5 }).then((res) => {
            record("ask", performance.now() - a0);
            requests++;
            if (res) take([{ citations: res.citations } as Injection], i, performance.now());
          });
        }
      }
      const before = failedHere;
      const res = await client.observe(ev, { waitMs: o.waitMs });
      const obsMs = performance.now() - sent;
      record(`observe:${ev.kind}`, obsMs);
      record("observe", obsMs);
      const w = win(sent);
      w.obs.push(obsMs);
      const p0 = performance.now();
      const pending = await client.collect(res.injection);
      record("pending", performance.now() - p0);
      requests += 2;
      events++;
      take(pending, i, performance.now());
      // Pacing to the next event, as a real agent and user would take it.
      const k = ev.kind;
      const ms =
        k === "user_message" || k === "external"
          ? r.lognormal(2_500, 0.4)
          : k === "tool_call"
            ? r.lognormal(600, 0.5)
            : k === "tool_result"
              ? r.lognormal(3_000, 0.4)
              : k === "agent_message"
                ? r.lognormal(20_000, 0.8)
                : 500;
      if (failedHere > before) {
        failed += failedHere - before;
        w.failed += failedHere - before;
      }
      await Bun.sleep(Math.min(ms * o.timeScale, Math.max(0, end - performance.now())));
    }
    const e0 = performance.now();
    await client.observe({ kind: "session_end" });
    record("observe:session_end", performance.now() - e0);
    requests++;
  }

  await Promise.all(Array.from({ length: o.users }, (_, i) => user(i)));
  const wall = (performance.now() - t0) / 1_000;
  const cpu = process.cpuUsage(cpu0);
  clearInterval(probe);
  const latency: LoadReport["latency"] = {};
  for (const [k, xs] of [...lat].sort())
    latency[k] = { n: xs.length, p50: q(xs, 0.5), p95: q(xs, 0.95), p99: q(xs, 0.99), max: q(xs, 1) };
  return {
    users: o.users,
    durationS: Math.round(wall * 10) / 10,
    /** The load generator's own CPU (one core = 100%): if it nears 100%, the generator is the bottleneck. */
    generatorCpuPercent: Math.round(((cpu.user + cpu.system) / 1_000 / (wall * 1_000)) * 1_000) / 10,
    generatorLagMs: { p50: q(genLags, 0.5), p99: q(genLags, 0.99), max: q(genLags, 1) },
    events,
    requests,
    // Rates over the run's own window (a few in-flight sessions finish after it).
    eventsPerSec: Math.round((events / Math.min(wall, o.durationS)) * 10) / 10,
    requestsPerSec: Math.round((requests / Math.min(wall, o.durationS)) * 10) / 10,
    failedOpen: failed,
    failedOpenRate: Math.round((failed / Math.max(1, requests)) * 10_000) / 10_000,
    failedBy: reasons,
    latency,
    timeToContext: { n: ttc.length, p50: q(ttc, 0.5), p95: q(ttc, 0.95), p99: q(ttc, 0.99) },
    inTimeRate: Math.round((inTime / Math.max(1, needTurns)) * 1_000) / 1_000,
    needTurns,
    injections,
    asks,
    windows: [...windows]
      .sort((a, b) => a[0] - b[0])
      .map(([k, w]) => ({
        t: k * 5,
        events: w.obs.length,
        observeP50: q(w.obs, 0.5),
        observeP99: q(w.obs, 0.99),
        failed: w.failed,
        needTurns: w.need,
        needInTime: w.inTime,
      })),
  };
}
