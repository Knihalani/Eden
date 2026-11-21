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
    expect(p.contradicts(owed, c)).toBe(false);
    expect(p.contradicts(other, c)).toBe(true);
  });

  test("a currency code before the number is an amount, and a clock reading is a time, not identifiers", () => {
    const p = partner() as any;
    // "GBP 2,400" is a sum like "£2,400": the invoice the request means must still stand.
    const money = cue("Pay the GBP 2,400 invoice", ["GBP"]);
    const inv = scored(item("inv", "Invoice 4471", "Amount due 2,400 GBP"));
    expect(p.contradicts(inv, money)).toBe(false);
    // "at 1400" names a time of day, not a room or reference number.
    const when = cue("What's on at 1400?");
    const room = scored(item("room", "Room 204 booked", "Standup in room 204"));
    expect(p.contradicts(room, when)).toBe(false);
    // A model number trailing an all-caps word ("737 MAX") is not an identifier either.
    const story = cue("the 737 MAX story");
    const flight = scored(item("fl", "Flight BA 215 to Lisbon", "Boarding at gate 9"));
    expect(p.contradicts(flight, story)).toBe(false);
  });

  test("a number followed by a measure word is a quantity, not an identifier", () => {
    const p = partner() as any;
    // The limit the request needs is 750, the requester's own number is a 650 GBP budget: no conflict.
    const c = cue("Book me a hotel in Berlin, about 650 GBP for the offsite");
    const fact = scored(item("exp", "Travel expenses policy", "Hotels are capped at 750 GBP a night"));
    expect(p.contradicts(fact, c)).toBe(false);
  });

  test("an item dated only in a year the request has moved past is dropped, but not by a future named day", () => {
    const p = partner() as any;
    const c = cue("Move my flight to Lisbon on 12 November to a morning slot", ["Lisbon"], ["2026-11-12"]);
    const old = scored(item("b-2025", "Your Lisbon booking, June 2025", "BA to Lisbon, June 2025"));
    const now = scored(item("b-2026", "Your Lisbon booking, 12 November 2026", "BA to Lisbon, 12 November 2026"));
    expect(p.contradicts(old, c)).toBe(true);
    expect(p.contradicts(now, c)).toBe(false);
    // A day ahead in the next year does not make this year's items stale.
    const ahead = cue("Extend my Delhi trip so I come back on 10 January instead", ["Delhi"], ["2027-01-10"]);
    const visa = scored(item("visa", "India e-visa", "Granted 15 September 2026, valid for one year"));
    expect(p.contradicts(visa, ahead)).toBe(false);
    // A request that does not act and names nothing newer keeps an old-year item.
    const remark = cue("Lisbon was lovely", ["Lisbon"]);
    expect(p.contradicts(old, remark)).toBe(false);
  });

  test("a qualifier tying the request's name to another organisation is dropped", () => {
    const p = partner() as any;
    const c = cue("What's the background on Jordan Pike from Northwind?", ["Jordan Pike", "Northwind"]);
    const wrong = scored(item("jp-c", "Jordan Pike (Contoso)", "Contoso account contact"));
    const right = scored(item("jp-n", "Jordan Pike (Northwind)", "Northwind account contact"));
    expect(p.contradicts(wrong, c)).toBe(true);
    expect(p.contradicts(right, c)).toBe(false);
    // With no second name in the request there is nothing to disambiguate: a role or pronoun in parens
    // describes the one person meant, it does not tie them to another organisation.
    const plain = cue("email Dana Lee", ["Dana Lee"]);
    const ceo = scored(item("dl", "Dana Lee (CEO)", "Dana Lee's direct line"));
    expect(p.contradicts(ceo, plain)).toBe(false);
  });

  test("a two-word name sharing only its first word with the request's is another vendor", () => {
    const p = partner() as any;
    const c = cue("Pay the Acme Logistics invoice 4471 today", ["Acme Logistics"], ["2026-11-10"]);
    const catering = scored(item("cat", "Acme Catering", "Your Acme Catering order"));
    const held = scored(item("hold", "Acme Logistics hold", "Acme Logistics account is on hold"));
    expect(p.contradicts(catering, c)).toBe(true);
    expect(p.contradicts(held, c)).toBe(false);
    // A possessive is still that name: "Dana Lee's calendar" and "Acme Logistics' hold notice" are the
    // request's own item, not a different vendor's.
    const poss = cue("email Dana Lee", ["Dana Lee"]);
    const cal = scored(item("cal", "Dana Lee's calendar", "Dana Lee's week"));
    expect(p.contradicts(cal, poss)).toBe(false);
    const poss2 = cue("pay the Acme Logistics invoice", ["Acme Logistics"]);
    const notice = scored(item("hn", "Acme Logistics' hold notice", "Hold placed on the account"));
    expect(p.contradicts(notice, poss2)).toBe(false);
    // Two request names that share a first word complete either pair: introducing Sarah Chen to Sarah Cole
    // keeps the items of both Sarahs.
    const intro = cue("introduce Sarah Chen to Sarah Cole", ["Sarah Chen", "Sarah Cole"]);
    const chen = scored(item("sc", "Sarah Chen", "Sarah Chen's profile"));
    const cole = scored(item("sco", "Sarah Cole intro", "Notes on Sarah Cole"));
    const kim = scored(item("sk", "Sarah Kim", "A different Sarah entirely"));
    expect(p.contradicts(chen, intro)).toBe(false);
    expect(p.contradicts(cole, intro)).toBe(false);
    expect(p.contradicts(kim, intro)).toBe(true);
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

  test("a thing a named third party owns is a look-alike beside the user's own (D2060)", () => {
    const p = partner() as any;
    const c = cue("Move my Lisbon flight on 12 November to the evening departure.", ["Lisbon"], ["2026-11-12"]);
    const mine = scored(
      item(
        "b-nov",
        "Your booking: London to Lisbon, 12 November",
        "Flight TP1351 departs Heathrow 07:40 on 12 November 2026.",
      ),
    );
    const sams = scored(
      item(
        "b-sam",
        "Fwd: Sam Okoro's flight to Lisbon",
        "Sam's booking reference ZZ81KD: TP1357, 18:05 from Heathrow on 12 November 2026.",
      ),
    );
    expect(p.contradicts(mine, c)).toBe(false);
    expect(p.contradicts(sams, c)).toBe(true);
    // The owner the request itself names is no look-alike.
    const theirs = cue("Move my booking and Sam Okoro's flight to Lisbon", ["Lisbon"]);
    expect(p.contradicts(sams, theirs)).toBe(false);
    // No first-person claim, no look-alike: "reschedule Sam Okoro's flight" asks about his.
    expect(p.contradicts(sams, cue("Reschedule Sam Okoro's flight to Lisbon", ["Lisbon"]))).toBe(false);
    // A possessive at the title's end names no owned thing ("Rosa's" is the place).
    const rosas = scored(item("b-rosa", "Brunch at Rosa's", "Sunday 11:00"));
    expect(p.contradicts(rosas, cue("Book our anniversary dinner"))).toBe(false);
    // A bare possessive title is too ambiguous to condemn: "Kai Nihalani's appointment" on the user's own
    // calendar is the user's own — only a forward mark makes the named owner a third party.
    const own = scored(item("b-own", "Kai Nihalani's appointment", "Dentist, Tuesday 15:00."));
    expect(p.contradicts(own, cue("Reschedule my appointment"))).toBe(false);
    // The mark survives a reply's "Re:" prefix — "Re: Fwd: Sam's flight" is still the forwarded third-party
    // document; a bare "Re:" is a thread's own reply and stays ambiguous.
    const refwd = scored(item("b-rf", "Re: Fwd: Sam Okoro's flight to Lisbon", sams.item.text));
    expect(p.contradicts(refwd, c)).toBe(true);
    const re = scored(item("b-re", "Re: Sam Okoro's flight to Lisbon", sams.item.text));
    expect(p.contradicts(re, c)).toBe(false);
  });

  test("a question naming two years keeps the earlier side's records (D2061)", () => {
    const p = partner() as any;
    const c = cue("How did my 2023 revenue compare with 2024?");
    const earlier = scored(item("r-23", "Revenue report: 2023", "Total revenue for fiscal year 2023."));
    const later = scored(item("r-24", "Revenue report: 2024", "Total revenue for fiscal year 2024."));
    // Both ends of the comparison are the answer; only a year before the earliest named is a look-alike.
    expect(p.contradicts(earlier, c)).toBe(false);
    expect(p.contradicts(later, c)).toBe(false);
    const before = scored(item("r-20", "Revenue report: 2020", "Total revenue for fiscal year 2020."));
    expect(p.contradicts(before, c)).toBe(true);
    // One year named, one floor: last year's record is still the look-alike it always was.
    const single = cue("What was my revenue in 2024?");
    expect(p.contradicts(earlier, single)).toBe(true);
    expect(p.contradicts(later, single)).toBe(false);
  });

  test("a record that declares itself dead is dead beside a dated ask too (D2060)", () => {
    const p = partner() as any;
    const dead = item(
      "h",
      "Cancelled: Hotel Alfama, Lisbon",
      "Your reservation at Hotel Alfama for 12 to 14 November 2026 has been cancelled at your request.",
    );
    // A dated ask looks up the period's records — a cancelled one is none of them.
    expect(p.staleSelf(dead, cue("Move my Lisbon flight on 12 November to the evening departure."))).toBe(true);
    expect(p.staleSelf(dead, cue("What Lisbon hotel do I have in November?"))).toBe(true);
    // A request about the cancellation itself wants the record.
    expect(p.staleSelf(dead, cue("Was my Lisbon hotel cancelled?"))).toBe(false);
    // A leading "Cancelled:" declares the record dead; "budget review cancelled" mid-title reports an event
    // — the notice is fresh news, not a dead record.
    const notice = item("n", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review.");
    expect(p.staleSelf(notice, cue("What's new with Dana Lee?"))).toBe(false);
    // The dated exemption still stands for a deadline since passed: the period is what it asks about.
    const lapsed = item("o", "Lisbon offer", "Booking offer expires 8 November 2026.");
    expect(p.staleSelf(lapsed, cue("What Lisbon offers ran in November 2026?"))).toBe(false);
  });
});
