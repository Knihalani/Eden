/**
 * One user with many connected sources (A1 scale audit, docs/research/a1-scale.md): what a lookup, an ask and the
 * background sync cost as the user's source count grows from a handful to ~1,000, most of them irrelevant to what
 * the user is doing. The engine is the shipped wiring with no model key (`DEFAULT_CONFIG`, sync on, the query planner
 * serving, as `buildPartner` builds it), on a simulated clock (one minute per event) so synced copies go stale and
 * the on-demand poll runs as it would over a working session.
 *
 * Sources are in memory and count their calls. The first four are the workload's mail, calendar, docs and CRM
 * (`workload.ts`'s generator, so the requests find things); the rest are "noise" connectors (tickets, wikis, chat
 * channels, dashboards…) whose items share the filler vocabulary and, rarely, a person, as real unrelated connectors
 * do. Each source lists newest first with an offset cursor (so it is synced) and searches by entity and word.
 *
 *   bun packages/engine/bench/many-sources.bench.ts [sources=1000] [itemsPerSource=20] [events=300] [asks=40]
 *     [latencyMs=0]
 *
 * `latencyMs` > 0 makes every source call take that long (wall-time figures: cold start, ask latency); 0 measures
 * Eden's own CPU. Prints one JSON line with the figures (and a readable summary on stderr).
 */
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { QueryPlanner, type ListPage, type SearchQuery, type Source } from "@eden/sources";
import { ContextPartner, ItemCache, type Trace } from "../src/index";
import { buildWorkload, rng } from "./workload";

const argv = process.argv.slice(2);
const N = Number(argv[0] ?? 1_000);
const itemsPerSource = Number(argv[1] ?? 20);
const eventCount = Number(argv[2] ?? 300);
const askCount = Number(argv[3] ?? 40);
const latencyMs = Number(argv[4] ?? 0);

const T0 = Date.UTC(2026, 9, 1, 9);
let clock = T0;
const now = () => clock;

const w = buildWorkload({ itemsPerSource: Math.max(itemsPerSource, 50), events: eventCount, seed: 7 });
const r = rng(11);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
const NOISE_KINDS = ["jira", "wiki", "slack", "dash", "drive", "github", "zendesk", "figma", "sheets", "forms"];
const NOISE_WORDS = (
  "sprint backlog deploy metric dashboard widget pipeline schema endpoint latency cluster shard label channel " +
  "standup retro epic story bug triage design mockup component release branch merge build artifact queue alert"
).split(" ");

type Calls = { search: number; list: number };
const calls: Calls = { search: 0, list: 0 };
const perSource = new Map<string, Calls>();
const wait = () => (latencyMs > 0 ? Bun.sleep(latencyMs) : Promise.resolve());

function makeSource(id: string, rows: ContextItem[]): Source {
  // Newest first, as a listing tool returns.
  const sorted = [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const own: Calls = { search: 0, list: 0 };
  perSource.set(id, own);
  const words = sorted.map((it) => new Set(`${it.title} ${it.text}`.toLowerCase().split(/[^a-z0-9]+/)));
  return {
    id,
    kind: "mcp",
    description: id,
    async search(q: SearchQuery): Promise<ContextItem[]> {
      calls.search++;
      own.search++;
      await wait();
      const terms = q.text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3);
      const ents = q.entities.map((e) => e.toLowerCase());
      const out: ContextItem[] = [];
      for (let i = 0; i < sorted.length && out.length < q.limit; i++) {
        const it = sorted[i]!;
        const text = `${it.title} ${it.text}`.toLowerCase();
        if (ents.some((e) => text.includes(e)) || (terms.length > 0 && terms.every((t) => words[i]!.has(t))))
          out.push(it);
      }
      return out;
    },
    async list(_scope, cursor, limit): Promise<ListPage> {
      calls.list++;
      own.list++;
      await wait();
      const from = cursor ? Number(cursor) : 0;
      const items = sorted.slice(from, from + limit);
      return { items, next: from + limit < sorted.length ? String(from + limit) : null };
    },
  };
}

const DAY = 86_400_000;
const sources: Source[] = [];
// The four workload sources, trimmed to `itemsPerSource`, with times over the last 30 days.
for (const ws of w.sources) {
  const rows: ContextItem[] = [];
  for (const e of w.people.slice(0, 60)) {
    for (const it of await ws.search({ scope: w.scope, text: "", entities: [e], limit: 2 })) {
      if (rows.length < itemsPerSource && !rows.some((x) => x.id === it.id)) rows.push(it);
    }
  }
  sources.push(
    makeSource(
      ws.id,
      rows.map((it) => ({ ...it, updatedAt: T0 - Math.floor(r() * 30 * DAY) })),
    ),
  );
}
for (let k = sources.length; k < N; k++) {
  const kind = pick(NOISE_KINDS);
  const id = `${kind}-${k}`;
  const rows: ContextItem[] = Array.from({ length: itemsPerSource }, (_, i) => {
    const ws = Array.from({ length: 30 + Math.floor(r() * 120) }, () =>
      r() < 0.4 ? pick(NOISE_WORDS) : r() < 0.995 ? `${pick(NOISE_WORDS)}${Math.floor(r() * 50)}` : pick(w.people),
    );
    return {
      id: `${id}:${i}`,
      sourceId: id,
      ref: String(i),
      title: `${kind} ${pick(NOISE_WORDS)} ${i}`,
      text: ws.join(" "),
      updatedAt: T0 - Math.floor(r() ** 2 * 60 * DAY),
    };
  });
  sources.push(makeSource(id, rows));
}

const sourceMap = new SourceMap();
const traces: Trace[] = [];
const partner = new ContextPartner({
  sources: async () => sources,
  sourceMap,
  cache: new ItemCache(),
  budget: new Budget(),
  model: null,
  now,
  planner: new QueryPlanner({ seed: 1, store: sourceMap, mode: "serve" }),
  onTrace: (t) => traces.push(t),
});

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const heapMb = () => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed / 2 ** 20;
};
const pct = (xs: number[], p: number) =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
/** Lets background work (slow path, polls) settle: until no source call happened over a few turns of the loop. */
async function settle(): Promise<void> {
  let quiet = 0;
  let last = calls.search + calls.list;
  while (quiet < 3) {
    await Bun.sleep(latencyMs > 0 ? latencyMs : 0);
    const n = calls.search + calls.list;
    quiet = n === last ? quiet + 1 : 0;
    last = n;
  }
}

const heap0 = heapMb();
// ── Cold start: the user's first event, then sync ticks (one simulated minute apart) until every source is warm. ──
const first = w.events[0]!;
await partner.observe({ ...first, at: clock } as AgentEvent, { waitMs: 0 });
await settle();
const coldCpu0 = cpu();
const coldWall0 = performance.now();
const listBefore = calls.list;
let ticks = 0;
const synced = () => sources.filter((s) => partner.sync!.isWarm(w.scope, s.id)).length;
for (; ticks < 2_000 && synced() < sources.length; ticks++) {
  clock += 60_000;
  partner.observe({ ...w.scope, sessionId: "cold", kind: "user_message", text: "ok", at: clock } as AgentEvent, {
    waitMs: 0,
  });
  await partner.sync!.tick();
}
const cold = {
  ticks,
  warmSources: synced(),
  listCalls: calls.list - listBefore,
  cpuMs: round(cpu() - coldCpu0, 0),
  wallMs: round(performance.now() - coldWall0, 0),
  syncedItems: partner.sync!.stats.backgroundItems,
};
const heapCold = heapMb();

// ── A working session: the workload's events, one simulated minute apart, each settled before the next. ──
const ev0 = { ...calls };
const evCpu: number[] = [];
const evObserve: number[] = [];
const cpuEv0 = cpu();
for (const e of w.events.slice(1)) {
  clock += 60_000;
  const c0 = cpu();
  const t = performance.now();
  await partner.observe({ ...e, at: clock } as AgentEvent, { waitMs: 0 });
  evObserve.push(performance.now() - t);
  await settle();
  evCpu.push(cpu() - c0);
}
const events = {
  n: w.events.length - 1,
  searchCallsPerEvent: round((calls.search - ev0.search) / (w.events.length - 1)),
  listCallsPerEvent: round((calls.list - ev0.list) / (w.events.length - 1)),
  cpuMsPerEvent: round((cpu() - cpuEv0) / (w.events.length - 1)),
  cpuMsP99: round(pct(evCpu, 0.99)),
  observeP50Ms: round(pct(evObserve, 0.5), 3),
  observeP99Ms: round(pct(evObserve, 0.99), 3),
};

// ── Asks: a person and a topic from the workload, one simulated minute apart. ──
const ask0 = { ...calls };
const askMs: number[] = [];
const askCpu: number[] = [];
let answered = 0;
const TOPICS = ["renewal", "contract", "pricing", "invoice", "budget", "launch", "hiring", "offsite"];
for (let i = 0; i < askCount; i++) {
  clock += 60_000;
  const c0 = cpu();
  const t = performance.now();
  const res = await partner.ask({
    ...w.scope,
    sessionId: `ask-${Math.floor(i / 10)}`,
    question: `What is the latest on the ${pick(TOPICS)} with ${pick(w.people.slice(0, 60))}?`,
  });
  askMs.push(performance.now() - t);
  if (res.citations.length > 0) answered++;
  await settle();
  askCpu.push(cpu() - c0);
}
const asks = {
  n: askCount,
  answered,
  searchCallsPerAsk: round((calls.search - ask0.search) / askCount),
  listCallsPerAsk: round((calls.list - ask0.list) / askCount),
  p50Ms: round(pct(askMs, 0.5)),
  p99Ms: round(pct(askMs, 0.99)),
  cpuMsPerAsk: round(askCpu.reduce((a, b) => a + b, 0) / askCount),
};
// How many distinct sources a lookup ever called after the cold start (the fan-out's width over the run).
let touched = 0;
for (const c of perSource.values()) if (c.search > 0) touched++;
const heapEnd = heapMb();
const out = {
  sources: N,
  itemsPerSource,
  latencyMs,
  cold,
  events,
  asks,
  sourcesEverSearched: touched,
  heapMb: { start: round(heap0), afterCold: round(heapCold), end: round(heapEnd) },
  decisions: traces.reduce<Record<string, number>>((m, t) => ((m[t.decision] = (m[t.decision] ?? 0) + 1), m), {}),
};
console.error(
  `${N} sources × ${itemsPerSource} items, latency ${latencyMs} ms\n` +
    `cold start: ${cold.ticks} ticks, ${cold.listCalls} list calls, ${cold.cpuMs} ms CPU, ${cold.wallMs} ms wall\n` +
    `events: ${events.searchCallsPerEvent} search + ${events.listCallsPerEvent} list calls/event, ` +
    `${events.cpuMsPerEvent} ms CPU/event (p99 ${events.cpuMsP99})\n` +
    `asks: ${asks.searchCallsPerAsk} search + ${asks.listCallsPerAsk} list calls/ask, p50 ${asks.p50Ms} ms, ` +
    `p99 ${asks.p99Ms} ms, ${asks.cpuMsPerAsk} ms CPU/ask, answered ${answered}/${askCount}\n` +
    `heap MB: ${round(heap0)} → ${round(heapCold)} (cold) → ${round(heapEnd)}`,
);
console.log(JSON.stringify(out));
process.exit(0);
