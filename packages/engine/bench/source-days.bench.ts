/**
 * One user with many connected sources over whole simulated days (A13, docs/research/a13-scale.md): what the
 * background sync lists and what the card model is sent, per user per day, as the user's sources change. The
 * one-session bench beside it (`many-sources.bench.ts`) runs a few hours over sources that never change, so it cannot
 * show the daily sweep, the polls of a source that gained items, or the cards those items cost.
 *
 * The engine is the shipped wiring (`DEFAULT_CONFIG`, sync on, the query planner serving) with a card enricher whose
 * model is a stub that counts calls and items (it writes no card), under the servers' budget (`DEFAULT_LIMITS`, on the
 * simulated clock). Sources are in memory and count their calls: the workload's mail, calendar, docs and CRM, and
 * `sources - 4` noise connectors (tickets, wikis, chat channels…) in a work vocabulary, ~3% of items naming one of the
 * workload's people. Every source gains new items through the day (a Poisson rate per source: mail
 * `--mail-per-day`, each noise source its own rate, exponential with mean `--churn` a day). The user works 9:00–17:00
 * (a request every 10 minutes, an ask every 30); the sync ticks every simulated minute, day and night.
 *
 *   bun packages/engine/bench/source-days.bench.ts [sources=1000] [itemsPerSource=20] [days=2]
 *     [--churn=1] [--mail-per-day=40] [--config=<json>]
 *
 * Prints one JSON line (cold start, then each day) and a readable summary on stderr. Simulated data only.
 */
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { QueryPlanner, type ListPage, type SearchQuery, type Source } from "@eden/sources";
import { CardEnricher, ContextPartner, ItemCache, type CardMaker, type EngineConfig } from "../src/index";
import { buildWorkload, rng } from "./workload";

const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const config = flag("config") ? (JSON.parse(flag("config")!) as Partial<EngineConfig>) : {};
const churn = Number(flag("churn") ?? 1);
const mailPerDay = Number(flag("mail-per-day") ?? 40);
const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const N = Number(argv[0] ?? 1_000);
const itemsPerSource = Number(argv[1] ?? 20);
const days = Number(argv[2] ?? 2);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Midnight UTC: the user's day runs 9:00-17:00 of each simulated day.
const T0 = Date.UTC(2026, 9, 1);
let clock = T0;
const now = () => clock;

const w = buildWorkload({ itemsPerSource: Math.max(itemsPerSource, 50), events: 400, seed: 7 });
const r = rng(11);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
const NOISE_KINDS = ["jira", "wiki", "slack", "dash", "drive", "github", "zendesk", "figma", "sheets", "forms"];
const NOISE_WORDS = (
  "sprint backlog deploy metric dashboard widget pipeline schema endpoint latency cluster shard label channel " +
  "standup retro epic story bug triage design mockup component release branch merge build artifact queue alert"
).split(" ");

const calls = { search: 0, list: 0 };

/** An in-memory source whose rows can grow; lists newest first with an offset cursor, searches by name and word. */
class DaySource implements Source {
  readonly kind = "mcp" as const;
  readonly description: string;
  rows: ContextItem[];
  private made = 0;
  constructor(
    readonly id: string,
    rows: ContextItem[],
    /** New items a day. */
    readonly rate: number,
    private readonly fresh: (id: string, at: number) => ContextItem,
  ) {
    this.description = id;
    this.rows = [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  /** Adds the items that arrived over `ms` (Poisson), newest first. */
  grow(ms: number, at: number): void {
    let k = 0;
    const lambda = (this.rate * ms) / DAY;
    // Knuth's draw: rates here are small per step.
    for (let p = Math.exp(-lambda), u = r(); u > p; u *= r()) k++;
    for (let i = 0; i < k; i++) this.rows.unshift(this.fresh(`${this.id}:n${this.made++}`, at));
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    calls.search++;
    const terms = q.text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3);
    const ents = q.entities.map((e) => e.toLowerCase());
    const out: ContextItem[] = [];
    for (const it of this.rows) {
      if (out.length >= q.limit) break;
      const text = `${it.title} ${it.text}`.toLowerCase();
      if (ents.some((e) => text.includes(e)) || (terms.length > 0 && terms.every((t) => text.includes(t))))
        out.push(it);
    }
    return out;
  }
  async list(_scope: unknown, cursor: string | undefined, limit: number): Promise<ListPage> {
    calls.list++;
    const from = cursor ? Number(cursor) : 0;
    const items = this.rows.slice(from, from + limit);
    return { items, next: from + limit < this.rows.length ? String(from + limit) : null };
  }
}

function noiseItem(id: string, sourceId: string, kind: string, at: number): ContextItem {
  const ws = Array.from({ length: 30 + Math.floor(r() * 120) }, () =>
    r() < 0.4 ? pick(NOISE_WORDS) : r() < 0.995 ? `${pick(NOISE_WORDS)}${Math.floor(r() * 50)}` : pick(w.people),
  );
  return { id, sourceId, ref: id, title: `${kind} ${pick(NOISE_WORDS)}`, text: ws.join(" "), updatedAt: at };
}

const sources: DaySource[] = [];
const RATES: Record<string, number> = { mail: mailPerDay, calendar: 5, docs: 5, crm: 5 };
for (const ws of w.sources) {
  const rows: ContextItem[] = [];
  for (const e of w.people.slice(0, 60)) {
    for (const it of await ws.search({ scope: w.scope, text: "", entities: [e], limit: 2 })) {
      if (rows.length < itemsPerSource && !rows.some((x) => x.id === it.id)) rows.push(it);
    }
  }
  const timed = rows.map((it) => ({ ...it, updatedAt: T0 - Math.floor(r() * 30 * DAY) }));
  // A new item is an earlier one's words under a new id: the source's own vocabulary.
  const fresh = (id: string, at: number): ContextItem => ({ ...pick(timed), id, ref: id, updatedAt: at });
  sources.push(new DaySource(ws.id, timed, RATES[ws.id] ?? 5, fresh));
}
for (let k = sources.length; k < N; k++) {
  const kind = pick(NOISE_KINDS);
  const id = `${kind}-${k}`;
  const rows = Array.from({ length: itemsPerSource }, (_, i) =>
    noiseItem(`${id}:${i}`, id, kind, T0 - Math.floor(r() ** 2 * 60 * DAY)),
  );
  // Exponential with mean `churn`: most connectors are quiet, a few busy.
  const rate = -Math.log(1 - r()) * churn;
  sources.push(new DaySource(id, rows, rate, (nid, at) => noiseItem(nid, id, kind, at)));
}

const card = { calls: 0, items: 0 };
const maker: CardMaker = {
  async make(items, _today, _signal, _retry, intent) {
    card.calls++;
    card.items += items.length;
    return {
      cards: items.map(() => ({ kind: "none" as const, actions: [], entities: [], statement: "" })),
      ...(intent ? { requests: items.map(() => []) } : {}),
      // The measured price of a card call (A1: $0.000181 on Haiku 5.5), so the per-user budget binds as in production.
      costUsd: 0.000181,
    };
  },
};
const cards = new CardEnricher({ maker, budget: new Budget(DEFAULT_LIMITS, now), now });
const sourceMap = new SourceMap();
const cache = new ItemCache();
const partner = new ContextPartner({
  sources: async () => sources,
  sourceMap,
  cache,
  budget: new Budget(DEFAULT_LIMITS, now),
  model: null,
  now,
  cards,
  planner: new QueryPlanner({ seed: 1, store: sourceMap, mode: "serve" }),
  config,
});
const sync = partner.sync!;

/** Lets background work (slow path, polls, card drains) settle: until nothing moved over a few turns of the loop. */
async function settle(): Promise<void> {
  let quiet = 0;
  let last = -1;
  while (quiet < 3) {
    await Bun.sleep(0);
    const n = calls.search + calls.list + card.calls;
    quiet = n === last ? quiet + 1 : 0;
    last = n;
  }
}

type Tally = {
  listBackground: number;
  listDemand: number;
  search: number;
  cardCalls: number;
  cardItems: number;
  cardUsd: number;
  deferred: number;
  itemsListed: number;
  syncedHeld: number;
  ms: number;
};
const snap = () => ({
  bg: sync.stats.backgroundCalls,
  demand: sync.stats.demandCalls,
  search: calls.search,
  cardCalls: card.calls,
  cardItems: card.items,
  deferred: cards.stats.deferred,
  items: sync.stats.backgroundItems + sync.stats.demandItems,
  t: performance.now(),
});
const since = (a: ReturnType<typeof snap>): Tally => {
  const b = snap();
  return {
    listBackground: b.bg - a.bg,
    listDemand: b.demand - a.demand,
    search: b.search - a.search,
    cardCalls: b.cardCalls - a.cardCalls,
    cardItems: b.cardItems - a.cardItems,
    cardUsd: Math.round((b.cardCalls - a.cardCalls) * 0.000181 * 1e4) / 1e4,
    deferred: b.deferred - a.deferred,
    itemsListed: b.items - a.items,
    syncedHeld: cache.syncedCount(w.scope),
    ms: Math.round(b.t - a.t),
  };
};

const user = (sessionId: string, text: string): AgentEvent =>
  ({ ...w.scope, sessionId, kind: "user_message", text, at: clock }) as AgentEvent;

// ── Cold start: 8:00 on the first day; the user's first event, then a tick a minute until every source is warm. ──
clock = T0 + 8 * HOUR;
const c0 = snap();
await partner.observe(user("cold", "morning"), { waitMs: 0 });
for (let t = 0; t < 600 && !sync.warm(w.scope); t++) {
  clock += MIN;
  partner.observe(user("cold", "ok"), { waitMs: 0 });
  await sync.tick();
  await settle();
}
await settle();
const cold = since(c0);

// ── Days: the sync ticks every minute; the user works 9-17 with a request every 10 minutes and an ask every 30. ──
const TOPICS = ["renewal", "contract", "pricing", "invoice", "budget", "launch", "hiring", "offsite"];
const perDay: Tally[] = [];
let ev = 1;
for (let d = 0; d < days; d++) {
  const start = snap();
  const end = T0 + (d + 1) * DAY + 8 * HOUR;
  while (clock < end) {
    clock += MIN;
    for (const s of sources) s.grow(MIN, clock);
    const hour = (clock % DAY) / HOUR;
    const minute = Math.round((clock % HOUR) / MIN);
    if (hour >= 9 && hour < 17 && minute % 10 === 0) {
      const e = w.events[ev++ % w.events.length]!;
      await partner.observe({ ...e, at: clock } as AgentEvent, { waitMs: 0 });
      if (minute % 30 === 0) {
        await partner.ask({
          ...w.scope,
          sessionId: `day-${d}`,
          question: `What is the latest on the ${pick(TOPICS)} with ${pick(w.people.slice(0, 60))}?`,
        });
      }
    }
    await sync.tick();
    await settle();
  }
  perDay.push(since(start));
}

const out = { sources: N, itemsPerSource, churn, mailPerDay, config, cold, perDay };
const line = (t: Tally) =>
  `list ${t.listBackground} bg + ${t.listDemand} demand, search ${t.search}, cards ${t.cardCalls} calls ` +
  `($${t.cardUsd}, ${t.cardItems} items, ${t.deferred} deferred), listed ${t.itemsListed}, held ${t.syncedHeld}, ` +
  `${t.ms} ms`;
console.error(`${N} sources × ${itemsPerSource} items, churn ${churn}/day\ncold: ${line(cold)}`);
perDay.forEach((t, i) => console.error(`day ${i + 1}: ${line(t)}`));
console.log(JSON.stringify(out));
process.exit(0);
