import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import {
  EDGE,
  extract,
  orgLabel,
  runsOf,
  seedsOf,
  tieWords,
  UserGraph,
  type EdgeType,
  type Memo,
  type NodeKind,
  type Seed,
  type Walked,
  type WalkOptions,
} from "./kg";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

const at = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string, meta?: Record<string, string>): ContextItem => ({
  id,
  sourceId: id.split(":")[0]!,
  ref: id,
  title,
  text,
  ...(meta ? { meta } : {}),
});
const opt = { budgetMs: 50, limit: 10, floor: 0 };

/** The user's world: Ahmed writes from Umbrella Health; Legal's hold names Umbrella Health, never Ahmed. */
const ahmed = item(
  "gmail:m1",
  "Pricing page",
  "From: Ahmed Hassan <ahmed.hassan@umbrellahealth.com>\nTo: Robin Carter <robin@northwind.co>\n\nLooks good to me.",
);
const hold = item(
  "slack:c1",
  "#legal",
  "[09:14] Søren Kierkegaard: Reminder: do not commit delivery dates to Umbrella Health until the MSA is countersigned.",
);
const offline = item(
  "slack:c2",
  "#team: Łukasz",
  "[09:14] Łukasz: today's my last day before parental leave. I'm fully offline from Mon 26 Oct until 4 Jan.",
);
const lukasz = item("gmail:m2", "Intro", "From: Łukasz Nowak <lukasz.nowak@northwind.co>\n\nHi all, welcome aboard.");
const freeze = item(
  "calendar:e1",
  "Change freeze: quarter-end close",
  "No production changes from Wednesday 28 October to Tuesday 3 November while finance closes the quarter.",
  { start: "2026-10-28T00:00:00.000Z" },
);
const lunch = item("calendar:e2", "Lunch with Dana", "Dishoom, King's Cross.", { start: "2026-10-29T12:30:00.000Z" });

describe("extract", () => {
  test("a sender is a person with an address, a first name and the organisation their domain names", () => {
    const x = extract(ahmed, at);
    expect((x.nodes.get("n:ahmedhassan")?.mask ?? 0) & (1 << EDGE.authored)).toBe(1 << EDGE.authored);
    expect(x.nodes.has("e:ahmed.hassan@umbrellahealth.com")).toBe(true);
    expect(x.nodes.has("n:ahmed")).toBe(true);
    expect(x.nodes.has("n:umbrellahealth")).toBe(true);
    const links = x.links.map(([a, b, m]) => `${a}>${b}:${m}`);
    expect(links).toContain(`n:ahmedhassan>n:ahmed:${1 << EDGE.alias}`);
    expect(links).toContain(`n:ahmedhassan>n:umbrellahealth:${1 << EDGE.member}`);
    expect(x.authors).toContain("n:ahmedhassan");
  });

  test("free mail names no organisation; a country suffix is not the name", () => {
    expect(orgLabel("gmail.com")).toBeNull();
    expect(orgLabel("mail.globex.co.uk")).toBe("globex");
    expect(orgLabel("umbrellahealth.com")).toBe("umbrellahealth");
  });

  test("a blocking sentence constrains what it names and every day of the span it states", () => {
    const x = extract(freeze, at);
    const c = 1 << EDGE.constrains;
    for (const d of ["2026-10-28", "2026-10-30", "2026-11-03"]) expect((x.nodes.get(`d:${d}`)?.mask ?? 0) & c).toBe(c);
    expect(x.nodes.has("d:2026-11-04")).toBe(false);
    // An event that day is on it; only a constraint is linked to the days it covers.
    expect(extract(lunch, at).nodes.get("d:2026-10-29")?.mask).toBe(1 << EDGE.on);
  });

  test("a chat speaker authors the line; the channel is a node", () => {
    const x = extract(offline, at);
    expect(x.authors).toEqual(["n:łukasz"]);
    expect(x.nodes.has("c:#team")).toBe(true);
    expect(((x.nodes.get("n:łukasz")?.mask ?? 0) >> EDGE.constrains) & 1).toBe(1);
  });

  test("identifiers, and a role in apposition linked to the person", () => {
    const x = extract(
      item(
        "gmail:m3",
        "Out of office",
        "From: Mark Adeyemi <mark@northwind.co>\n\nINV-7174 is on hold. Mark (your manager)",
      ),
      at,
    );
    expect(x.nodes.has("i:inv-7174")).toBe(true);
    expect(x.nodes.has("r:manager")).toBe(true);
    expect(x.links.some(([a, b]) => a === "n:markadeyemi" && b === "r:manager")).toBe(true);
  });

  test("only the first 1,000 characters of an item's text are read (D150)", () => {
    // Lowercase filler names nothing; each sentence ends in ". " so the names stand in sentences of their own.
    const filler = (n: number) => "the plan is unchanged. ".repeat(Math.floor(n / 23)) + " ".repeat(n % 23);
    const before = "Priya Raman approved it. ";
    const after = "Tobias Fenwick approved it. priya@globex.com";
    // Priya's name ends at character 1,000 exactly; Tobias's starts there, as does an address after him.
    const head = filler(1_000 - before.length + 1) + before.slice(0, -1);
    expect(head.length).toBe(1_000);
    const x = extract(item("gmail:long", "Status", `${head} ${after}`), at);
    expect(x.nodes.has("n:priyaraman")).toBe(true);
    expect(x.nodes.has("n:tobiasfenwick")).toBe(false);
    expect(x.nodes.has("e:priya@globex.com")).toBe(false);
    // The same names at the head of an item are read: the cut is position, not wording.
    const y = extract(item("gmail:short", "Status", `${after} ${before}`), at);
    expect(y.nodes.has("n:tobiasfenwick")).toBe(true);
    expect(y.nodes.has("e:priya@globex.com")).toBe(true);
    expect(y.nodes.has("n:priyaraman")).toBe(true);
  });

  test("an item names at most 48 nodes", () => {
    const names = Array.from({ length: 300 }, (_, k) => `Person${String.fromCharCode(65 + (k % 26))}${k} Smith`);
    expect(extract(item("drive:d1", "Roster", names.join(", ")), at).nodes.size).toBeLessThanOrEqual(48);
  });
});

describe("runsOf", () => {
  test("names, not greetings, dates or sentence-start words", () => {
    expect(
      runsOf("Hi Robin, the Umbrella Health renewal and SOC 2 report. Please call Dana Lee on Mon 26 Oct."),
    ).toEqual(["Robin", "Umbrella Health", "SOC 2", "Dana Lee"]);
    expect(runsOf("Forward the H1 2027 roadmap deck to Grace Liu")).toEqual(["H1 2027", "Grace Liu"]);
    expect(runsOf("Q4 numbers are in")).toEqual([]);
  });
});

describe("UserGraph.walk", () => {
  const graph = (...items: ContextItem[]) => {
    const g = new UserGraph();
    for (const i of items) g.add(i, at);
    return g;
  };

  test("reaches an item through a person's organisation, with zero shared words", () => {
    const g = graph(ahmed, hold);
    const got = g.walk(seedsOf("Reply to Ahmed Hassan", ["Ahmed Hassan"], [], []), opt);
    const w = got.find((x) => x.id === hold.id);
    expect(w).toBeDefined();
    expect(w!.via).toContain("Umbrella Health");
    expect(w!.named).toBe(true);
    expect(tieWords(w!.via).has("umbrella")).toBe(true);
  });

  test("reaches what someone says under the first name the user's items show they go by", () => {
    const got = graph(lukasz, offline).walk(seedsOf("Give Łukasz Nowak the draft", ["Łukasz Nowak"], [], []), opt);
    const w = got.find((x) => x.id === offline.id);
    expect(w?.speaks).toBe(true);
  });

  test("a day reaches what constrains it, not every event on it", () => {
    const got = graph(freeze, lunch).walk(seedsOf("schedule the release", [], ["2026-10-29"], []), opt);
    expect(got.map((x) => x.id)).toEqual([freeze.id]);
    expect(got[0]!.named).toBe(false);
  });

  test("an expiry constrains every day after it; a long span is kept whole", () => {
    const passport = item(
      "drive:p",
      "Household IDs",
      "Robin's passport expires 2 Nov 2026. Driving licence renewed 2024.",
    );
    const freezeLong = item(
      "gmail:f",
      "Headcount",
      "We're pausing all net-new headcount from 19 Oct until Q1 planning.",
    );
    const g = graph(passport, freezeLong);
    const late = g.walk(seedsOf("find me flights", [], ["2026-11-21"], []), opt).map((x) => x.id);
    expect(late).toContain(passport.id);
    expect(late).toContain(freezeLong.id);
    // Before the expiry the passport binds nothing.
    expect(g.walk(seedsOf("find me flights", [], ["2026-10-30"], []), opt).map((x) => x.id)).not.toContain(passport.id);
  });

  test("the user's own name, addresses and organisation are kept out of a walk", () => {
    const mine = item(
      "gmail:s",
      "Hi",
      "From: Robin Carter <robin@northwind.co>\n\nOffice closed on Friday 30 October.",
    );
    const g = graph(mine, ahmed);
    const seeds = [{ key: "n:robincarter", weight: 1 }];
    expect(g.walk(seeds, opt).length).toBeGreaterThan(0);
    expect(g.walk(seeds, { ...opt, exclude: g.around("n:robincarter") })).toEqual([]);
  });

  test("a notification is marked as sent by a system", () => {
    const jira = item("gmail:j", "[JIRA] WEB-131", "From: Jira <jira@northwind.atlassian.net>\n\nStatus: Blocked.");
    expect(extract(jira, at).automated).toBe(true);
    expect(extract(ahmed, at).automated).toBe(false);
  });

  test("a word of an unknown longer name seeds only its own items, not the people it may be", () => {
    const g = graph(item("gmail:a", "Lunch?", "From: Sam Patel <sam.patel@northwind.co>\n\nLunch?"));
    // "Sam Ortiz" is no node: "Sam" seeds what names "Sam" itself, weakly, and is not taken to be Sam Patel.
    const got = g.walk(seedsOf("New email from Sam Ortiz", ["Sam Ortiz"], [], []), opt);
    expect(got.every((x) => !x.via.includes("Sam Patel") && x.score < 0.5)).toBe(true);
  });

  test("a first name two people go by stands for each only in part", () => {
    const a = item("gmail:a", "Lunch?", "From: Sam Patel <sam.patel@northwind.co>\n\nLunch?");
    const b = item("gmail:b", "Trip", "From: Sam Ortiz <sam@ortiz.me>\n\nTrip?");
    const one = graph(a).walk(seedsOf("ask Sam", [], [], []).concat([{ key: "n:sam", weight: 1 }]), opt)[0]!;
    const two = graph(a, b).walk([{ key: "n:sam", weight: 1 }], opt);
    expect(two.find((x) => x.id === a.id)!.score).toBeLessThanOrEqual(one.score);
  });

  test("removing an item removes its edges, links and orphan nodes", () => {
    const g = graph(ahmed, hold);
    g.remove(ahmed.id);
    g.remove(hold.id);
    expect(g.size).toBe(0);
  });

  test("the walk stops at its time bound", () => {
    const g = new UserGraph();
    for (let k = 0; k < 2_000; k++) {
      g.add(item(`gmail:x${k}`, `Thread ${k}`, `From: Pat Lee <pat@acme.com>\n\nAcme Corp and Globex ${k}`), at);
    }
    const t0 = performance.now();
    g.walk([{ key: "n:patlee", weight: 1 }], { budgetMs: 0, limit: 10, floor: 0 });
    expect(performance.now() - t0).toBeLessThan(50);
  });

  test("learning raises the weight of edge types that reached used items, and lowers unused ones", () => {
    const g = new UserGraph();
    const before = g.factor(EDGE.member);
    for (let k = 0; k < 10; k++) g.learn(1 << EDGE.member, true);
    for (let k = 0; k < 10; k++) g.learn(1 << EDGE.ref, false);
    expect(g.factor(EDGE.member)).toBeGreaterThan(before);
    expect(g.factor(EDGE.ref)).toBeLessThan(before);
  });
});

describe("ItemCache graph", () => {
  const u = { tenantId: "t", userId: "u" };
  const v = { tenantId: "t", userId: "v" };
  const seeds = seedsOf("Reply to Ahmed Hassan", ["Ahmed Hassan"], [], []);

  test("per user: one user's items are never reached from another's walk", () => {
    const cache = new ItemCache();
    cache.enableGraph();
    cache.put(u, [ahmed, hold], at);
    cache.put(v, [item("gmail:z", "Hello", "From: Zed Q <zed@zz.com>\n\nhi")], at);
    expect(cache.walk(u, seeds, opt, at).map((x) => x.id)).toContain(hold.id);
    expect(cache.walk(v, seeds, opt, at)).toEqual([]);
    expect(cache.walk({ tenantId: "t2", userId: "u" }, seeds, opt, at)).toEqual([]);
  });

  test("dropped with the items: forgetting a source or the user empties what it held", () => {
    const cache = new ItemCache();
    cache.enableGraph();
    cache.put(u, [ahmed, hold], at);
    cache.put(v, [ahmed, hold], at);
    expect(cache.graphSize(u)).toBeGreaterThan(0);
    cache.forget(u, "slack");
    expect(cache.walk(u, seeds, opt, at).map((x) => x.id)).not.toContain(hold.id);
    cache.forget(u);
    expect(cache.graphSize(u)).toBe(0);
    // The other user's graph is untouched.
    expect(cache.walk(v, seeds, opt, at).map((x) => x.id)).toContain(hold.id);
  });

  test("expired items are swept from the graph", () => {
    const cache = new ItemCache({ ttlMs: 1_000 });
    cache.enableGraph();
    cache.put(u, [ahmed, hold], at);
    expect(cache.graphSize(u)).toBeGreaterThan(0);
    cache.put(u, [], at + 5_000);
    expect(cache.graphSize(u)).toBe(0);
  });

  test("off by default: no graph is kept", () => {
    const cache = new ItemCache();
    cache.put(u, [ahmed, hold], at);
    expect(cache.walk(u, seeds, opt, at)).toEqual([]);
    expect(cache.graphSize(u)).toBe(0);
  });

  test("text is stored redacted: a secret in an item never becomes a node", () => {
    const cache = new ItemCache();
    cache.enableGraph();
    const key = "AKIAFHGJT7RTABDESOXD";
    cache.put(
      u,
      [item("gmail:k", "AWS access", `From: Dana Whitfield <dana@northwind.co>\n\nKey ${key} for AKIA use`)],
      at,
    );
    const g = (cache as unknown as { users: Map<string, { graph: UserGraph }> }).users.values().next().value!.graph;
    expect(g.keys().some((k) => k.includes(key.toLowerCase()))).toBe(false);
  });
});

describe("hostile input", () => {
  const time = (f: () => void) => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  const cases: [string, string][] = [
    ["capitals", "A ".repeat(200_000)],
    ["letters", "a".repeat(400_000)],
    ["no at", `${"a.".repeat(100_000)}`],
    ["at signs", "a@".repeat(100_000)],
    ["names before an address", `${"Ab ".repeat(50_000)}x@y.com`],
    ["speakers", "[09:14] Ab Cd: ".repeat(30_000)],
    ["ids", "INV-1234 ".repeat(50_000)],
    ["iban", "GB82 WEST 1234 5698 7654 32 ".repeat(20_000)],
    ["roles", "(your manager) ".repeat(30_000)],
    ["headers", "From: ".repeat(60_000)],
    ["dates", "on leave from 1 Nov to 3 Nov ".repeat(20_000)],
  ];
  for (const [name, text] of cases) {
    test(`extract stays linear: ${name}`, () => {
      const it = item("gmail:h", text.slice(0, 600), text, { people: text.slice(0, 5_000) });
      expect(time(() => extract(it, at))).toBeLessThan(250);
      expect(time(() => seedsOf(text, [text.slice(0, 80)], [], []))).toBeLessThan(250);
    });
  }
});

describe("partner with graph", () => {
  const scope = { tenantId: "t", userId: "u" };
  const engine = (config: Record<string, unknown>) => {
    const cache = new ItemCache();
    const p = new ContextPartner({
      sources: async () => [new StaticSource("gmail", "Mail", [])],
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(),
      model: null,
      now: () => at,
      // Nothing is sure on its words alone (the fast path would deliver Ahmed's own mail): the grounds decide.
      config: {
        ...CORE_CONFIG,
        confidentScore: 99,
        probes: true,
        groundConflict: true,
        quietNameOnly: true,
        ...config,
      },
    });
    // What Eden has already read of the user's sources (an earlier sync).
    cache.put(scope, [ahmed, hold, lunch], at);
    return p;
  };
  const say = async (p: ContextPartner, text: string) => {
    const r = await p.observe({ ...scope, sessionId: "s", at, kind: "user_message", text } as AgentEvent, {
      waitMs: 1_000,
    });
    return [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId: "s" })];
  };
  const ask = "Reply to Ahmed Hassan and tell them we'll ship the SSO integration next month.";

  test("the constraint reached through Ahmed's organisation is delivered with no model; off, it is not", async () => {
    const on = await say(engine({ graph: true }), ask);
    expect(on.flatMap((i) => i.citations.map((c) => c.itemId))).toEqual([hold.id]);
    expect(on[0]!.reason.startsWith("grounded-graph")).toBe(true);
    const off = await say(engine({}), ask);
    expect(off.flatMap((i) => i.citations.map((c) => c.itemId))).not.toContain(hold.id);
  });

  test("with quietNameOnly, a question that only names Ahmed is not grounded through him", async () => {
    const got = await say(engine({ graph: true }), "what did Ahmed Hassan think of the pricing page?");
    expect(got.flatMap((i) => i.citations.map((c) => c.itemId))).not.toContain(hold.id);
  });
});

/**
 * The graph's storage before D169 (a `GNode` object per node with its own `Int32Array`s, `Map`s from key to id and
 * from item id to slot), kept verbatim as a reference for the struct-of-arrays storage: walks, `has`, `around`, `keys`
 * and `size` must be the same through random adds, changed copies, removes, learning and bounds. Its constants are
 * kg.ts's.
 */
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
const HUB = 400;
const MAX_LINKS = 64;
const LINK_HOPS = 2;
const HOP_DECAY = 0.6;
const MAX_NODES = 120_000;
const AUTOMATED_FLAG = 1;
const BOUND_FLAG = 2;
const MASK_BITS = N_TYPES;
const MASK = (1 << MASK_BITS) - 1;
/** Item slots and node ids stay below this, so a packed word stays a positive 32-bit integer. */
const MAX_INDEX = 1 << (31 - MASK_BITS);
/** In an item's placed links: the link went on both nodes (else only the first's: the second was full). */
const BOTH = 1 << MASK_BITS;
const EMPTY = new Int32Array(0);
const KINDS: Record<string, NodeKind> = { n: "name", e: "email", i: "id", c: "channel", r: "role", d: "day" };
const ALIAS = bit("alias");
const CONSTRAINS = bit("constrains");

class GNode {
  /**
   * Whether the node is in the graph. A node out of it keeps its id (and key) while a link or an item's author still
   * names it, so a key never has two ids and an id never two keys.
   */
  live = false;
  /** Its items: (item slot << MASK_BITS | edge mask), in the order they came; `ni` used. */
  items: Int32Array = EMPTY;
  ni = 0;
  /** Its links to other nodes: pairs (node id << MASK_BITS | mask, items stating it), in the order they came. */
  links: Int32Array = EMPTY;
  /** Links used (pairs). A link is kept while some item still states it. */
  nl = 0;
  /** Links on other nodes and items' authors that name this node's id. */
  refs = 0;
  /** The node's name as first seen written (for ties): "Umbrella Health", "inv-7174", "#legal", "2026-10-29". */
  label: string;
  kind: NodeKind;
  readonly key: string;
  constructor(key: string, kind: NodeKind, label: string) {
    this.key = key;
    this.kind = kind;
    this.label = label;
  }
}

/** Scratch for `add` (one graph is built at a time: no await inside). */
const scratchNodes: number[] = [];
const scratchLinks: number[] = [];
const scratchAuthors: number[] = [];

/** `xs` with room for `n` more words, doubled when full. */
function room(xs: Int32Array, used: number, n: number): Int32Array {
  if (used + n <= xs.length) return xs;
  const grown = new Int32Array(Math.max(4, xs.length * 2, used + n));
  grown.set(xs.subarray(0, used));
  return grown;
}

/** `xs` halved when at most a quarter is used (an item churned off a busy node gives its room back). */
function shrink(xs: Int32Array, used: number): Int32Array {
  return xs.length > 8 && used <= xs.length >> 2 ? xs.slice(0, xs.length >> 1) : xs;
}

/** One user's graph. Held by the user's cache entry (`ItemCache`), so it is keyed, bounded and dropped with it. */
class PreviousGraph {
  /** Node key → id, for every node in the graph and every id still named (`GNode.live`). */
  private readonly ids = new Map<string, number>();
  private readonly nodeAt: (GNode | undefined)[] = [];
  private readonly freeIds: number[] = [];
  private liveNodes = 0;
  /** Item id → slot, and per slot: the id, what it placed, its flags (`AUTOMATED_FLAG`, `BOUND_FLAG`). */
  private readonly slots = new Map<string, number>();
  private readonly itemAt: (string | undefined)[] = [];
  /**
   * What each item placed, to take it out again: [nodes n, links n, its node ids…, its links as (a, b, mask | BOTH)
   * triples…, its authors' node ids (From, organiser, owner, chat speaker)…].
   */
  private readonly placedAt: (Int32Array | undefined)[] = [];
  private flags = new Uint8Array(64);
  private readonly freeSlots: number[] = [];
  /** Items with long spans (`Extraction.long`), by slot, scanned by a walk from days: at most one entry an item. */
  private readonly long = new Map<number, { from: string; to: string }[]>();
  /**
   * Sentences and people read lately (`parseSentence`, `parsePerson`, at most `MEMO_SENTENCES` each): emptied whenever
   * an item leaves, so it never holds what only an item the graph no longer holds said.
   */
  private readonly memo: Memo = { sentences: new Map(), people: new Map() };
  /** Learned evidence per edge type: Beta(alpha, beta) of "an item reached by this type was delivered and used". */
  private readonly alpha = new Float64Array(N_TYPES).fill(2);
  private readonly beta = new Float64Array(N_TYPES).fill(2);

  /** `maxIds`: node ids held at most (`MAX_INDEX`; a test passes fewer to reach the bound). */
  constructor(private readonly maxIds = MAX_INDEX) {}

  get size(): number {
    return this.liveNodes;
  }

  /** Whether a node exists (for tests and for seeding only names the user's items know). */
  has(key: string): boolean {
    return this.liveId(key) >= 0;
  }

  /** The keys of the nodes in the graph (for tests). */
  keys(): string[] {
    const out: string[] = [];
    for (const n of this.nodeAt) if (n?.live) out.push(n.key);
    return out;
  }

  /** A node's id when it is in the graph, else -1. */
  private liveId(key: string): number {
    const id = this.ids.get(key);
    return id !== undefined && this.nodeAt[id]!.live ? id : -1;
  }

  /** The id of `key`, made (out of the graph) if it has none. */
  private intern(key: string, kind: NodeKind, label: string): number {
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const id = this.freeIds.pop() ?? this.nodeAt.length;
    this.nodeAt[id] = new GNode(key, kind, label);
    this.ids.set(key, id);
    return id;
  }

  /** Frees an id that is out of the graph and named by nothing. */
  private release(id: number): void {
    const node = this.nodeAt[id]!;
    if (node.live || node.refs > 0) return;
    this.ids.delete(node.key);
    this.nodeAt[id] = undefined;
    this.freeIds.push(id);
  }

  /** Takes a node out of the graph when nothing holds it: no item and no link. */
  private settle(id: number): void {
    const node = this.nodeAt[id];
    if (!node?.live || node.ni > 0 || node.nl > 0) return;
    node.live = false;
    this.liveNodes--;
    this.release(id);
  }

  /** Puts an item in the graph, replacing what an earlier copy of it put there. */
  add(item: ContextItem, now: number): void {
    const x = extract(item, now, this.memo);
    // A packed word must stay an int32: ids in use and every id this item could intern (its nodes, and its authors,
    // which neither `MAX_NODES` nor `MAX_NODES_PER_ITEM` bounds) stay under `maxIds`, slots under `MAX_INDEX`. Checked
    // before an earlier copy leaves: a copy refused here leaves the one held.
    if (this.nodeAt.length - this.freeIds.length + x.nodes.size + x.authors.length > this.maxIds) return;
    const replacing = this.slots.has(item.id);
    if (!replacing && this.freeSlots.length === 0 && this.itemAt.length >= MAX_INDEX) return;
    if (replacing) this.remove(item.id);
    const slot = this.freeSlots.pop() ?? this.itemAt.length;
    const nodes = scratchNodes;
    const links = scratchLinks;
    const authors = scratchAuthors;
    nodes.length = links.length = authors.length = 0;
    for (const [key, n] of x.nodes) {
      let id = this.ids.get(key);
      let node = id === undefined ? undefined : this.nodeAt[id]!;
      if (!node?.live) {
        if (this.liveNodes >= MAX_NODES) continue;
        id ??= this.intern(key, n.kind, n.label);
        node = this.nodeAt[id]!;
        node.kind = n.kind;
        node.label = n.label;
        node.live = true;
        this.liveNodes++;
      } else if (n.kind === "name" && /\s/.test(n.label) && !/\s/.test(node.label)) node.label = n.label;
      node.items = room(node.items, node.ni, 1);
      node.items[node.ni++] = (slot << MASK_BITS) | n.mask;
      nodes.push(id!);
    }
    for (const [a, b, mask] of x.links) {
      const ia = this.liveId(a);
      const ib = this.liveId(b);
      if (ia < 0 || ib < 0 || !this.bump(ia, ib, mask)) continue;
      links.push(ia, ib, this.bump(ib, ia, mask) ? mask | BOTH : mask);
    }
    for (const k of x.authors) {
      const id = this.intern(k, KINDS[k[0]!] ?? "name", "");
      this.nodeAt[id]!.refs++;
      authors.push(id);
    }
    const placed = new Int32Array(2 + nodes.length + links.length + authors.length);
    placed[0] = nodes.length;
    placed[1] = links.length / 3;
    placed.set(nodes, 2);
    placed.set(links, 2 + nodes.length);
    placed.set(authors, 2 + nodes.length + links.length);
    if (slot >= this.flags.length) {
      const grown = new Uint8Array(this.flags.length * 2);
      grown.set(this.flags);
      this.flags = grown;
    }
    this.flags[slot] = (x.automated ? AUTOMATED_FLAG : 0) | (x.bound ? BOUND_FLAG : 0);
    this.slots.set(item.id, slot);
    this.itemAt[slot] = item.id;
    this.placedAt[slot] = placed;
    if (x.long.length > 0) this.long.set(slot, x.long);
  }

  /** Adds one statement of a link from one node to another; false when the first is full (then nothing is added). */
  private bump(from: number, to: number, mask: number): boolean {
    const node = this.nodeAt[from]!;
    const l = node.links;
    for (let k = 0; k < node.nl * 2; k += 2) {
      if (l[k]! >> MASK_BITS !== to) continue;
      l[k]! |= mask;
      l[k + 1]!++;
      return true;
    }
    if (node.nl >= MAX_LINKS) return false;
    node.links = room(l, node.nl * 2, 2);
    node.links[node.nl * 2] = (to << MASK_BITS) | mask;
    node.links[node.nl * 2 + 1] = 1;
    node.nl++;
    this.nodeAt[to]!.refs++;
    return true;
  }

  /** Takes back one statement of a link from one node to another; the link goes with its last statement. */
  private unbump(from: number, to: number): void {
    const node = this.nodeAt[from]!;
    const l = node.links;
    for (let k = 0; k < node.nl * 2; k += 2) {
      if (l[k]! >> MASK_BITS !== to) continue;
      if (--l[k + 1]! > 0) return;
      l.copyWithin(k, k + 2, node.nl * 2);
      node.nl--;
      node.links = shrink(l, node.nl * 2);
      this.nodeAt[to]!.refs--;
      this.release(to);
      return;
    }
  }

  /** Takes an item out: its edges, the links it stated, and nodes nothing else holds. */
  remove(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    const p = this.placedAt[slot]!;
    this.memo.sentences.clear();
    this.memo.people.clear();
    this.slots.delete(id);
    this.long.delete(slot);
    this.itemAt[slot] = undefined;
    this.placedAt[slot] = undefined;
    this.freeSlots.push(slot);
    const nodesEnd = 2 + p[0]!;
    const linksEnd = nodesEnd + p[1]! * 3;
    for (let k = nodesEnd; k < linksEnd; k += 3) {
      this.unbump(p[k]!, p[k + 1]!);
      if (p[k + 2]! & BOTH) this.unbump(p[k + 1]!, p[k]!);
    }
    for (let k = 2; k < nodesEnd; k++) {
      const node = this.nodeAt[p[k]!]!;
      const xs = node.items;
      for (let i = 0; i < node.ni; i++) {
        if (xs[i]! >> MASK_BITS !== slot) continue;
        xs.copyWithin(i, i + 1, node.ni);
        node.ni--;
        node.items = shrink(xs, node.ni);
        break;
      }
      this.settle(p[k]!);
    }
    // A node kept only by a link whose last item just left: gone with it.
    for (let k = nodesEnd; k < linksEnd; k += 3) {
      this.settle(p[k]!);
      this.settle(p[k + 1]!);
    }
    for (let k = linksEnd; k < p.length; k++) {
      this.nodeAt[p[k]!]!.refs--;
      this.release(p[k]!);
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
    if (mask & CONSTRAINS) best = Math.max(best, 0.5) * (1 + PRIOR.constrains * this.factor(EDGE.constrains));
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
    const act = new Map<number, { a: number; origin: string }>();
    const isSeed = new Set<number>();
    const banned = new Set<number>();
    for (const k of opt.exclude ?? []) {
      const id = this.ids.get(k);
      if (id !== undefined) banned.add(id);
    }
    for (const s of seeds) {
      const id = this.liveId(s.key);
      if (id < 0 || banned.has(id) || (act.get(id)?.a ?? 0) >= s.weight) continue;
      if (s.parent && this.has(s.parent)) continue;
      act.set(id, { a: s.weight, origin: s.key });
      isSeed.add(id);
    }
    /** Nodes one link from a seed whose seed is no hub: their items' authors speak for what the request names. */
    const near = new Set<number>(isSeed);
    // Two hops of links: a first name to the person, the person to their organisation ("Ingrid" to Ingrid Berg to
    // Globex), each hop weaker.
    // A word of a longer name seeds its own items only: "Sam" of an unknown "Sam Ortiz" is not every Sam.
    const words = new Set(seeds.filter((s) => s.parent).map((s) => s.key));
    let frontier = [...isSeed].filter((id) => !words.has(this.nodeAt[id]!.key));
    for (let hop = 1; hop <= LINK_HOPS && frontier.length > 0; hop++) {
      const next: number[] = [];
      for (const key of frontier) {
        const node = this.nodeAt[key]!;
        const from = act.get(key)!;
        // A person's few links (addresses, first name, organisation) each carry them whole; an organisation's many
        // people share its activation.
        const fan = node.nl > 12 ? Math.sqrt(node.nl) : 1;
        for (let k = 0; k < node.nl * 2; k += 2) {
          if (late()) break;
          const other = node.links[k]! >> MASK_BITS;
          const mask = node.links[k]! & MASK;
          // A first name several people go by stands for each of them only in part ("Sam": Sam Patel or Sam Ortiz).
          const shared = mask & ALIAS ? Math.max(1, this.peopleCalled(key), this.peopleCalled(other)) : 1;
          const w = ((from.a * this.weightOf(mask)) / fan / shared) * (hop === 1 ? 1 : HOP_DECAY);
          if (banned.has(other)) continue;
          if (w > (act.get(other)?.a ?? 0)) {
            if (!act.has(other)) next.push(other);
            act.set(other, { a: w, origin: from.origin });
          }
          // The seed's own names and addresses, or the person a role names: their items speak for the seed. An
          // organisation's members do not each speak for what the request asks of it.
          if (hop === 1 && mask & ALIAS && node.nl <= 12 && node.ni <= HUB) near.add(other);
        }
      }
      frontier = next.filter((id) => this.nodeAt[id]?.live);
    }
    // An item's score from one seed is the best of the nodes that seed reached it through (a person's name, address
    // and first name are one person, not three votes); its scores from different seeds add up. Keyed by item slot.
    const best = new Map<number, Map<string, number>>();
    const masks = new Map<number, number>();
    const via = new Map<number, string[]>();
    const viaName = new Set<number>();
    const binding = new Set<number>();
    const byRef = new Set<number>();
    for (const [key, { a, origin }] of act) {
      if (late()) break;
      const node = this.nodeAt[key];
      if (!node?.live || node.ni > HUB) continue;
      const spread = a / Math.log2(2 + node.ni);
      const reached = isSeed.has(key) ? 0 : this.linkMask(key, isSeed);
      for (let k = 0; k < node.ni; k++) {
        const slot = node.items[k]! >> MASK_BITS;
        const mask = node.items[k]! & MASK;
        if (node.kind === "day" && !(mask & CONSTRAINS)) continue;
        const s = spread * this.weightOf(mask);
        const per = best.get(slot) ?? new Map<string, number>();
        if (s > (per.get(origin) ?? 0)) per.set(origin, s);
        best.set(slot, per);
        masks.set(slot, (masks.get(slot) ?? 0) | mask | reached);
        const v = via.get(slot) ?? [];
        if (v.length < 6 && !v.includes(node.label)) v.push(node.label);
        via.set(slot, v);
        if (node.kind !== "day") viaName.add(slot);
        if (mask & CONSTRAINS) binding.add(slot);
        if (node.kind === "id" && isSeed.has(key)) byRef.add(slot);
      }
    }
    // Days a long span covers: the items holding such spans, scanned (one per cached item at most), each covering
    // span's spread divided like a day node's by how many cover the day.
    for (const s of seeds) {
      if (!s.key.startsWith("d:") || this.long.size === 0) continue;
      const day = s.key.slice(2);
      const covering: number[] = [];
      for (const [slot, spans] of this.long) {
        if (late()) break;
        if (spans.some((sp) => sp.from <= day && day <= sp.to)) covering.push(slot);
      }
      const spread = (s.weight / Math.log2(2 + covering.length)) * this.weightOf(CONSTRAINS);
      for (const slot of covering) {
        const per = best.get(slot) ?? new Map<string, number>();
        if (spread > (per.get(s.key) ?? 0)) per.set(s.key, spread);
        best.set(slot, per);
        masks.set(slot, (masks.get(slot) ?? 0) | CONSTRAINS);
        const v = via.get(slot) ?? [];
        if (v.length < 6 && !v.includes(day)) v.push(day);
        via.set(slot, v);
        binding.add(slot);
      }
    }
    const out: Walked[] = [];
    for (const [slot, per] of best) {
      let s = 0;
      for (const x of per.values()) s += x;
      if (s < opt.floor) continue;
      const p = this.placedAt[slot]!;
      let speaks = false;
      for (let k = 2 + p[0]! + p[1]! * 3; k < p.length && !speaks; k++) speaks = near.has(p[k]!);
      const flags = this.flags[slot]!;
      out.push({
        id: this.itemAt[slot]!,
        score: s,
        mask: masks.get(slot)!,
        via: via.get(slot)!,
        speaks,
        named: viaName.has(slot),
        binds: binding.has(slot) || (flags & BOUND_FLAG) !== 0,
        automated: (flags & AUTOMATED_FLAG) !== 0,
        byRef: byRef.has(slot),
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
    const id = this.liveId(key);
    if (id < 0) return out;
    out.add(key);
    const node = this.nodeAt[id]!;
    for (let k = 0; k < node.nl * 2; k += 2) {
      if (node.links[k]! & (ALIAS | bit("member"))) out.add(this.nodeAt[node.links[k]! >> MASK_BITS]!.key);
    }
    return out;
  }

  /** For a one-word name (a first name), how many people go by it: its alias links to other names; else 0. */
  private peopleCalled(id: number): number {
    const node = this.nodeAt[id];
    if (!node?.live || node.kind !== "name" || /\s/.test(node.label)) return 0;
    let n = 0;
    for (let k = 0; k < node.nl * 2; k += 2) {
      if (node.links[k]! & ALIAS && this.nodeAt[node.links[k]! >> MASK_BITS]!.key.startsWith("n:")) n++;
    }
    return n;
  }

  /** The link types by which a non-seed node was reached from the seeds (for learning). */
  private linkMask(id: number, seeds: Set<number>): number {
    let mask = 0;
    const node = this.nodeAt[id];
    if (!node?.live) return 0;
    for (let k = 0; k < node.nl * 2; k += 2) if (seeds.has(node.links[k]! >> MASK_BITS)) mask |= node.links[k]! & MASK;
    return mask;
  }
}

/** A seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Names in several scripts (Latin-1, Latin Extended, Greek, CJK, an astral letter, a lone surrogate), case variants
 * of one name, organisations, lines that bind and lines that do not.
 */
const FIRST = ["Ahmed", "Łukasz", "Søren", "Ingrid", "Sam", "ÉLODIE", "Élodie", "Δήμητρα", "张伟", "𝒜da", "Bo", "Zoë"];
const LAST = ["Hassan", "Nowak", "Berg", "García", "Ortiz", "Patel", "Kowalczyk", "Ng", "O’Neil", "Lee"];
const ORGS = ["umbrellahealth", "globex", "hooli", "initech", "wayneanalytics", "northwind", "gmail"];
const LINES = [
  "Reminder: do not commit delivery dates to Umbrella Health until the MSA is countersigned.",
  "No production changes from Wednesday 28 October to Tuesday 3 November.",
  "INV-7174 is on hold until finance approves it.",
  "Mark (your manager) wants the Globex numbers by Friday.",
  "Passport expires 2 Nov, so the Hooli trip moves.",
  "Pausing headcount from 19 Oct until further notice.",
  "Looks good to me, thanks!",
  "Ask Robert Haddad (Legal) before sending the SOW-9597 draft.",
  "The IBAN is GB82 WEST 1234 5698 7654 32 for the Initech invoice.",
  "Lunch at Dishoom, King's Cross.",
  "Ταξίδι στην Αθήνα με τη Δήμητρα Παπαδοπούλου.",
  "会议 张伟 北京 Initech 合同.",
  "Broken pair \ud800 near Søren Berg and \udc00 there.",
  "I'm fully offline from Mon 26 Oct until 4 Jan.",
];

function makeItem(r: () => number, id: string, crowd: number): ContextItem {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const person = () => {
    // A crowd of people at one organisation makes nodes full of links (`MAX_LINKS`).
    const many = r() < crowd;
    const first = many ? `Crowd${Math.floor(r() * 120)}` : pick(FIRST);
    const last = pick(LAST);
    const org = many ? "hooli" : pick(ORGS);
    const roll = r();
    // Long addresses too (a key longer than the graph's character arena holds when it is interned, D169's bug).
    const local =
      roll < 0.1
        ? "no-reply"
        : roll < 0.15
          ? `notifications-noreply-${"x".repeat(Math.floor(r() * 90))}`
          : `${first.toLowerCase()}.${last.toLowerCase()}`.replace(/[^\w.]/g, "x");
    return `${first} ${last} <${local}@${org}.com>`;
  };
  const lines: string[] = [`From: ${person()}`];
  if (r() < 0.6) lines.push(`To: ${person()}, ${person()}`);
  lines.push("");
  const n = 1 + Math.floor(r() * 4);
  for (let k = 0; k < n; k++) lines.push(r() < 0.3 ? `[09:${10 + k}] ${pick(FIRST)}: ${pick(LINES)}` : pick(LINES));
  if (r() < 0.1) lines.push(`Invoice INV-${String(Math.floor(r() * 1e9)).repeat(1 + Math.floor(r() * 6))} is due.`);
  const chat = r() < 0.25;
  const title = chat
    ? `#${pick(["legal", "team", "ops"])}: ${pick(FIRST)}`
    : `${pick(ORGS)} ${pick(LINES).slice(0, 30)}`;
  const meta: Record<string, string> = {};
  if (r() < 0.2) meta.start = `2026-10-${20 + Math.floor(r() * 10)}T09:00:00.000Z`;
  if (r() < 0.1) meta.people = `${pick(FIRST)} ${pick(LAST)}; ${person()}`;
  const it = { id, sourceId: id.split(":")[0]!, ref: id, title, text: lines.join("\n") };
  return Object.keys(meta).length > 0 ? { ...it, meta } : it;
}

/** The keys one item names (read once per item: the checks below read a pool's many times). */
const namedBy = new WeakMap<ContextItem, string[]>();
/** Every key the items name (and some none does), for seeds, `has` and `around`. */
function keysOf(items: Iterable<ContextItem>): string[] {
  const keys = new Set<string>(["n:nobody", "d:2026-10-30", "d:2026-11-21", "r:manager", "r:legal", "i:inv-7174"]);
  for (const it of items) {
    let named = namedBy.get(it);
    if (!named) {
      const x = extract(it, at);
      named = [...x.nodes.keys(), ...x.links.flatMap(([a, b]) => [a, b]), ...x.authors];
      namedBy.set(it, named);
    }
    for (const k of named) keys.add(k);
  }
  return [...keys].sort();
}

function same(a: UserGraph, b: PreviousGraph, keys: string[], r: () => number): void {
  expect(a.size).toBe(b.size);
  expect(a.keys()).toEqual(b.keys());
  // (A sample of the keys: every one, on every check of 200 seeds, is slower than it finds more.)
  for (const k of keys.length <= 80 ? keys : keys.filter(() => r() < 80 / keys.length)) {
    expect(a.has(k)).toBe(b.has(k));
    expect([...a.around(k)]).toEqual([...b.around(k)]);
  }
  for (let s = 0; s < 12; s++) {
    const seeds: Seed[] = [];
    const n = 1 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const key = keys[Math.floor(r() * keys.length)]!;
      const parent = r() < 0.2 ? keys[Math.floor(r() * keys.length)] : undefined;
      seeds.push(parent ? { key, weight: 0.5, parent } : { key, weight: 0.5 + r() });
    }
    const exclude = r() < 0.3 ? new Set(keys.filter(() => r() < 0.05)) : undefined;
    const o: WalkOptions = { budgetMs: 1e9, limit: 30, floor: r() < 0.2 ? 0.3 : 0, ...(exclude ? { exclude } : {}) };
    expect(a.walk(seeds, o)).toEqual(b.walk(seeds, o));
  }
}

/**
 * Seeds of the differential test below: 200 (D169's gate) in `bun run check` and `test:pkg`; `test:changed` sets
 * KG_DIFF_SEEDS=25 (D176: about 2 s for the file instead of 6). Not EDEN_-prefixed: scripts/test-preload.ts clears
 * those. A value that is not a positive whole number reads as 200, so a typo can only run more seeds, never fewer.
 */
function diffSeeds(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && /^\s*\d+\s*$/.test(raw) && Number.isSafeInteger(n) && n >= 1 ? n : 200;
}
const DIFF_SEEDS = diffSeeds(process.env.KG_DIFF_SEEDS);

describe("UserGraph against the storage before D169", () => {
  test("the seed count reads KG_DIFF_SEEDS, and anything but a positive whole number is 200", () => {
    expect(diffSeeds(undefined)).toBe(200);
    expect(diffSeeds("25")).toBe(25);
    expect(diffSeeds(" 25 ")).toBe(25);
    for (const bad of ["", "0", "-5", "2.5", "abc", "1e3", "25x", "0x19", "99999999999999999999"]) {
      expect(diffSeeds(bad)).toBe(200);
    }
  });

  test(`${DIFF_SEEDS} seeds of adds, changed copies, removes, learning and bounds: the same walks`, () => {
    for (let seed = 1; seed <= DIFF_SEEDS; seed++) {
      const r = rng(seed);
      // Every eighth seed bounds the node ids, so copies are refused and the held one stays.
      const maxIds = seed % 8 === 0 ? 60 + Math.floor(r() * 200) : undefined;
      const a = new UserGraph(maxIds);
      const b = new PreviousGraph(maxIds);
      const pool = new Map<string, ContextItem>();
      const crowd = seed % 5 === 0 ? 0.6 : 0.1;
      const ids = 10 + Math.floor(r() * 80);
      const steps = 60 + Math.floor(r() * 80);
      for (let step = 0; step < steps; step++) {
        const roll = r();
        const id = `gmail:m${Math.floor(r() * ids)}`;
        if (roll < 0.65) {
          const it = makeItem(r, id, crowd);
          pool.set(id, it);
          a.add(it, at);
          b.add(it, at);
        } else if (roll < 0.9) {
          a.remove(id);
          b.remove(id);
        } else {
          const mask = Math.floor(r() * (1 << N_TYPES));
          const used = r() < 0.5;
          a.learn(mask, used);
          b.learn(mask, used);
        }
        if (step % 40 === 39) same(a, b, keysOf(pool.values()), r);
      }
      same(a, b, keysOf(pool.values()), r);
      // Everything out: nothing is left; then back in, read as new.
      for (const id of pool.keys()) {
        a.remove(id);
        b.remove(id);
      }
      expect(a.size).toBe(0);
      expect(a.keys()).toEqual([]);
      // (Every fourth seed: the re-add is the costliest step and finds the least.)
      if (seed % 4 !== 0) continue;
      for (const it of pool.values()) {
        a.add(it, at);
        b.add(it, at);
      }
      same(a, b, keysOf(pool.values()), r);
    }
  }, 60_000);

  test("a large graph churned to a few items: walks unchanged as the arenas compact and the tables shrink", () => {
    const r = rng(4242);
    const a = new UserGraph();
    const b = new PreviousGraph();
    const pool = new Map<string, ContextItem>();
    for (let k = 0; k < 3_000; k++) {
      const it = makeItem(r, `gmail:big${k}`, 0.3);
      pool.set(it.id, it);
      a.add(it, at);
      b.add(it, at);
    }
    same(a, b, keysOf(pool.values()), r);
    const words = (g: UserGraph) => {
      const x = g as unknown as Record<string, { w: { length: number } }>;
      return x.itemWords!.w.length + x.linkWords!.w.length + x.placedWords!.w.length + x.chars!.w.length;
    };
    const full = words(a);
    for (const id of [...pool.keys()].slice(0, 2_950)) {
      a.remove(id);
      b.remove(id);
      pool.delete(id);
    }
    same(a, b, keysOf(pool.values()), r);
    // What the graph no longer holds is given back (the arenas compact once most of them is free).
    expect(words(a)).toBeLessThan(full / 4);
    for (let k = 0; k < 500; k++) {
      const it = makeItem(r, `gmail:big${k}`, 0.3);
      pool.set(it.id, it);
      a.add(it, at);
      b.add(it, at);
    }
    same(a, b, keysOf(pool.values()), r);
  });

  /** `a` and `b` hold the same graph after `items`, and every key the items name is in `a` exactly as in `b`. */
  function sameAfter(a: UserGraph, b: PreviousGraph, items: ContextItem[]): string[] {
    for (const it of items) {
      a.add(it, at);
      b.add(it, at);
    }
    const keys = keysOf(items);
    same(a, b, keys, rng(7));
    for (const k of keys) expect(a.has(k)).toBe(b.has(k));
    return keys;
  }

  test("a fresh graph's first key longer than 32 characters is stored whole (the arena compacts as it is written)", () => {
    const cases = [
      item("gmail:a", "Hello", "From: X <bartholomewmaximilianfeather@gmail.com>\n\nSee you then."),
      item(
        "gmail:b",
        "Invoice INV-123456789012345678901234567890",
        "Invoice INV-123456789012345678901234567890 is due.",
      ),
      item("gmail:c", "Meeting with Bartholomew Maximilian Featherstonehaugh-Worthingtonshire", "Agenda attached."),
      item("gmail:d", "Hi", "From: <notifications-noreply@accounts.google.com>\n\nYour sign-in."),
    ];
    for (const it of cases) {
      const a = new UserGraph();
      const keys = sameAfter(a, new PreviousGraph(), [it]);
      const long = keys.filter((k) => k.length > 32 && a.has(k));
      expect(long.length).toBeGreaterThan(0);
      // (Read back whole: a truncated key would be written with zero code units in its tail.)
      for (const k of a.keys()) expect(k).not.toContain("\0");
    }
    expect(new UserGraph().has("x")).toBe(false);
    const g = new UserGraph();
    g.add(cases[0]!, at);
    expect(g.has("e:bartholomewmaximilianfeather@gmail.com")).toBe(true);
  });

  /** The longest address `EMAIL` reads (64 + 1 + 5 x 63 + 4 characters): `extract`'s longest key, 386 with "e:". */
  const longest = (c: string) =>
    `${c.repeat(64)}@${[1, 2, 3, 4, 5].map((k) => `${c}${k}`.repeat(32).slice(0, 63)).join(".")}`;

  test("a fresh graph's first key at extract's longest, and one past 1,000 characters, is stored whole", () => {
    const address = longest("q");
    const it = item("gmail:long", "Hello", `From: Ann Lee <${address}>\n\nSee you.`);
    const a = new UserGraph();
    sameAfter(a, new PreviousGraph(), [it]);
    expect(`e:${address}`.length).toBe(386);
    expect(a.keys()).toContain(`e:${address}`);
    expect(a.has(`e:${address}`)).toBe(true);
    // No item names a key this long (`extract` bounds every key, above), so it is interned directly: the arena's
    // first compaction (64 words) must still make room for all of it.
    const g = new UserGraph() as unknown as {
      intern(key: string, kind: string, label: string): number;
      keyOf(id: number): string;
      labelOf(id: number): string;
      idOf(key: string): number;
    };
    const key = `n:${"k".repeat(1_200)}`;
    const label = "L".repeat(1_500);
    const id = g.intern(key, "name", label);
    expect(g.keyOf(id)).toBe(key);
    expect(g.labelOf(id)).toBe(label);
    expect(g.idOf(key)).toBe(id);
  });

  test("an id reused after churn and interned with a key longer than the live characters is stored whole", () => {
    const r = rng(99);
    const a = new UserGraph();
    const b = new PreviousGraph();
    const pool: ContextItem[] = [];
    for (let k = 0; k < 400; k++) pool.push(makeItem(r, `gmail:c${k}`, 0.3));
    sameAfter(a, b, pool);
    // Everything out: the ids go back to the free list with stale offsets, and the character arena compacts.
    for (const it of pool) {
      a.remove(it.id);
      b.remove(it.id);
    }
    const chars = (a as unknown as { chars: { w: Uint16Array; top: number; dead: number } }).chars;
    // The key outgrows both the characters still live and the room left, so writing it compacts the arena.
    expect(chars.top - chars.dead).toBeLessThan(386);
    expect(chars.w.length - chars.top).toBeLessThan(386);
    const before = chars.w;
    const address = longest("z");
    const long = item("gmail:late", "Hello", `From: Bo Ng <${address}>\n\nAsk Ingrid García.`);
    sameAfter(a, b, [long]);
    expect(chars.w).not.toBe(before);
    sameAfter(a, b, [makeItem(r, "gmail:after", 0.3), pool[0]!]);
    expect(a.has(`e:${address}`)).toBe(true);
    for (const k of a.keys()) expect(k).not.toContain("\0");
  });

  test("labels are copied out of the item text: a long text is not kept alive by its nodes", () => {
    const g = new UserGraph();
    const filler = "x".repeat(200_000);
    g.add(item("gmail:t", "Status", `Ingrid García approved it. ${filler}`), at);
    // Every key and label is in the graph's own character arena, which holds far less than the text.
    const chars = (g as unknown as { chars: { w: Uint16Array } }).chars.w;
    expect(chars.length).toBeLessThan(1_000);
    expect(g.walk([{ key: "n:ingridgarcía", weight: 1 }], opt)[0]?.via).toEqual(["Ingrid García"]);
  });
});
