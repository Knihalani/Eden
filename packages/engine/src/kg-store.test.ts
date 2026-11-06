/**
 * The knowledge graph's storage and name reading against the code they replaced (D58's `UserGraph` of Maps and
 * strings, and the regex `runsOf`), kept here as references, verbatim but for one marked fix (a link a full node
 * refused on one side now leaves with its item): the compact graph and the scanner must return exactly what they
 * return, through random adds, removes, re-adds, full nodes and node ids reused.
 */
import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import {
  EDGE,
  extract,
  runsOf,
  seedsOf,
  squash,
  UserGraph,
  type EdgeType,
  type NodeKind,
  type Seed,
  type Walked,
  type WalkOptions,
} from "./kg";
import { LEADING, ROLES } from "./probes";
import { isStopword } from "./text";

const TYPES = Object.keys(EDGE) as EdgeType[];

const N_TYPES = TYPES.length;
const bit = (t: EdgeType) => 1 << EDGE[t];
const PRIOR: Record<EdgeType, number> = {
  about: 1,
  authored: 0.9,
  attended: 0.6,
  mentions: 0.7,
  ref: 1.2,
  channel: 0.5,
  role: 0.8,
  on: 0.5,
  constrains: 2,
  alias: 0.8,
  member: 0.7,
};
const COMMON_CAPS = new Set(
  (
    "re fw fwd hi hello hey dear thanks thank cheers best regards kind warm reminder update updates quick heads fyi " +
    "note notes please just all our your the this that these those we you it its i im i'm i've i'll let lets let's " +
    "from to cc date sent subject when where who what why how attendees organiser organizer owner status contact " +
    "deal stage amount reason account legal policy section entry outcome declared reviewed location preferences " +
    "today tomorrow yesterday tonight morning afternoon evening night monday tuesday wednesday thursday friday " +
    "saturday sunday january february march april may june july august september october november december jan feb " +
    "mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun am pm utc gmt bst cet " +
    "anything nothing something everything nobody anyone someone everyone any no yes ok okay sure great good nice " +
    "can could would will should may might must shall do does did done send sending sent get got go going " +
    "one two three four five six seven eight nine ten new old next last first second same other"
  ).split(" "),
);
const WORD = /[\p{L}\p{N}][\p{L}\p{N}&'’.-]{0,40}/gu;
const HUB = 400;
const MAX_LINKS = 64;
const LINK_HOPS = 2;
const HOP_DECAY = 0.6;
const MAX_NODES = 120_000;
interface GNode {
  kind: NodeKind;
  label: string;
  items: Map<string, number>;
  links: Map<string, { mask: number; n: number }>;
}
interface Placed {
  nodes: string[];
  /** The one change from D58's code: whether the link went on both sides (true) or only on the first's. */
  links: [string, string, number, boolean][];
  authors: string[];
  automated: boolean;
  bound: boolean;
}

class ReferenceGraph {
  readonly nodes = new Map<string, GNode>();
  private readonly placed = new Map<string, Placed>();
  /** Items with long spans (`Extraction.long`), scanned by a walk from days: at most one entry per cached item. */
  private readonly long = new Map<string, { from: string; to: string }[]>();
  /** Learned evidence per edge type: Beta(alpha, beta) of "an item reached by this type was delivered and used". */
  private readonly alpha = new Float64Array(N_TYPES).fill(2);
  private readonly beta = new Float64Array(N_TYPES).fill(2);

  get size(): number {
    return this.nodes.size;
  }

  /** Puts an item in the graph, replacing what an earlier copy of it put there. */
  add(item: ContextItem, now: number): void {
    if (this.placed.has(item.id)) this.remove(item.id);
    const x = extract(item, now);
    const placed: Placed = { nodes: [], links: [], authors: x.authors, automated: x.automated, bound: x.bound };
    for (const [key, n] of x.nodes) {
      let node = this.nodes.get(key);
      if (!node) {
        if (this.nodes.size >= MAX_NODES) continue;
        node = { kind: n.kind, label: n.label, items: new Map(), links: new Map() };
        this.nodes.set(key, node);
      } else if (n.kind === "name" && /\s/.test(n.label) && !/\s/.test(node.label)) node.label = n.label;
      node.items.set(item.id, (node.items.get(item.id) ?? 0) | n.mask);
      placed.nodes.push(key);
    }
    for (const [a, b, mask] of x.links) {
      const na = this.nodes.get(a);
      const nb = this.nodes.get(b);
      if (!na || !nb) continue;
      // The one change from D58's code: a link only the first node took (the second was full) is recorded too, so it
      // leaves with the item; D58 kept it, and the nodes it held, for good.
      if (!this.bump(na, b, mask)) continue;
      placed.links.push([a, b, mask, this.bump(nb, a, mask)]);
    }
    this.placed.set(item.id, placed);
    if (x.long.length > 0) this.long.set(item.id, x.long);
  }

  /** Adds one statement of a link; false when the node is full (then nothing is added on either side). */
  private bump(node: GNode, other: string, mask: number): boolean {
    const l = node.links.get(other);
    if (l) {
      l.mask |= mask;
      l.n++;
      return true;
    }
    if (node.links.size >= MAX_LINKS) return false;
    node.links.set(other, { mask, n: 1 });
    return true;
  }

  /** Takes an item out: its edges, the links it stated, and nodes nothing else holds. */
  remove(id: string): void {
    const p = this.placed.get(id);
    if (!p) return;
    this.placed.delete(id);
    this.long.delete(id);
    for (const [a, b, , both] of p.links) {
      for (const [x, y] of (both
        ? [
            [a, b],
            [b, a],
          ]
        : [[a, b]]) as [string, string][]) {
        const node = this.nodes.get(x);
        const l = node?.links.get(y);
        if (l && --l.n <= 0) node!.links.delete(y);
      }
    }
    for (const key of p.nodes) {
      const node = this.nodes.get(key);
      if (!node) continue;
      node.items.delete(id);
      if (node.items.size === 0 && node.links.size === 0) this.nodes.delete(key);
    }
    // A node kept only by a link whose last item just left: gone with it.
    for (const [a, b] of p.links) {
      for (const k of [a, b]) {
        const node = this.nodes.get(k);
        if (node && node.items.size === 0 && node.links.size === 0) this.nodes.delete(k);
      }
    }
  }

  /** The learned multiplier of an edge type: its posterior mean over the prior's (0.5), between 0.25 and 2. */
  factor(t: number): number {
    const mean = this.alpha[t]! / (this.alpha[t]! + this.beta[t]!);
    return Math.min(2, Math.max(0.25, mean / 0.5));
  }

  /** The weight of an edge mask: its strongest type's prior times the learned factor, plus a constrains bonus. */
  private weightOf(mask: number): number {
    let best = 0;
    for (let t = 0; t < N_TYPES; t++) {
      if (!(mask & (1 << t)) || t === EDGE.constrains) continue;
      best = Math.max(best, PRIOR[TYPES[t]!] * this.factor(t));
    }
    // What constrains something is what the conflict test can use: it ranks first among a name's many items.
    if (mask & bit("constrains")) best = Math.max(best, 0.5) * (1 + PRIOR.constrains * this.factor(EDGE.constrains));
    return best;
  }

  /**
   * Learns from an outcome: the item(s) reached through these edge types were delivered and then used (or not). A
   * cheap Beta update per type, with the evidence decaying (0.995 per update) so a user's habits can change.
   */
  learn(mask: number, used: boolean): void {
    for (let t = 0; t < N_TYPES; t++) {
      this.alpha[t] = 2 + (this.alpha[t]! - 2) * 0.995;
      this.beta[t] = 2 + (this.beta[t]! - 2) * 0.995;
      if (!(mask & (1 << t))) continue;
      if (used) this.alpha[t]! += 1;
      else this.beta[t]! += 1;
    }
  }

  /**
   * Spreading activation from `seeds`: one hop of node links (a person to their organisation and first name, a first
   * name to the people who go by it), then to items, each node's spread divided by log2(2 + its degree). A day seed
   * reaches only items that constrain it (an event that day is the cache's `timed` business). A node on more than
   * `HUB` items spreads nothing. Stops at `budgetMs`.
   */
  walk(seeds: Seed[], opt: WalkOptions): Walked[] {
    const t0 = performance.now();
    let steps = 0;
    const late = () => (++steps & 127) === 0 && performance.now() - t0 > opt.budgetMs;
    // Each activated node, its activation and the seed it came from: a node reached from two seeds keeps the larger.
    const act = new Map<string, { a: number; origin: string }>();
    const isSeed = new Set<string>();
    const banned = opt.exclude ?? new Set<string>();
    for (const s of seeds) {
      if (!this.nodes.has(s.key) || banned.has(s.key) || (act.get(s.key)?.a ?? 0) >= s.weight) continue;
      if (s.parent && this.nodes.has(s.parent)) continue;
      act.set(s.key, { a: s.weight, origin: s.key });
      isSeed.add(s.key);
    }
    /** Nodes one link from a seed whose seed is no hub: their items' authors speak for what the request names. */
    const near = new Set<string>(isSeed);
    // Two hops of links: a first name to the person, the person to their organisation ("Ingrid" to Ingrid Berg to
    // Globex), each hop weaker.
    // A word of a longer name seeds its own items only: "Sam" of an unknown "Sam Ortiz" is not every Sam.
    const words = new Set(seeds.filter((s) => s.parent).map((s) => s.key));
    let frontier = [...isSeed].filter((k) => !words.has(k));
    for (let hop = 1; hop <= LINK_HOPS && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const key of frontier) {
        const node = this.nodes.get(key)!;
        const from = act.get(key)!;
        // A person's few links (addresses, first name, organisation) each carry them whole; an organisation's many
        // people share its activation.
        const fan = node.links.size > 12 ? Math.sqrt(node.links.size) : 1;
        for (const [other, l] of node.links) {
          if (late()) break;
          // A first name several people go by stands for each of them only in part ("Sam": Sam Patel or Sam Ortiz).
          const shared = l.mask & bit("alias") ? Math.max(1, this.peopleCalled(key), this.peopleCalled(other)) : 1;
          const w = ((from.a * this.weightOf(l.mask)) / fan / shared) * (hop === 1 ? 1 : HOP_DECAY);
          if (banned.has(other)) continue;
          if (w > (act.get(other)?.a ?? 0)) {
            if (!act.has(other)) next.push(other);
            act.set(other, { a: w, origin: from.origin });
          }
          // The seed's own names and addresses, or the person a role names: their items speak for the seed. An
          // organisation's members do not each speak for what the request asks of it.
          if (hop === 1 && l.mask & bit("alias") && node.links.size <= 12 && node.items.size <= HUB) near.add(other);
        }
      }
      frontier = next.filter((k) => this.nodes.has(k));
    }
    // An item's score from one seed is the best of the nodes that seed reached it through (a person's name, address
    // and first name are one person, not three votes); its scores from different seeds add up.
    const best = new Map<string, Map<string, number>>();
    const masks = new Map<string, number>();
    const via = new Map<string, string[]>();
    const viaName = new Set<string>();
    const binding = new Set<string>();
    const byRef = new Set<string>();
    for (const [key, { a, origin }] of act) {
      if (late()) break;
      const node = this.nodes.get(key);
      if (!node || node.items.size > HUB) continue;
      const spread = a / Math.log2(2 + node.items.size);
      for (const [id, mask] of node.items) {
        if (node.kind === "day" && !(mask & bit("constrains"))) continue;
        const s = spread * this.weightOf(mask);
        const per = best.get(id) ?? new Map<string, number>();
        if (s > (per.get(origin) ?? 0)) per.set(origin, s);
        best.set(id, per);
        masks.set(id, (masks.get(id) ?? 0) | mask | (isSeed.has(key) ? 0 : this.linkMask(key, isSeed)));
        const v = via.get(id) ?? [];
        if (v.length < 6 && !v.includes(node.label)) v.push(node.label);
        via.set(id, v);
        if (node.kind !== "day") viaName.add(id);
        if (mask & bit("constrains")) binding.add(id);
        if (node.kind === "id" && isSeed.has(key)) byRef.add(id);
      }
    }
    // Days a long span covers: the items holding such spans, scanned (one per cached item at most), each covering
    // span's spread divided like a day node's by how many cover the day.
    for (const s of seeds) {
      if (!s.key.startsWith("d:") || this.long.size === 0) continue;
      const day = s.key.slice(2);
      const covering: string[] = [];
      for (const [id, spans] of this.long) {
        if (late()) break;
        if (spans.some((sp) => sp.from <= day && day <= sp.to)) covering.push(id);
      }
      const spread = (s.weight / Math.log2(2 + covering.length)) * this.weightOf(bit("constrains"));
      for (const id of covering) {
        const per = best.get(id) ?? new Map<string, number>();
        if (spread > (per.get(s.key) ?? 0)) per.set(s.key, spread);
        best.set(id, per);
        masks.set(id, (masks.get(id) ?? 0) | bit("constrains"));
        const v = via.get(id) ?? [];
        if (v.length < 6 && !v.includes(day)) v.push(day);
        via.set(id, v);
        binding.add(id);
      }
    }
    const out: Walked[] = [];
    for (const [id, per] of best) {
      let s = 0;
      for (const x of per.values()) s += x;
      if (s < opt.floor) continue;
      const authors = this.placed.get(id)?.authors ?? [];
      out.push({
        id,
        score: s,
        mask: masks.get(id)!,
        via: via.get(id)!,
        speaks: authors.some((k) => near.has(k)),
        named: viaName.has(id),
        binds: binding.has(id) || (this.placed.get(id)?.bound ?? false),
        automated: this.placed.get(id)?.automated ?? false,
        byRef: byRef.has(id),
      });
    }
    return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, opt.limit);
  }

  /**
   * The user's own neighbourhood: their name's node and the nodes it links to (addresses, first name, the
   * organisation their address is at), to keep out of every walk: they are on nearly everything the user holds.
   */
  around(key: string): Set<string> {
    const out = new Set<string>();
    const node = this.nodes.get(key);
    if (!node) return out;
    out.add(key);
    for (const [other, l] of node.links) if (l.mask & (bit("alias") | bit("member"))) out.add(other);
    return out;
  }

  /** For a one-word name (a first name), how many people go by it: its alias links to other names; else 0. */
  private peopleCalled(key: string): number {
    const node = this.nodes.get(key);
    if (!node || node.kind !== "name" || /\s/.test(node.label)) return 0;
    let n = 0;
    for (const [other, l] of node.links) if (l.mask & bit("alias") && other.startsWith("n:")) n++;
    return n;
  }

  /** The link types by which a non-seed node was reached from the seeds (for learning). */
  private linkMask(key: string, seeds: Set<string>): number {
    let mask = 0;
    const node = this.nodes.get(key);
    if (!node) return 0;
    for (const s of seeds) mask |= node.links.get(s)?.mask ?? 0;
    return mask;
  }

  /** Whether a node exists (for tests and for seeding only names the user's items know). */
  has(key: string): boolean {
    return this.nodes.has(key);
  }
}

function referenceRunsOf(text: string, max = 32, title = false): string[] {
  const out: string[] = [];
  let run: string[] = [];
  let runStart = false;
  let lastEnd = -1;
  let sentenceStart = true;
  const flush = () => {
    // Dates and common words around a name are not part of it ("on Friday Dana Lee", "Hi Robin"), nor is a number
    // left at either end ("Mon 26 Oct" is no name).
    const lead = (w: string) => COMMON_CAPS.has(w.toLowerCase()) || LEADING.has(w.toLowerCase()) || /^\p{N}/u.test(w);
    while (run.length > 0 && lead(run[0]!)) {
      run.shift();
      runStart = false;
    }
    while (run.length > 0 && COMMON_CAPS.has(run.at(-1)!.toLowerCase())) run.pop();
    if (run.length > 0) {
      const one = run.length === 1 ? run[0]!.toLowerCase() : "";
      // A quarter or a half alone ("Q4", "H1") is a time, on half the user's mail: no name.
      const skip =
        one !== "" &&
        ((runStart && !title) || isStopword(one) || ROLES.has(one) || one.length < 2 || /^[qh]\d$/.test(one));
      const name = run.join(" ").replace(/['’]s$/u, "");
      if (!skip && name.length <= 80 && !out.includes(name)) out.push(name);
    }
    run = [];
  };
  for (const m of text.matchAll(WORD)) {
    if (out.length >= max) break;
    const word = m[0].replace(/[.'’-]+$/u, "");
    const at = m.index!;
    const between = lastEnd < 0 ? "" : text.slice(lastEnd, at);
    const joined = lastEnd >= 0 && /^[ \t]+$/.test(between);
    if (!joined) {
      flush();
      if (lastEnd < 0 || /[.!?:\n]/.test(between)) sentenceStart = true;
    }
    const cap = /^\p{Lu}/u.test(word);
    const num = /^\p{N}/u.test(word);
    if (cap || (num && run.length > 0)) {
      if (run.length === 0) runStart = sentenceStart;
      if (run.length < 4) run.push(word);
    } else flush();
    sentenceStart = /[.!?:]$/.test(m[0]) && !/\p{Lu}\.$/u.test(m[0]);
    lastEnd = at + m[0].length;
  }
  flush();
  return out;
}

/** A seeded generator (mulberry32): the same cases every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = Date.parse("2026-10-27T09:00:00Z");
const FIRST = "Dana Sam Łukasz Ingrid Ahmed Priya Bo Zoë Mateo Hana".split(" ");
const LAST = "Lee Ortiz Nowak Berg Hassan Raman Jensen Müller Tanaka Kim".split(" ");
const ORGS = "globex initech umbrellahealth hooli vandelay".split(" ");
const LINES = [
  "Reminder: do not commit delivery dates to Umbrella Health until the MSA is countersigned.",
  "No production changes from Wednesday 28 October to Tuesday 3 November.",
  "We're pausing all net-new headcount from 19 Oct until Q1 planning.",
  "Passport expires 2 Nov.",
  "Please check with your manager before paying INV-7174.",
  "Robert Haddad (Legal) must approve SOW-9597 first.",
  "Thanks, see you at the Hooli RFP review on Friday.",
  "Looks good to me.",
  "I'm offline from Mon 26 Oct until 4 Jan.",
  "Pay GB29 NWBK 6016 1331 9268 19 by Monday 2 Nov.",
];

/**
 * Random items over a small world, so nodes are shared, links repeat and nodes fill: one organisation has a hundred
 * people (more than a node's `MAX_LINKS`), and the same few names, ids, roles and days recur.
 */
function makeItem(r: () => number, id: string): ContextItem {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const person = () => {
    const crowd = r() < 0.4;
    const first = crowd ? `Crowd${Math.floor(r() * 100)}` : pick(FIRST);
    const last = pick(LAST);
    const org = crowd ? "hooli" : pick(ORGS);
    return `${first} ${last} <${first.toLowerCase()}.${last.toLowerCase()}@${org}.com>`;
  };
  const lines: string[] = [`From: ${person()}`];
  if (r() < 0.6) lines.push(`To: ${person()}, ${person()}`);
  lines.push("");
  const n = 1 + Math.floor(r() * 4);
  for (let k = 0; k < n; k++) lines.push(r() < 0.3 ? `[09:${10 + k}] ${pick(FIRST)}: ${pick(LINES)}` : pick(LINES));
  const chat = r() < 0.25;
  const title = chat
    ? `#${pick(["legal", "team", "ops"])}: ${pick(FIRST)}`
    : `${pick(ORGS)} ${pick(LINES).slice(0, 30)}`;
  const meta = r() < 0.2 ? { start: `2026-10-${20 + Math.floor(r() * 10)}T09:00:00.000Z` } : undefined;
  return { id, sourceId: id.split(":")[0]!, ref: id, title, text: lines.join("\n"), ...(meta ? { meta } : {}) };
}

/** Every key the generator can name (and some it cannot), for seeds, `has` and `around`. */
function keysOf(items: Iterable<ContextItem>): string[] {
  const keys = new Set<string>(["n:nobody", "d:2026-10-30", "r:manager", "r:legal", "i:inv-7174"]);
  for (const it of items) {
    const x = extract(it, at);
    for (const k of x.nodes.keys()) keys.add(k);
    for (const [a, b] of x.links) keys.add(a).add(b);
    for (const k of x.authors) keys.add(k);
  }
  return [...keys].sort();
}

function same(a: UserGraph, b: ReferenceGraph, keys: string[], r: () => number): void {
  expect(a.size).toBe(b.size);
  for (const k of keys) {
    expect(a.has(k)).toBe(b.has(k));
    expect([...a.around(k)]).toEqual([...b.around(k)]);
  }
  for (let s = 0; s < 40; s++) {
    const seeds: Seed[] = [];
    const n = 1 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const key = keys[Math.floor(r() * keys.length)]!;
      const parent = r() < 0.2 ? keys[Math.floor(r() * keys.length)] : undefined;
      seeds.push(parent ? { key, weight: 0.5, parent } : { key, weight: 0.5 + r() });
    }
    const exclude = r() < 0.3 ? new Set(keys.filter(() => r() < 0.05)) : undefined;
    const opt: WalkOptions = { budgetMs: 1e9, limit: 30, floor: 0, ...(exclude ? { exclude } : {}) };
    const got: Walked[] = a.walk(seeds, opt);
    expect(got).toEqual(b.walk(seeds, opt));
  }
}

describe("UserGraph against the reference graph", () => {
  for (const seed of [1, 2, 3]) {
    test(`random adds, changed copies, removes and re-adds (seed ${seed})`, () => {
      const r = rng(seed);
      const a = new UserGraph();
      const b = new ReferenceGraph();
      const pool = new Map<string, ContextItem>();
      for (let step = 0; step < 1_500; step++) {
        const roll = r();
        const id = `gmail:m${Math.floor(r() * 400)}`;
        if (roll < 0.65) {
          // A new item, or a changed copy of one held (replaced in place).
          const it = makeItem(r, id);
          pool.set(id, it);
          a.add(it, at);
          b.add(it, at);
        } else if (roll < 0.9) {
          a.remove(id);
          b.remove(id);
        } else {
          const mask = Math.floor(r() * (1 << TYPES.length));
          const used = r() < 0.5;
          a.learn(mask, used);
          b.learn(mask, used);
        }
        if (step % 250 === 249) same(a, b, keysOf(pool.values()), r);
      }
      // Everything out: nothing is left, and what comes back is read as new.
      for (const id of pool.keys()) {
        a.remove(id);
        b.remove(id);
      }
      expect(a.size).toBe(0);
      expect(b.size).toBe(0);
      for (const it of pool.values()) {
        a.add(it, at);
        b.add(it, at);
      }
      same(a, b, keysOf(pool.values()), r);
    });
  }

  test("a node full of links: the side that took a link keeps it, as before", () => {
    const a = new UserGraph();
    const b = new ReferenceGraph();
    const items: ContextItem[] = [];
    for (let k = 0; k < 90; k++) {
      items.push({
        id: `gmail:c${k}`,
        sourceId: "gmail",
        ref: `c${k}`,
        title: "Hello",
        text: `From: Person${k} Smith <p${k}@hooli.com>\n\nHi.`,
      });
    }
    for (const it of items) {
      a.add(it, at);
      b.add(it, at);
    }
    const keys = keysOf(items);
    same(a, b, keys, rng(9));
    for (const it of items.slice(0, 45)) {
      a.remove(it.id);
      b.remove(it.id);
    }
    same(a, b, keys, rng(10));
    for (const it of items.slice(0, 45)) {
      a.add(it, at);
      b.add(it, at);
    }
    same(a, b, keys, rng(11));
  });

  test("per user: churn in one user's graph leaves another's walks as they were", () => {
    const u = { tenantId: "t", userId: "u" };
    const v = { tenantId: "t", userId: "v" };
    const r = rng(5);
    const items = Array.from({ length: 200 }, (_, k) => makeItem(r, `gmail:i${k}`));
    const cache = new ItemCache();
    cache.enableGraph();
    cache.put(u, items, at);
    cache.put(v, items, at);
    const seeds = seedsOf("Reply to Ahmed Hassan about INV-7174", ["Ahmed Hassan"], ["2026-10-30"]);
    const opt = { budgetMs: 1e9, limit: 20, floor: 0 };
    const before = cache.walk(v, seeds, opt, at);
    expect(before.length).toBeGreaterThan(0);
    // u's items change and leave; v's graph (its own node ids and item slots) is untouched.
    cache.put(
      u,
      items.map((it) => ({ ...it, text: `${it.text}\nNew line from Zed Quill <zed@zz.com>.` })),
      at,
    );
    cache.forget(u, "gmail");
    expect(cache.graphSize(u)).toBe(0);
    expect(cache.walk(v, seeds, opt, at)).toEqual(before);
    expect(cache.walk(u, seeds, opt, at)).toEqual([]);
  });
});

describe("runsOf against the reference", () => {
  test("random text: capitals, digits, marks, scripts and long words", () => {
    const r = rng(7);
    const parts = [
      "Umbrella",
      "Health",
      "Łukasz",
      "Nowak",
      "SOC",
      "2",
      "H1",
      "2027",
      "Q4",
      "Hi",
      "Dana",
      "Lee",
      "the",
      "and",
      "ok",
      "Mon",
      "26",
      "Oct",
      "manager",
      "Legal",
      "INV-7174",
      "Hooli's",
      "O'Brien",
      "Jean-Luc",
      "St.",
      "U.S.",
      "a.m.",
      "Ørsted",
      "Ελένη",
      "東京",
      "ß",
      "Ärger",
      "x",
      "A",
      "B&Q",
      "AT&T",
      "C.E.O.",
      "Robin’s",
      "1st",
      "—",
      "–",
      "...",
      "Zoë",
      "İstanbul",
      "ǅemal",
      "Ⅻ",
      "٣",
      "𝐀𝐁c",
      "x𝐀",
      "😀",
      "\uD800",
      "a\u0301b",
      "Ab\uDC00",
      "Supercalifragilisticexpialidociousandsomemorelettersbeyondforty",
    ];
    const seps = [" ", " ", " ", "  ", "\t", ". ", ": ", "! ", "? ", "\n", ", ", " (", ") ", "-", "", " \t ", ".\n"];
    for (let k = 0; k < 4_000; k++) {
      let s = "";
      const n = Math.floor(r() * 30);
      for (let w = 0; w < n; w++) s += parts[Math.floor(r() * parts.length)]! + seps[Math.floor(r() * seps.length)]!;
      const max = [32, 12, 16, 3][k % 4]!;
      const title = k % 3 === 0;
      expect(runsOf(s, max, title)).toEqual(referenceRunsOf(s, max, title));
    }
  });

  test("the generated items' sentences", () => {
    const r = rng(8);
    for (let k = 0; k < 300; k++) {
      const it = makeItem(r, `gmail:s${k}`);
      for (const raw of `${it.title}.\n${it.text}`.split(/[.!?;]+\s|\n+/)) {
        expect(runsOf(raw, 12, false)).toEqual(referenceRunsOf(raw, 12, false));
        expect(runsOf(raw, 12, true)).toEqual(referenceRunsOf(raw, 12, true));
      }
    }
  });
});

describe("squash against the reference", () => {
  const referenceSquash = (s: string) =>
    s
      .toLowerCase()
      .replace(/['’]s$/u, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  test("names, addresses and marks, ASCII and not", () => {
    const r = rng(12);
    const parts = [
      "Umbrella",
      " ",
      "Health",
      "'s",
      "’s",
      "O'Brien",
      "-",
      ".",
      "Łukasz",
      "İ",
      "ß",
      "x",
      "3",
      "@",
      "_",
      "s",
    ];
    for (let k = 0; k < 3_000; k++) {
      let s = "";
      const n = Math.floor(r() * 6);
      for (let w = 0; w < n; w++) s += parts[Math.floor(r() * parts.length)]!;
      expect(squash(s)).toBe(referenceSquash(s));
    }
  });
});

describe("UserGraph bounds and memory", () => {
  const chat = (id: string, speakers: string[]): ContextItem => ({
    id,
    sourceId: "slack",
    ref: id,
    title: "#ops",
    text: speakers.map((s, k) => `[09:${String(k % 60).padStart(2, "0")}] ${s}: ok`).join("\n"),
  });
  const names = (from: number, n: number) => Array.from({ length: n }, (_, k) => `Speaker${from + k} Q`);

  test("node ids stay under the bound however many authors items name; a refused copy keeps the held one", () => {
    const g = new UserGraph(300);
    const ids = () => (g as unknown as { top: number }).top;
    for (let k = 0; k < 20; k++) g.add(chat(`slack:c${k}`, names(k * 40, 40)), at);
    expect(ids()).toBeLessThanOrEqual(300);
    g.add(chat("slack:big", names(10_000, 200)), at);
    g.remove("slack:big");
    g.add(
      { id: "gmail:z", sourceId: "gmail", ref: "z", title: "Hi", text: "From: Zed Quill <zed@zzcorp.com>\n\nHi" },
      at,
    );
    expect(ids()).toBeLessThanOrEqual(300);
    expect(() => g.around("n:zedquill")).not.toThrow();
    expect(() => g.walk([{ key: "n:zedquill", weight: 1 }], { budgetMs: 1e9, limit: 10, floor: 0 })).not.toThrow();
    // A copy too big for what is left is refused, and the copy already held stays.
    const held = g.walk([{ key: "n:speaker0q", weight: 1 }], { budgetMs: 1e9, limit: 10, floor: 0 });
    expect(held.map((w) => w.id)).toContain("slack:c0");
    g.add(chat("slack:c0", names(50_000, 300)), at);
    expect(g.walk([{ key: "n:speaker0q", weight: 1 }], { budgetMs: 1e9, limit: 10, floor: 0 })).toEqual(held);
  });

  test("the memo of sentences and people is emptied when an item leaves or is replaced", () => {
    const g = new UserGraph();
    const memo = () =>
      (g as unknown as { memo: { sentences: Map<string, unknown>; people: Map<string, unknown> } }).memo;
    const it: ContextItem = {
      id: "gmail:q",
      sourceId: "gmail",
      ref: "q",
      title: "Quarterly",
      text: "From: Odile Ferrand <odile@quorvant.com>\n\nThe Quorvant escrow stays frozen until Friday.",
    };
    const has = () => [...memo().sentences.keys(), ...memo().people.keys()].some((k) => /Quorvant|Odile/.test(k));
    g.add(it, at);
    expect(has()).toBe(true);
    g.add({ ...it, text: "Nothing here." }, at); // Replaced: the old copy's sentences go.
    expect(has()).toBe(false);
    g.add(it, at);
    g.remove(it.id);
    expect(memo().sentences.size + memo().people.size).toBe(0);
  });
});
