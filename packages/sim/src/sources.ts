/**
 * Simulated sources that behave like the connectors Eden will actually read through, rather than like an ideal
 * index. What differs between real connectors, and what each profile models:
 *
 * - Search semantics. Gmail and Slack search match messages containing *every* term, newest first; Google Calendar
 *   matches events by text within a time window; Drive/Notion rank documents by relevance; a CRM matches record
 *   names. A cue that is a bag of sixteen terms finds nothing in an AND search.
 * - Snippets. Search tools mostly return a subject line and a few hundred characters, not the body: a fact in the
 *   third paragraph, or in quoted history, is not in the result.
 * - Latency, failures and rate limits: a log-normal latency per call, an error rate, a per-source request budget
 *   (429 with Retry-After past it), and outage windows.
 *
 * The latency and error figures in the presets are assumptions (labelled so in reports), chosen to be plausible for
 * third-party APIs called from a server in the same region; they are inputs to vary, not measurements.
 */
import type { ContextItem, Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { Rng } from "./rng";
import { DAY, type World, type WorldItem } from "./world";

/**
 * What a connector's search does with a query. `and`, `ranked` and `names` model hosted products (Gmail-style AND,
 * Drive-style ranking, CRM name search); `substring` and `or` are the two other behaviours the connector lab measured
 * on real open-source servers (docs/research/connector-lab.md): the whole query as one substring (the reference memory
 * server, CalDAV, IMAP fields, Gitea) and any query word, ranked by how many match (mcpvault).
 */
export type Semantics = "and" | "ranked" | "names" | "substring" | "or";
/** How an integrator turns Eden's query into the connector's query string. */
export type Adapter = "text" | "entities" | "entities-or-text";

export interface SourceProfile {
  semantics: Semantics;
  adapter: Adapter;
  /** Characters of body a result carries (after any header lines); 0 for the full body. */
  snippetChars: number;
  /** For "and" search over events: only items dated within [now - before, now + after] days match. */
  windowDays?: [number, number];
  latency: { medianMs: number; sigma: number };
  errorRate: number;
  /** Requests per second this source accepts per user before answering 429. */
  ratePerSec?: number;
}

export type ProfileSet = Record<string, SourceProfile>;

const lat = (medianMs: number, sigma = 0.5) => ({ medianMs, sigma });

/** The best any connector could do: ranked full-text search over full bodies, instant and reliable. */
export const IDEAL: ProfileSet = {
  gmail: { semantics: "ranked", adapter: "text", snippetChars: 0, latency: lat(0, 0), errorRate: 0 },
  calendar: { semantics: "ranked", adapter: "text", snippetChars: 0, latency: lat(0, 0), errorRate: 0 },
  drive: { semantics: "ranked", adapter: "text", snippetChars: 0, latency: lat(0, 0), errorRate: 0 },
  crm: { semantics: "ranked", adapter: "text", snippetChars: 0, latency: lat(0, 0), errorRate: 0 },
  slack: { semantics: "ranked", adapter: "text", snippetChars: 0, latency: lat(0, 0), errorRate: 0 },
};

/** Connectors as they are: AND search, snippets, real latency (assumed figures), occasional errors. */
export const REALISTIC: ProfileSet = {
  gmail: {
    semantics: "and",
    adapter: "text",
    snippetChars: 300,
    latency: lat(350, 0.55),
    errorRate: 0.005,
    ratePerSec: 10,
  },
  calendar: {
    semantics: "and",
    adapter: "text",
    snippetChars: 0,
    windowDays: [7, 60],
    latency: lat(180, 0.4),
    errorRate: 0.003,
    ratePerSec: 10,
  },
  drive: {
    semantics: "ranked",
    adapter: "text",
    snippetChars: 500,
    latency: lat(450, 0.6),
    errorRate: 0.005,
    ratePerSec: 10,
  },
  crm: {
    semantics: "names",
    adapter: "entities-or-text",
    snippetChars: 0,
    latency: lat(300, 0.5),
    errorRate: 0.005,
    ratePerSec: 5,
  },
  slack: {
    semantics: "and",
    adapter: "text",
    snippetChars: 0,
    latency: lat(250, 0.5),
    errorRate: 0.005,
    ratePerSec: 5,
  },
};

/**
 * `base` with some fields of some sources replaced (lab `--source-profile`): an unknown source name is an error, so a
 * typo cannot silently leave a source at its default latency.
 */
export function withOverrides(base: ProfileSet, over: Record<string, Partial<SourceProfile>>): ProfileSet {
  for (const k of Object.keys(over)) if (!base[k]) throw new Error(`unknown source "${k}" in --source-profile`);
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { ...v, ...over[k] }]));
}

/**
 * The connector zoo: the same world behind connectors with different search semantics, for learning what to send
 * without being told (docs/plans/query-planner.md, tier 2). Every integrator passes Eden's query text through
 * (`adapter: "text"`), so only the query decides what comes back. `ZOO_TUNE` is for tuning; numbers are reported on
 * the held-out sets, where each source has a semantics it never had in `ZOO_TUNE`.
 */
const zoo = (semantics: Record<string, Semantics>): ProfileSet =>
  Object.fromEntries(
    Object.entries(REALISTIC).map(([k, v]) => [k, { ...v, adapter: "text" as Adapter, semantics: semantics[k]! }]),
  );
export const ZOO_TUNE = zoo({ gmail: "and", calendar: "substring", drive: "ranked", crm: "names", slack: "or" });
export const ZOO_HELDOUT_A = zoo({
  gmail: "substring",
  calendar: "and",
  drive: "or",
  crm: "substring",
  slack: "ranked",
});
export const ZOO_HELDOUT_B = zoo({
  gmail: "or",
  calendar: "ranked",
  drive: "substring",
  crm: "or",
  slack: "substring",
});

/** Realistic connectors, but each integrator searches by the cue's entities when there are any. */
export const REALISTIC_ENTITIES: ProfileSet = Object.fromEntries(
  Object.entries(REALISTIC).map(([k, v]) => [k, { ...v, adapter: "entities-or-text" as Adapter }]),
);

/** Accents dropped, lower case: what `words` and `fold` both start from. */
const plain = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const wordsOfPlain = (p: string) =>
  (p.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? []).map((w) => w.replace(/['’]s$/, ""));
const words = (s: string) => wordsOfPlain(plain(s));

/** Lower case, accents dropped, whitespace collapsed: how a substring search compares text. */
const foldOfPlain = (p: string) => p.replace(/\s+/g, " ").trim();
const fold = (s: string) => foldOfPlain(plain(s));

const STOP = new Set("a an and are at be by for from in is it of on or the to with".split(" "));

export interface SourceStats {
  /** Every call, fetches included. */
  calls: number;
  /** Listing pages read (`list`): a background sync's calls, also counted in `calls`. */
  lists: number;
  /** Read-one calls (`fetch`), to refresh a cached item. */
  fetches: number;
  errors: number;
  limited: number;
  /** Calls given up on before they answered (the caller's deadline or the session ending). */
  aborted: number;
  results: number;
  /** Results that state at least one fact (useful hits). */
  usefulResults: number;
  bytes: number;
}

export interface Fault {
  /** Until this performance.now() time, every call fails with 503 (an outage). */
  outageUntil?: number;
  /** Until `slowUntil`, latency is multiplied by `slow`. */
  slow?: number;
  slowUntil?: number;
  /** Until `ratePerSecUntil`, the request budget is `ratePerSec` (a 429 storm when low). */
  ratePerSec?: number;
  ratePerSecUntil?: number;
}

/** One item's words, as every `SimIndex` holding it reads them. Shared between indexes, so never mutated. */
interface ItemAnalysis {
  /** The title and text it was computed from: `applyUpdate` edits items in place, so a mismatch means recompute. */
  readonly title: string;
  readonly text: string;
  readonly tf: ReadonlyMap<string, number>;
  readonly len: number;
  readonly terms: ReadonlySet<string>;
  readonly titleTerms: ReadonlySet<string>;
  readonly folded: string;
}

/**
 * Per-item analysis memo, keyed on the item object: an entry goes when its item (and so its world) is collected,
 * so it holds nothing past a run. It is a pure function of the item's own title and text, so indexes sharing a world
 * share it without mixing anything between worlds.
 */
const analysed = new WeakMap<WorldItem, ItemAnalysis>();

function analyse(it: WorldItem): ItemAnalysis {
  const hit = analysed.get(it);
  if (hit && hit.title === it.title && hit.text === it.text) return hit;
  // The text normalized once for its words and its folded copy, and the title's words read once: building indexes
  // was over half the CPU of a held-out funnel run (timeline spans and a profile, docs/research/moon-telemetry.md).
  const whole = plain(`${it.title}\n${it.text}`);
  const ws = wordsOfPlain(whole);
  const titleWords = words(it.title);
  const tf = new Map<string, number>();
  for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + 1);
  for (const w of titleWords) tf.set(w, (tf.get(w) ?? 0) + 2); // Titles weigh more, as every engine does.
  const a: ItemAnalysis = {
    title: it.title,
    text: it.text,
    tf,
    len: ws.length,
    terms: new Set(ws),
    titleTerms: new Set(titleWords),
    folded: foldOfPlain(whole),
  };
  analysed.set(it, a);
  return a;
}

/** The id a `SimIndex` built over every source's items takes (`lexical-hits.ts`). */
export const ALL_SOURCES = "*";

/**
 * One source's items in one world, indexed once and shared by every simulated user given that world: the term
 * sets and BM25 statistics are the expensive part, and per-user state (quota, errors, stats) lives in `SimSource`.
 */
export class SimIndex {
  readonly items: WorldItem[];
  private readonly terms: ReadonlySet<string>[] = [];
  private readonly titleTerms: ReadonlySet<string>[] = [];
  private readonly df = new Map<string, number>();
  private readonly tf: ReadonlyMap<string, number>[] = [];
  private readonly lens: number[] = [];
  private readonly avgLen: number;
  /** Term → indexes of items holding it (ascending): searches touch postings, not every item. */
  private readonly postings = new Map<string, number[]>();
  private readonly titlePostings = new Map<string, number[]>();
  /** Title and text, folded (lower case, no accents, single spaces), for substring search. */
  private readonly folded: string[] = [];

  constructor(
    readonly id: string,
    readonly world: World,
  ) {
    // `ALL_SOURCES` (P3's `hits` arm): one index over every source's items, for a cross-source BM25 ranking.
    this.items = id === ALL_SOURCES ? world.items.slice() : world.items.filter((i) => i.sourceId === id);
    // Each item's analysis comes from the memo (`analyse`): a reindex after an update re-reads only the changed
    // items and rebuilds df and the postings. Re-reading every item was about half a freshness run's wall time.
    for (const it of this.items) {
      const a = analyse(it);
      for (const w of a.tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      this.tf.push(a.tf);
      this.lens.push(a.len);
      const i = this.terms.length;
      for (const w of a.terms) push(this.postings, w, i);
      for (const w of a.titleTerms) push(this.titlePostings, w, i);
      this.terms.push(a.terms);
      this.titleTerms.push(a.titleTerms);
      this.folded.push(a.folded);
    }
    this.avgLen = this.lens.reduce((s, x) => s + x, 0) / Math.max(1, this.lens.length);
  }

  /** The query as a substring connector compares it: the whole text, folded. */
  queryPhrase(q: SearchQuery): string {
    return fold(q.text);
  }

  queryTerms(q: SearchQuery, adapter: Adapter): string[] {
    const fromText = words(q.text).filter((w) => !STOP.has(w));
    const fromEntities = q.entities.flatMap(words).filter((w) => !STOP.has(w));
    const chosen =
      adapter === "text"
        ? fromText
        : adapter === "entities"
          ? fromEntities
          : fromEntities.length
            ? fromEntities
            : fromText;
    return [...new Set(chosen)];
  }

  match(terms: string[], limit: number, p: SourceProfile, phrase = ""): WorldItem[] {
    if (p.semantics === "substring") {
      if (!phrase) return [];
      const out: WorldItem[] = [];
      for (let i = 0; i < this.items.length; i++) if (this.folded[i]!.includes(phrase)) out.push(this.items[i]!);
      return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    }
    if (terms.length === 0) return [];
    if (p.semantics === "or") {
      const count = new Map<number, number>();
      for (const t of terms) for (const i of this.postings.get(t) ?? []) count.set(i, (count.get(i) ?? 0) + 1);
      return [...count]
        .map(([i, n]) => [this.items[i]!, n] as const)
        .sort((a, b) => b[1] - a[1] || b[0].updatedAt - a[0].updatedAt)
        .slice(0, limit)
        .map(([it]) => it);
    }
    if (p.semantics === "and") {
      const [lo, hi] = p.windowDays ?? [Infinity, Infinity];
      // Walk the rarest term's postings; check the other terms on each candidate.
      const rarest = terms.map((t) => this.postings.get(t) ?? []).sort((a, b) => a.length - b.length)[0]!;
      const out: WorldItem[] = [];
      for (const i of rarest) {
        if (!terms.every((t) => this.terms[i]!.has(t))) continue;
        const it = this.items[i]!;
        if (p.windowDays && !inWindow(it, this.world.now, lo, hi)) continue;
        out.push(it);
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    }
    if (p.semantics === "names") {
      const count = new Map<number, number>();
      for (const t of terms) for (const i of this.titlePostings.get(t) ?? []) count.set(i, (count.get(i) ?? 0) + 1);
      return [...count]
        .map(([i, n]) => [this.items[i]!, n] as const)
        .sort((a, b) => b[1] - a[1] || b[0].updatedAt - a[0].updatedAt)
        .slice(0, limit)
        .map(([it]) => it);
    }
    // Ranked: BM25 over title (weighted) and body, any term, accumulated over postings.
    const n = this.items.length;
    const acc = new Map<number, number>();
    for (const t of terms) {
      const list = this.postings.get(t);
      if (!list) continue;
      const df = this.df.get(t)!;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const i of list) {
        const f = this.tf[i]!.get(t)!;
        const s = (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * this.lens[i]!) / this.avgLen));
        acc.set(i, (acc.get(i) ?? 0) + s);
      }
    }
    return [...acc]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([i]) => this.items[i]!);
  }
}

function push(m: Map<string, number[]>, k: string, v: number): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function inWindow(it: WorldItem, now: number, before: number, after: number): boolean {
  // Calendar items carry their start in the text ("When: Thursday 23 Oct 2026, 12:30"); updatedAt is creation.
  const m = /When: \w+ (\d+) (\w{3}) (\d{4}), (\d\d):(\d\d)/.exec(it.text);
  if (!m) return true;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[2]!);
  const t = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]));
  return t >= now - before * DAY && t <= now + after * DAY;
}

/**
 * One user's connector to one source: their own quota, error draws, faults and stats over a shared `SimIndex`.
 * `timeScale` scales latency (0 for instant runs that only measure quality; 1 for real time).
 */
export class SimSource implements Source {
  readonly kind = "sim";
  /** Whether the lab forwards this source's change notifications (`--push`, the engine's `syncPush`). */
  notifies = false;
  /**
   * The world is the source: a ref it no longer has was deleted. The lab's `--fetch-gone false` (A18) sets it false, as
   * an MCP connector is (a null fetch proves nothing), for the re-read paths that depend on it (D126, D345).
   */
  fetchReportsGone = true;
  /** Fetches by ref (`--null-proves-nothing` makes its null prove nothing; it still finds what exists, D356). */
  readonly fetchesById = true;
  /** The calendar lists by time, as its list call does (D44). */
  get listsByTime(): boolean {
    return this.id === "calendar";
  }
  readonly id: string;
  readonly description: string;
  readonly stats: SourceStats = {
    calls: 0,
    fetches: 0,
    lists: 0,
    errors: 0,
    limited: 0,
    aborted: 0,
    results: 0,
    usefulResults: 0,
    bytes: 0,
  };
  fault: Fault = {};
  /** Ids of every item returned, in order (a runner reads the slice for one event). */
  readonly returned: string[] = [];
  private readonly rng: Rng;
  /** The items newest first, for `list`; rebuilt after a reindex. */
  private byRecency: WorldItem[] | null = null;
  private tokens: number;
  /** The rate bucket's clock (ms); a test sets its own so the bucket does not depend on the box's load. */
  clock: () => number = () => performance.now();
  private lastRefill: number | undefined;

  constructor(
    private index: SimIndex,
    private readonly profile: SourceProfile,
    private readonly timeScale: number,
    seed: number,
    /** Keep the ids of returned items (`returned`); off for long load runs, where it would only grow. */
    private readonly track = true,
  ) {
    this.id = index.id;
    this.description = index.world.sources[index.id] ?? index.id;
    this.rng = new Rng(seed);
    this.tokens = profile.ratePerSec === undefined ? Infinity : Math.max(1, profile.ratePerSec);
  }

  /**
   * One page of the connector's listing (D57): its items most recently updated first, from an offset cursor, at the
   * cost of one call with the same latency, rate limit, faults and error draws as a search. Counted in `stats.calls`
   * and apart in `stats.lists`, so a runner can report sync calls separately from request-time ones.
   */
  async list(_scope: Scope, cursor: string | undefined, limit: number, signal: AbortSignal): Promise<ListPage> {
    this.stats.lists++;
    await this.callGuards(signal);
    const at = cursor === undefined ? 0 : Math.max(0, Number(cursor) || 0);
    // Newest first, as a mail or chat list call returns; the order is read at call time, so an update moves an item up.
    if (this.byRecency === null) this.byRecency = [...this.index.items].sort((a, b) => b.updatedAt - a.updatedAt);
    const hits = this.byRecency.slice(at, at + limit);
    const items = hits.map((it) => render(it, this.profile.snippetChars));
    for (const i of items) this.stats.bytes += i.title.length + i.text.length;
    return { items, next: at + limit < this.byRecency.length ? String(at + limit) : null };
  }

  /** A call's latency, rate limit, faults and error draw (search and list share them); throws as a connector would. */
  private async callGuards(signal: AbortSignal): Promise<void> {
    this.stats.calls++;
    const p = this.profile;
    const now = performance.now();
    const f = this.fault;
    const slow = f.slow && (f.slowUntil ?? Infinity) > now ? f.slow : 1;
    const delay = p.latency.medianMs > 0 ? this.rng.lognormal(p.latency.medianMs, p.latency.sigma) : 0;
    const scaled = delay * this.timeScale * slow;
    try {
      if (scaled > 0) await sleep(scaled, signal);
      else if (signal.aborted) throw signal.reason;
    } catch (e) {
      this.stats.aborted++;
      throw e;
    }
    const rate = f.ratePerSec !== undefined && (f.ratePerSecUntil ?? Infinity) > now ? f.ratePerSec : p.ratePerSec;
    if (rate !== undefined && !this.take(rate)) {
      this.stats.limited++;
      throw new Error("429 Too Many Requests: rate limit exceeded, retry after 2");
    }
    if ((f.outageUntil ?? -Infinity) > performance.now() || this.rng.chance(p.errorRate)) {
      this.stats.errors++;
      throw new Error(
        (f.outageUntil ?? -Infinity) > performance.now() ? "503 Service Unavailable" : "500 Internal Server Error",
      );
    }
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]> {
    this.stats.calls++;
    const p = this.profile;
    const now = performance.now();
    const f = this.fault;
    const slow = f.slow && (f.slowUntil ?? Infinity) > now ? f.slow : 1;
    const delay = p.latency.medianMs > 0 ? this.rng.lognormal(p.latency.medianMs, p.latency.sigma) : 0;
    const scaled = delay * this.timeScale * slow;
    try {
      if (scaled > 0) await sleep(scaled, signal);
      else if (signal.aborted) throw signal.reason;
    } catch (e) {
      this.stats.aborted++;
      throw e;
    }
    const rate = f.ratePerSec !== undefined && (f.ratePerSecUntil ?? Infinity) > now ? f.ratePerSec : p.ratePerSec;
    if (rate !== undefined && !this.take(rate)) {
      this.stats.limited++;
      throw new Error("429 Too Many Requests: rate limit exceeded, retry after 2");
    }
    if ((f.outageUntil ?? -Infinity) > performance.now() || this.rng.chance(p.errorRate)) {
      this.stats.errors++;
      throw new Error(
        (f.outageUntil ?? -Infinity) > performance.now() ? "503 Service Unavailable" : "500 Internal Server Error",
      );
    }
    // A listing by time (no words, a window: D44) returns the events that start in it, as a calendar's list call does.
    const w = query.window;
    const hits =
      w && !query.text.trim()
        ? this.index.items
            .filter((it) => {
              const day = it.meta?.start?.slice(0, 10);
              return !!day && day >= w.start && day < w.end;
            })
            .sort((a, b) => a.meta!.start!.localeCompare(b.meta!.start!))
            .slice(0, query.limit)
        : this.index.match(this.index.queryTerms(query, p.adapter), query.limit, p, this.index.queryPhrase(query));
    this.stats.results += hits.length;
    for (const it of hits) if (it.facts.length) this.stats.usefulResults++;
    if (this.track) for (const it of hits) this.returned.push(it.id);
    const items = hits.map((it) => render(it, p.snippetChars));
    for (const i of items) this.stats.bytes += i.title.length + i.text.length;
    return items;
  }

  /**
   * The source's current copy of one item by its ref (a connector's read-one tool), at the cost of one call: the same
   * latency, faults and error draws as a search.
   */
  /** Every item, as a background sync paging through the connector would read it (lab experiments only). */
  listAll(): ContextItem[] {
    return this.index.items.map((it) => render(it, this.profile.snippetChars));
  }

  async fetch(ref: string, _scope: unknown, signal: AbortSignal): Promise<ContextItem | null> {
    this.stats.calls++;
    this.stats.fetches++;
    const p = this.profile;
    const delay = p.latency.medianMs > 0 ? this.rng.lognormal(p.latency.medianMs, p.latency.sigma) : 0;
    const scaled = delay * this.timeScale;
    try {
      if (scaled > 0) await sleep(scaled, signal);
      else if (signal.aborted) throw signal.reason;
    } catch (e) {
      this.stats.aborted++;
      throw e;
    }
    if ((this.fault.outageUntil ?? -Infinity) > performance.now() || this.rng.chance(p.errorRate)) {
      this.stats.errors++;
      throw new Error("500 Internal Server Error");
    }
    const it = this.index.items.find((x) => x.ref === ref);
    return it ? render(it, p.snippetChars) : null;
  }

  /** Rebuilds this connector's index from the world's current items (after an update at the source). */
  reindex(): void {
    this.byRecency = null;
    this.index = new SimIndex(this.id, this.index.world);
  }

  /** A token bucket in simulated time: real elapsed time divided by the time scale. */
  private take(rate: number): boolean {
    if (this.timeScale === 0) return true; // Instant runs have no real time to rate-limit over.
    if (rate <= 0) return false; // A rate of 0 is an outage of 429s, not a bucket of one.
    const now = this.clock();
    const simSeconds = (now - (this.lastRefill ?? now)) / 1_000 / this.timeScale;
    // The bucket holds at least one token: with `rate` as its size, a rate under 1/s never reached the one token a
    // call takes, and refused every call (RealUse-1 D: perf-cli's 0.2/s CRM storm was a full outage).
    this.tokens = Math.min(Math.max(1, rate), this.tokens + simSeconds * rate);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

/** The item as a connector returns it: headers kept, body cut to the snippet length. */
function render(it: WorldItem, n: number): ContextItem {
  let text = it.text;
  if (n > 0) {
    const split = text.indexOf("\n\n");
    const head = split >= 0 && /^From: /.test(text) ? text.slice(0, split + 2) : "";
    const body = head ? text.slice(split + 2) : text;
    const flat = body.replace(/\s+/g, " ").trim();
    text = head + (flat.length > n ? `${flat.slice(0, n)}…` : flat);
  }
  return {
    id: it.id,
    sourceId: it.sourceId,
    ref: it.ref,
    title: it.title,
    text,
    updatedAt: it.updatedAt,
    ...(it.meta ? { meta: it.meta } : {}),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Indexes for every source of a world (build once per world, share across users). */
export function simIndexes(world: World): SimIndex[] {
  return Object.keys(world.sources).map((id) => new SimIndex(id, world));
}

/** One user's connectors over shared indexes. */
export function sourcesFor(indexes: SimIndex[], profiles: ProfileSet, timeScale: number, seed: number, track = true) {
  return indexes.map((ix, i) => new SimSource(ix, profiles[ix.id]!, timeScale, seed * 31 + i, track));
}

/** One SimSource per source id in the world, all with the same profile set. */
export function simSources(world: World, profiles: ProfileSet, timeScale: number, seed = 1): SimSource[] {
  return sourcesFor(simIndexes(world), profiles, timeScale, seed);
}
