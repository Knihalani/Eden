import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { StaticSource, type StaticDoc } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { isImperative } from "./probes";

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const mail = (from: string, body: string) =>
  `From: ${from} <${from.toLowerCase().replace(" ", ".")}@example.com>\nTo: Robin Carter <robin@northwind.co>\n\n${body}`;

/** The user's sources: Leila's lunch and her mail, an invoice from a company, a friend's allergy. */
const DOCS: StaticDoc[] = [
  {
    ref: "lunch",
    title: "Lunch with Leila Haddad",
    text: "When: Thursday 29 Oct 2026, 13:00\nWhere: Hoppers, London\nAttendees: Robin Carter, Leila Haddad",
    meta: { start: "2026-10-29T13:00:00Z", people: "Robin Carter; Leila Haddad" },
  },
  { ref: "catch", title: "Catching up", text: mail("Leila Haddad", "Lovely to see you, Leila Haddad here again!") },
  {
    ref: "inv",
    title: "Invoice INV-5842 from Pied Piper",
    text: mail("Gavin Belson", "Please find attached invoice INV-5842 for £4,000 from Pied Piper, due 5 Nov."),
  },
  { ref: "allergy", title: "Sam Patel", text: mail("Sam Patel", "Reminder: Sam Patel is allergic to shellfish.") },
];

async function run(config: Record<string, unknown>, text: string, docs = DOCS): Promise<Record<string, string[]>> {
  const p = new ContextPartner({
    sources: async () => [new StaticSource("mail", "Mail", docs)],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { probes: true, probeGraceMs: 1_000, confidentScore: 0.1, minMatchedTerms: 1, ...config },
  });
  const out: Record<string, string[]> = {};
  for (const userId of ["u1", "u2"]) {
    const scope = { tenantId: "t", userId };
    const event = { ...scope, sessionId: "s", at: NOW, kind: "user_message", text } as AgentEvent;
    const r = await p.observe(event, { waitMs: 1_000 });
    out[userId] = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId: "s" })].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
  }
  return out;
}

describe("quietNameOnly: a tie by a person's name alone is not pushed with no model", () => {
  test("a passing mention of someone is delivered without the flag and held back with it", async () => {
    const text = "Leila Haddad says hi by the way";
    expect((await run({}, text)).u1?.length).toBeGreaterThan(0);
    expect(await run({ quietNameOnly: true }, text)).toEqual({ u1: [], u2: [] });
  });

  test("a request about something of theirs still is: the item holds a word beyond the name", async () => {
    const got = await run({ quietNameOnly: true }, "Where is my lunch with Leila Haddad?");
    expect(got.u1).toContain("mail:lunch");
  });

  test("a company, place or project is not a person: its name alone still ties", async () => {
    const got = await run({ quietNameOnly: true }, "How much do we owe Pied Piper?");
    expect(got.u1).toEqual(["mail:inv"]);
  });

  test("a request to act on someone is a second ground: what bears on them bears on the act", async () => {
    const config = { quietNameOnly: true, groundConflict: true, confidentScore: 99, fallbackMatchedTerms: 0 };
    const got = await run(config, "Book a table for me and Sam Patel on Thursday evening");
    expect(got.u1).toEqual(["mail:allergy"]);
    // The same conflict for a mere mention of a dinner with them is tied by the name alone.
    const said = "Sam Patel and I had a lovely dinner on Thursday evening";
    expect((await run({ ...config, quietNameOnly: false }, said)).u1).toEqual(["mail:allergy"]);
    expect((await run(config, said)).u1).toEqual([]);
  });
});

describe("ItemCache.isPerson", () => {
  const item = (id: string, text: string, people?: string): ContextItem => ({
    id,
    sourceId: "mail",
    ref: id,
    title: id,
    text,
    ...(people ? { meta: { people } } : {}),
  });

  test("full names and first names of the user's parties; not a company; per user; forgotten with the user", () => {
    const cache = new ItemCache();
    const a = { tenantId: "t", userId: "a" };
    const b = { tenantId: "t", userId: "b" };
    cache.put(a, [item("m1", mail("Zoë Müller", "Hi"), "Zoë Müller; Robin Carter"), item("m2", "Pied Piper invoice")]);
    expect(cache.isPerson(a, "Zoë Müller")).toBe(true);
    expect(cache.isPerson(a, "zoë")).toBe(true);
    expect(cache.isPerson(a, "Pied Piper")).toBe(false);
    // Another user's parties say nothing of this one's.
    expect(cache.isPerson(b, "Zoë Müller")).toBe(false);
    cache.forget(a);
    expect(cache.isPerson(a, "Zoë Müller")).toBe(false);
  });

  test("the names follow the items: a party whose items are gone is no longer one", () => {
    const cache = new ItemCache();
    const a = { tenantId: "t", userId: "a" };
    cache.put(a, [item("m1", "x", "Al Chen; Robin Carter"), item("m2", "y", "Robin Carter")]);
    expect(cache.isPerson(a, "Al Chen")).toBe(true);
    cache.forget(a, "mail");
    cache.put(a, [item("m2", "y", "Robin Carter")]);
    expect(cache.isPerson(a, "Al Chen")).toBe(false);
  });
});

describe("isImperative", () => {
  test("the first word past an opener is a verb that acts", () => {
    expect(isImperative("Book a table for me and Sam")).toBe(true);
    expect(isImperative("please give Dana edit access")).toBe(true);
    expect(isImperative("Can you send Priya some flowers?")).toBe(true);
    expect(isImperative("Leila recommended a great book, what was it about again?")).toBe(false);
    expect(isImperative("haha Sam just sent me the funniest meme")).toBe(false);
    expect(isImperative("")).toBe(false);
  });

  test("linear on hostile input", () => {
    for (const text of [" ".repeat(1_000_000), "please ".repeat(200_000), `${"a".repeat(1_000_000)} book`]) {
      const t0 = performance.now();
      isImperative(text);
      expect(performance.now() - t0).toBeLessThan(300);
    }
  });
});
