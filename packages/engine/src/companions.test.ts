import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner, type PartnerDeps } from "./partner";
import { CORE_CONFIG } from "./parts";
import type { Trace } from "./trace";

const scope = { tenantId: "acme-assistant", userId: "u1", sessionId: "s1" };
let clock = 1_700_000_000_000;

function partner(extra: Partial<PartnerDeps> = {}, sources: Source[]) {
  const traces: Trace[] = [];
  const p = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    onTrace: (t) => traces.push(t),
    ...extra,
    config: { ...CORE_CONFIG, ...extra.config },
  });
  return { p, traces };
}

describe("companions: a delivered item pulls its cross-source companions (D1977)", () => {
  // Wednesday 11 November 2026, noon UTC.
  const at = Date.parse("2026-11-11T12:00:00Z");
  const run = async (text: string, sources: Source[], extra: Partial<PartnerDeps> = {}) => {
    const { p, traces } = partner(extra, sources);
    const sessionId = `c${clock++}`;
    const event = { ...scope, sessionId, at, kind: "user_message", text };
    const r = await p.observe(event as AgentEvent, { waitMs: 1_000 });
    const ids = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId })].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
    return { ids, reasons: traces.map((t) => t.reason) };
  };

  test("a shared identifier in another source: the invoice's bill, not its promo mail or another bill", async () => {
    const mail = new StaticSource("mail", "Mail", [
      {
        ref: "acme-invoice",
        title: "New email from Acme Supplies",
        text: "Invoice 2291 is overdue.",
      },
      {
        ref: "acme-promo",
        title: "Acme Supplies: 20% off office chairs",
        text: "This week only, ergonomic chairs at 20% off.",
      },
    ]);
    const finance = new StaticSource("finance", "Finance", [
      { ref: "bill-2291", title: "Bill 2291", text: "Supplier invoice 2291: 1,240 GBP due." },
      { ref: "bill-3300", title: "Bill 3300", text: "Supplier invoice 3300: 800 GBP due." },
    ]);
    const { ids } = await run("New email from Acme Supplies: Invoice 2291 is overdue", [mail, finance]);
    expect(ids).toContain("mail:acme-invoice");
    expect(ids).toContain("finance:bill-2291");
    expect(ids).not.toContain("finance:bill-3300");
    // Sharing only the request's named entity is no link at all.
    expect(ids).not.toContain("mail:acme-promo");
  });

  test("a shared topic: the thread's other mail", async () => {
    const mail = new StaticSource("mail", "Mail", [
      {
        ref: "globex-inject",
        title: "Globex renewal quote",
        text: "Dana Lee quoted 18,000 GBP for the renewal.",
      },
      {
        ref: "globex-thread",
        title: "Re: Globex renewal",
        text: "Dana Lee: 12% off if you sign before the 30th.",
      },
    ]);
    const { ids } = await run("What did Globex quote for the renewal?", [mail]);
    expect(ids).toContain("mail:globex-inject");
    expect(ids).toContain("mail:globex-thread");
  });

  test("a companion the request's words never rank comes back from the session's cache", async () => {
    const mail = new StaticSource("mail", "Mail", [
      {
        ref: "msg-webb",
        title: "Q3 board numbers",
        text: "Marcus Webb sent the Q3 board numbers for Wednesday.",
      },
    ]);
    const calendar = new StaticSource("calendar", "Calendar", [
      {
        ref: "evt-webb",
        title: "Board prep with Marcus Webb",
        text: "Wednesday 12 November, 14:00.",
        meta: { start: "2026-11-12T14:00:00Z" },
      },
      {
        ref: "evt-gym",
        title: "Gym session",
        text: "Wednesday 12 November, morning.",
        meta: { start: "2026-11-12T08:00:00Z" },
      },
    ]);
    const docs = new StaticSource("docs", "Docs", [
      {
        ref: "doc-q3",
        title: "Q3 board pack",
        text: "Draft revenue, churn and hiring slides for the Q3 board meeting.",
      },
    ]);
    // The deck is never returned by the request's own search; the pass reads the session's cache, where an
    // earlier fetch left it, not the sources again.
    const cache = new ItemCache();
    const { p } = partner({ cache }, [mail, calendar, docs]);
    const sessionId = `c${clock++}`;
    const sscope = { ...scope, sessionId };
    cache.put(
      sscope,
      [
        {
          id: "docs:doc-q3",
          sourceId: "docs",
          ref: "doc-q3",
          title: "Q3 board pack",
          text: "Draft revenue, churn and hiring slides for the Q3 board meeting.",
        },
      ],
      Date.now(),
    );
    const r = await p.observe(
      {
        ...sscope,
        at,
        kind: "user_message",
        text: "What do I need for my meeting with Marcus Webb on Wednesday?",
      } as AgentEvent,
      { waitMs: 1_000 },
    );
    const ids = [...(r.injection ? [r.injection] : []), ...p.takePending(sscope)].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
    expect(ids).toContain("calendar:evt-webb");
    expect(ids).toContain("mail:msg-webb");
    expect(ids).toContain("docs:doc-q3");
    // Same day is no link: day words bind nothing.
    expect(ids).not.toContain("calendar:evt-gym");
  });

  test("a sibling naming a different identifier stays out even when its words match", async () => {
    const mail = new StaticSource("mail", "Mail", [
      {
        ref: "acme-invoice",
        title: "New email from Acme Supplies",
        text: "Invoice 2291 is overdue.",
      },
      {
        ref: "acme-invoice-old",
        title: "Acme Supplies invoice",
        text: "Invoice 1180 from Acme Supplies was paid.",
      },
    ]);
    const { ids } = await run("New email from Acme Supplies: Invoice 2291 is overdue", [mail]);
    expect(ids).toContain("mail:acme-invoice");
    expect(ids).not.toContain("mail:acme-invoice-old");
  });

  test("a rule document of a pick's matter links on one common term: the fare rules beside the booking", async () => {
    const mail = new StaticSource("mail", "Mail", [
      {
        ref: "ba-booking",
        title: "Your booking ABC123: London to Lisbon",
        text: "Flight BA 500, Friday 13 Nov, departs LHR 07:25, seat 14C. Booking reference ABC123.",
      },
      {
        ref: "ba-policy",
        title: "Changing your BA booking",
        text: "Changes to Economy Light fares cost 65 GBP per person plus any fare difference.",
      },
      // "booking" sits on most of the user's mail, so it is not a rare word to link on; the policy's own
      // vocabulary is what says it belongs beside the booking.
      { ref: "hotel-1", title: "Your booking at Memmo", text: "Booking confirmed for 13-16 Nov." },
      { ref: "hotel-2", title: "Booking receipt", text: "Your booking charge of 412 GBP." },
      { ref: "rail-1", title: "Booking change", text: "Your booking on the 10:00 was moved." },
      // A rule document of another matter links nothing: its words are policy's but no pick shares one.
      { ref: "visa-policy", title: "Visa fee schedule", text: "Fees and surcharges for each visa class." },
      // Another party's policy is not the pick's rules: TAP's shares "booking" and no name or rare word.
      { ref: "tap-policy", title: "Changing your TAP booking", text: "Change fees and penalties apply." },
      // Two more picks of the request's own terms fill the packet to its cap of three — the fare rules
      // still ride beside the booking, one rule document past the cap (D2058).
      { ref: "lis-insurance", title: "Lisbon flight insurance", text: "Flight cover for Lisbon, 12 GBP." },
      { ref: "lis-seat", title: "Lisbon flight seat", text: "Seat selection for your flight to Lisbon." },
    ]);
    const { ids } = await run("What does my Lisbon flight itinerary say?", [mail]);
    expect(ids).toContain("mail:ba-booking");
    expect(ids).toContain("mail:ba-policy");
    expect(ids).toContain("mail:lis-insurance");
    expect(ids).not.toContain("mail:visa-policy");
    expect(ids).not.toContain("mail:tap-policy");
  });

  test("off, the packet is the request's own picks only", async () => {
    const mail = new StaticSource("mail", "Mail", [
      {
        ref: "globex-inject",
        title: "Globex renewal quote",
        text: "Dana Lee quoted 18,000 GBP for the renewal.",
      },
      {
        ref: "globex-thread",
        title: "Re: Globex renewal",
        text: "Dana Lee: 12% off if you sign before the 30th.",
      },
    ]);
    const { ids } = await run("What did Globex quote for the renewal?", [mail], {
      config: { companions: false },
    });
    expect(ids).toContain("mail:globex-inject");
    expect(ids).not.toContain("mail:globex-thread");
  });
});
