/**
 * D1970: the no-model paths' look-alike filter — an identifier number the request did not name, a year the request
 * has moved past, a qualifier tying its name to another organisation — and the asks fallback's multi-item bar.
 * Each case below delivered the look-alike or starved the asks before the change.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";

const T0 = Date.UTC(2026, 10, 10, 9); // Tuesday 10 November 2026, the clock the tests run on.

const partner = () =>
  new ContextPartner({
    sources: async () => [],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => T0,
  });

const item = (ref: string, title: string, text: string): ContextItem => ({
  id: itemId("mail", ref),
  sourceId: "mail",
  ref,
  title,
  text,
});
const scored = (item: ContextItem, score = 1, matched = 2) => ({ item, score, matched, sketch: null });
const cue = (raw: string, entities: string[] = [], days: string[] = []): any => ({
  id: "cue-t",
  raw,
  entities,
  time: days.length > 0 ? { days: new Set(days) } : null,
  at: T0,
  offset: 0,
  external: false,
});

describe("contradicts", () => {
  test("an item carrying a different identifier than the request's is dropped", () => {
    const p = partner() as any;
    const c = cue("Pay the Acme Logistics invoice 4471 today", ["Acme Logistics"], ["2026-11-10"]);
    const owed = scored(item("inv-4471", "Invoice 4471 from Acme Logistics", "Amount due 2,300 GBP"));
    const other = scored(item("inv-4390", "Invoice 4390 from Acme Logistics", "Paid in October"));
    expect(p.contradicts(owed, c, true)).toBe(false);
    expect(p.contradicts(other, c, true)).toBe(true);
  });

  test("a number followed by a measure word is a quantity, not an identifier", () => {
    const p = partner() as any;
    // The limit the request needs is 750, the requester's own number is a 650 GBP budget: no conflict.
    const c = cue("Book me a hotel in Berlin, about 650 GBP for the offsite");
    const fact = scored(item("exp", "Travel expenses policy", "Hotels are capped at 750 GBP a night"));
    expect(p.contradicts(fact, c, true)).toBe(false);
  });

  test("an item dated only in a year the request has moved past is dropped, but not by a future named day", () => {
    const p = partner() as any;
    const c = cue("Move my flight to Lisbon on 12 November to a morning slot", ["Lisbon"], ["2026-11-12"]);
    const old = scored(item("b-2025", "Your Lisbon booking, June 2025", "BA to Lisbon, June 2025"));
    const now = scored(item("b-2026", "Your Lisbon booking, 12 November 2026", "BA to Lisbon, 12 November 2026"));
    expect(p.contradicts(old, c, true)).toBe(true);
    expect(p.contradicts(now, c, true)).toBe(false);
    // A day ahead in the next year does not make this year's items stale.
    const ahead = cue("Extend my Delhi trip so I come back on 10 January instead", ["Delhi"], ["2027-01-10"]);
    const visa = scored(item("visa", "India e-visa", "Granted 15 September 2026, valid for one year"));
    expect(p.contradicts(visa, ahead, true)).toBe(false);
    // A request that does not act and names nothing newer keeps an old-year item.
    const remark = cue("Lisbon was lovely", ["Lisbon"]);
    expect(p.contradicts(old, remark, false)).toBe(false);
  });

  test("a qualifier tying the request's name to another organisation is dropped", () => {
    const p = partner() as any;
    const c = cue("What's the background on Jordan Pike from Northwind?", ["Jordan Pike", "Northwind"]);
    const wrong = scored(item("jp-c", "Jordan Pike (Contoso)", "Contoso account contact"));
    const right = scored(item("jp-n", "Jordan Pike (Northwind)", "Northwind account contact"));
    expect(p.contradicts(wrong, c, false)).toBe(true);
    expect(p.contradicts(right, c, false)).toBe(false);
  });

  test("a two-word name sharing only its first word with the request's is another vendor", () => {
    const p = partner() as any;
    const c = cue("Pay the Acme Logistics invoice 4471 today", ["Acme Logistics"], ["2026-11-10"]);
    const catering = scored(item("cat", "Acme Catering", "Your Acme Catering order"));
    const held = scored(item("hold", "Acme Logistics hold", "Acme Logistics account is on hold"));
    expect(p.contradicts(catering, c, true)).toBe(true);
    expect(p.contradicts(held, c, true)).toBe(false);
  });
});

describe("fallback asks", () => {
  test("an asking request gets every early candidate that stands up to it", () => {
    const p = partner() as any;
    const c = cue("I need to move my dentist appointment with Dr. Okafor to later in the week?", ["Okafor"]);
    const a = scored(item("evt", "Dentist with Dr. Okafor", "Thursday 15:00"), 0.95, 3);
    const b = scored(item("mail", "Re: Okafor Dental", "Your appointment Thursday at 15:00"), 0.95, 3);
    const hits = p.fallback([a, b], c);
    expect(hits.map((x: any) => x.item.id)).toEqual([a.item.id, b.item.id]);
  });

  test("an asking request gets a two-term hit under half the bar", () => {
    const p = partner() as any;
    const c = cue("When are my new headphones arriving?", ["headphones"]);
    const hit = scored(item("ord", "Order shipped", "Your headphones order is on its way"), 0.6, 2);
    expect(p.fallback([hit], c).map((x: any) => x.item.id)).toEqual([hit.item.id]);
  });

  test("a remark keeps the single strong top item, and a look-alike is not it", () => {
    const p = partner() as any;
    const c = cue("Pay the Acme Logistics invoice 4471 today", ["Acme Logistics"], ["2026-11-10"]);
    const look = scored(item("inv-4390", "Invoice 4390 from Acme Logistics", "Paid in October"), 1.2, 3);
    const owed = scored(item("inv-4471", "Invoice 4471 from Acme Logistics", "Amount due"), 1.1, 3);
    const got = p.fallback([look, owed], c);
    expect(got.map((x: any) => x.item.id)).toEqual([owed.item.id]);
  });
});
