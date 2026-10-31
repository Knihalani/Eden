import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { EDGE, extract, orgLabel, runsOf, seedsOf, tieWords, UserGraph } from "./kg";
import { ContextPartner } from "./partner";

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
    expect([...g.nodes.keys()].some((k) => k.includes(key.toLowerCase()))).toBe(false);
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
      config: { confidentScore: 99, probes: true, groundConflict: true, quietNameOnly: true, ...config },
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
