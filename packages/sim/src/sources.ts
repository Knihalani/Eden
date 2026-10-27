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
import type { ContextItem } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { Rng } from "./rng";
import { DAY, type World, type WorldItem } from "./world";

export type Semantics = "and" | "ranked" | "names";
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

/** Realistic connectors, but each integrator searches by the cue's entities when there are any. */
export const REALISTIC_ENTITIES: ProfileSet = Object.fromEntries(
  Object.entries(REALISTIC).map(([k, v]) => [k, { ...v, adapter: "entities-or-text" as Adapter }]),
);

const words = (s: string) =>
  (
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? []
  ).map((w) => w.replace(/['’]s$/, ""));

const STOP = new Set("a an and are at be by for from in is it of on or the to with".split(" "));

export interface SourceStats {
  calls: number;
  errors: number;
  limited: number;
  results: number;
  /** Results that state at least one fact (useful hits). */
  usefulResults: number;
  bytes: number;
}

export interface Fault {
  /** Wall-clock window, ms since the source was created, during which every call fails (an outage). */
  outage?: [number, number];
  /** Multiplies latency. */
  slow?: number;
}

/**
 * One simulated connector over a world's items for one source id. `timeScale` scales latency (0 for instant runs
 * that only measure quality; 1 for real time).
 */
export class SimSource implements Source {
  readonly kind = "sim";
  readonly description: string;
  readonly stats: SourceStats = { calls: 0, errors: 0, limited: 0, results: 0, usefulResults: 0, bytes: 0 };
  fault: Fault = {};
  /** Ids of every item returned, in order (a runner reads the slice for one event). */
  readonly returned: string[] = [];
  private readonly items: WorldItem[];
  private readonly terms: Set<string>[];
  private readonly titleTerms: Set<string>[];
  private readonly df = new Map<string, number>();
  private readonly tf: Map<string, number>[];
  private readonly lens: number[];
  private readonly avgLen: number;
  private readonly rng: Rng;
  private readonly born = performance.now();
  private tokens: number;
  private lastRefill = performance.now();

  constructor(
    readonly id: string,
    world: World,
    private readonly profile: SourceProfile,
    private readonly timeScale: number,
    seed: number,
  ) {
    this.description = world.sources[id] ?? id;
    this.items = world.items.filter((i) => i.sourceId === id);
    this.terms = [];
    this.titleTerms = [];
    this.tf = [];
    this.lens = [];
    for (const it of this.items) {
      const ws = words(`${it.title}\n${it.text}`);
      const tf = new Map<string, number>();
      for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of words(it.title)) tf.set(w, (tf.get(w) ?? 0) + 2); // Titles weigh more, as every engine does.
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      this.tf.push(tf);
      this.lens.push(ws.length);
      this.terms.push(new Set(ws));
      this.titleTerms.push(new Set(words(it.title)));
    }
    this.avgLen = this.lens.reduce((s, x) => s + x, 0) / Math.max(1, this.lens.length);
    this.rng = new Rng(seed);
    this.tokens = profile.ratePerSec ?? Infinity;
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]> {
    this.stats.calls++;
    const p = this.profile;
    const delay = p.latency.medianMs > 0 ? this.rng.lognormal(p.latency.medianMs, p.latency.sigma) : 0;
    const scaled = delay * this.timeScale * (this.fault.slow ?? 1);
    if (scaled > 0) await sleep(scaled, signal);
    else if (signal.aborted) throw signal.reason;
    if (p.ratePerSec !== undefined && !this.take(p.ratePerSec)) {
      this.stats.limited++;
      throw new Error("429 Too Many Requests: rate limit exceeded, retry after 2");
    }
    const since = performance.now() - this.born;
    const out = this.fault.outage && since >= this.fault.outage[0] && since < this.fault.outage[1];
    if (out || this.rng.chance(p.errorRate)) {
      this.stats.errors++;
      throw new Error(out ? "503 Service Unavailable" : "500 Internal Server Error");
    }
    const hits = this.match(this.queryTerms(query), query.limit);
    this.stats.results += hits.length;
    for (const it of hits) {
      if (it.facts.length) this.stats.usefulResults++;
    }
    for (const it of hits) this.returned.push(it.id);
    const items = hits.map((it) => this.render(it));
    for (const i of items) this.stats.bytes += i.title.length + i.text.length;
    return items;
  }

  private take(rate: number): boolean {
    const now = performance.now();
    this.tokens = Math.min(
      rate,
      this.tokens + ((now - this.lastRefill) / 1_000) * rate * Math.max(this.timeScale, 1e-9),
    );
    this.lastRefill = now;
    if (this.timeScale === 0) return true; // Instant runs have no real time to rate-limit over.
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  private queryTerms(q: SearchQuery): string[] {
    const fromText = words(q.text).filter((w) => !STOP.has(w));
    const fromEntities = q.entities.flatMap(words).filter((w) => !STOP.has(w));
    const a = this.profile.adapter;
    const chosen =
      a === "text" ? fromText : a === "entities" ? fromEntities : fromEntities.length ? fromEntities : fromText;
    return [...new Set(chosen)];
  }

  private match(terms: string[], limit: number): WorldItem[] {
    if (terms.length === 0) return [];
    const p = this.profile;
    if (p.semantics === "and") {
      const [lo, hi] = p.windowDays ?? [Infinity, Infinity];
      const now = Date.UTC(2026, 9, 27, 9, 0);
      const out: WorldItem[] = [];
      this.items.forEach((it, i) => {
        if (!terms.every((t) => this.terms[i]!.has(t))) return;
        if (p.windowDays && !this.inWindow(it, now, lo, hi)) return;
        out.push(it);
      });
      return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    }
    if (p.semantics === "names") {
      const scored: [WorldItem, number][] = [];
      this.items.forEach((it, i) => {
        let n = 0;
        for (const t of terms) if (this.titleTerms[i]!.has(t)) n++;
        if (n > 0) scored.push([it, n]);
      });
      return scored
        .sort((a, b) => b[1] - a[1] || b[0].updatedAt - a[0].updatedAt)
        .slice(0, limit)
        .map(([it]) => it);
    }
    // Ranked: BM25 over title (weighted) and body, any term.
    const n = this.items.length;
    const scored: [WorldItem, number][] = [];
    this.items.forEach((it, i) => {
      let s = 0;
      const tf = this.tf[i]!;
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        const df = this.df.get(t)!;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * this.lens[i]!) / this.avgLen));
      }
      if (s > 0) scored.push([it, s]);
    });
    return scored
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([it]) => it);
  }

  private inWindow(it: WorldItem, now: number, before: number, after: number): boolean {
    // Calendar items carry their start in the text ("When: Thursday 23 Oct 2026, 12:30"); updatedAt is creation.
    const m = /When: \w+ (\d+) (\w{3}) (\d{4}), (\d\d):(\d\d)/.exec(it.text);
    if (!m) return true;
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[2]!);
    const t = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]));
    return t >= now - before * DAY && t <= now + after * DAY;
  }

  /** The item as the connector returns it: headers kept, body cut to the snippet length. */
  private render(it: WorldItem): ContextItem {
    let text = it.text;
    const n = this.profile.snippetChars;
    if (n > 0) {
      const split = text.indexOf("\n\n");
      const head = split >= 0 && /^From: /.test(text) ? text.slice(0, split + 2) : "";
      const body = head ? text.slice(split + 2) : text;
      const flat = body.replace(/\s+/g, " ").trim();
      text = head + (flat.length > n ? `${flat.slice(0, n)}…` : flat);
    }
    return { id: it.id, sourceId: it.sourceId, ref: it.ref, title: it.title, text, updatedAt: it.updatedAt };
  }
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

/** One SimSource per source id in the world, all with the same profile set. */
export function simSources(world: World, profiles: ProfileSet, timeScale: number, seed = 1): SimSource[] {
  return Object.keys(world.sources).map((id, i) => new SimSource(id, world, profiles[id]!, timeScale, seed * 31 + i));
}
