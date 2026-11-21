import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner, type PartnerDeps } from "./partner";
import { CORE_CONFIG } from "./parts";

const scope = { tenantId: "acme-assistant", userId: "u1", sessionId: "s1" };
let clock = 1_700_000_000_000;

/** Wednesday 11 November 2026, noon UTC — after every "old" document below, before every current deadline. */
const at = Date.parse("2026-11-11T12:00:00Z");

function partner(extra: Partial<PartnerDeps> = {}, sources: Source[]) {
  const p = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => at,
    ...extra,
    config: { ...CORE_CONFIG, ...extra.config },
  });
  return { p };
}

const say = async (p: ContextPartner, text: string, sources: Source[], extra: Partial<PartnerDeps> = {}) => {
  const sessionId = `g${clock++}`;
  const event = { ...scope, sessionId, at, kind: "user_message", text };
  const r = await p.observe(event as AgentEvent, { waitMs: 1_000 });
  return [r.injection, ...p.takePending({ ...scope, sessionId })]
    .filter((i) => i !== null)
    .flatMap((i) => i.citations.map((c) => c.itemId));
};

const ask = async (p: ContextPartner, question: string, maxItems = 5) => {
  const r = await p.ask({ ...scope, sessionId: `a${clock++}`, question, maxItems });
  return r.citations.map((c) => c.itemId);
};

// A statement pair the eval corpus has never seen: the October statement is current, the September one is
// flagged dead in its own title.
const statements = () =>
  new StaticSource("mail", "Mail", [
    {
      ref: "monzo-oct",
      title: "Monzo statement — October 2026",
      text: "Your Monzo statement for October 2026. Balance 4,120 GBP. 87 transactions.",
    },
    {
      ref: "monzo-sep",
      title: "[OLD] Monzo statement — September 2026",
      text: "Your Monzo statement for September 2026. Balance 3,800 GBP. 92 transactions.",
    },
  ]);

// A supersession that only the body declares: nothing in the title says the June terms are dead.
const terms = () =>
  new StaticSource("mail", "Mail", [
    {
      ref: "pension-jun",
      title: "Pension terms summary",
      text: "This summary has been superseded by the November notice — see that for the rates that apply. Employer contribution was 6% at the time of writing.",
    },
    {
      ref: "pension-nov",
      title: "Pension terms notice — November 2026",
      text: "Employer contribution rises to 8% from December. This notice replaces the June summary.",
    },
  ]);

// The saver offer whose own deadline is already past, beside the one still open.
const offers = () =>
  new StaticSource("mail", "Mail", [
    {
      ref: "nat-oct",
      title: "Nationwide saver offer — 5% rate",
      text: "Open a FlexDirect saver at 5% AER. Offer ends 30 September 2026.",
      updatedAt: Date.parse("2026-09-01T00:00:00Z"),
    },
    {
      ref: "nat-jan",
      title: "Nationwide saver offer — 4.5% rate",
      text: "Open a FlexDirect saver at 4.5% AER. Valid until 31 January 2027.",
      updatedAt: Date.parse("2026-11-01T00:00:00Z"),
    },
  ]);

// A revised tariff pair: the March copy is the stale sibling of the November revision.
const tariff = () =>
  new StaticSource("mail", "Mail", [
    {
      ref: "tariff-mar",
      title: "Octopus tariff summary — March 2026",
      text: "Flexible Octopus: unit rate 27.03p/kWh, standing charge 48p/day.",
    },
    {
      ref: "tariff-nov",
      title: "Octopus tariff summary — November 2026",
      text: "Flexible Octopus: unit rate 24.50p/kWh, standing charge 45p/day.",
    },
  ]);

describe("stale supersession: the current record ranks and hands ahead of the dead copy", () => {
  test("ask: the flagged old statement sorts after the current one", async () => {
    const { p } = partner({}, [statements()]);
    const ids = await ask(p, "What was my Monzo balance?");
    expect(ids).toContain("mail:monzo-oct");
    if (ids.includes("mail:monzo-sep"))
      expect(ids.indexOf("mail:monzo-oct")).toBeLessThan(ids.indexOf("mail:monzo-sep"));
  });

  test("injection: the flagged old statement stays silent beside the current one", async () => {
    const { p } = partner({ config: { groundSubject: true } }, [statements()]);
    const ids = await say(p, "What was my Monzo balance?", [statements()], { config: { groundSubject: true } });
    expect(ids).toContain("mail:monzo-oct");
    expect(ids).not.toContain("mail:monzo-sep");
  });

  test("ask: asking for the old statement hands it — the stale copy is then the answer", async () => {
    const { p } = partner({}, [statements()]);
    const ids = await ask(p, "What was my balance in the old Monzo statement?");
    expect(ids).toContain("mail:monzo-sep");
  });

  test("ask: a request naming the year hands that year's record, stale flag or not", async () => {
    const { p } = partner({}, [statements()]);
    const ids = await ask(p, "Show me my Monzo statement for September 2026");
    expect(ids).toContain("mail:monzo-sep");
  });

  test("injection: a body-declared superseded summary leaves the pool", async () => {
    const { p } = partner({ config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } }, [terms()]);
    const ids = await say(p, "What are my pension terms?", [terms()], { config: { groundSubject: true } });
    expect(ids).toContain("mail:pension-nov");
    expect(ids).not.toContain("mail:pension-jun");
  });

  test("ask: the superseded summary sorts after the November notice", async () => {
    const { p } = partner({}, [terms()]);
    const ids = await ask(p, "What are my pension terms?");
    expect(ids).toContain("mail:pension-nov");
    if (ids.includes("mail:pension-jun"))
      expect(ids.indexOf("mail:pension-nov")).toBeLessThan(ids.indexOf("mail:pension-jun"));
  });

  test("injection: the offer whose deadline passed is silent; the open one is handed", async () => {
    const { p } = partner({ config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } }, [offers()]);
    const ids = await say(p, "Is there a Nationwide saver offer for me?", [offers()], {
      config: { groundSubject: true },
    });
    expect(ids).toContain("mail:nat-jan");
    expect(ids).not.toContain("mail:nat-oct");
  });

  test("ask: the expired offer never outranks the open one", async () => {
    const { p } = partner({}, [offers()]);
    const ids = await ask(p, "What saver offers does Nationwide have for me?");
    expect(ids).toContain("mail:nat-jan");
    if (ids.includes("mail:nat-oct")) expect(ids.indexOf("mail:nat-jan")).toBeLessThan(ids.indexOf("mail:nat-oct"));
  });

  test("ask: an expired offer alone is still the answer when nothing newer exists", async () => {
    const expired = new StaticSource("mail", "Mail", [
      {
        ref: "nat-oct",
        title: "Nationwide saver offer — 5% rate",
        text: "Open a FlexDirect saver at 5% AER. Offer ends 30 September 2026.",
        updatedAt: Date.parse("2026-09-01T00:00:00Z"),
      },
    ]);
    const { p } = partner({}, [expired]);
    const ids = await ask(p, "What saver offers does Nationwide have for me?");
    expect(ids).toContain("mail:nat-oct");
  });

  test("injection: the March tariff is the stale sibling of the November revision", async () => {
    const { p } = partner({ config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } }, [tariff()]);
    const ids = await say(p, "What is my Octopus unit rate?", [tariff()], {
      config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 },
    });
    expect(ids).toContain("mail:tariff-nov");
    expect(ids).not.toContain("mail:tariff-mar");
  });

  test("ask: the March tariff sorts after the November revision", async () => {
    const { p } = partner({}, [tariff()]);
    const ids = await ask(p, "What is my Octopus unit rate?");
    expect(ids).toContain("mail:tariff-nov");
    if (ids.includes("mail:tariff-mar"))
      expect(ids.indexOf("mail:tariff-nov")).toBeLessThan(ids.indexOf("mail:tariff-mar"));
  });

  test("a name with 'Old' in it is not a death notice: Old Portsmouth hands normally", async () => {
    const ferry = new StaticSource("mail", "Mail", [
      {
        ref: "ferry-old",
        title: "Old Portsmouth ferry timetable",
        text: "Ferries from Old Portsmouth to Ryde leave every 40 minutes from 06:20.",
      },
    ]);
    const { p } = partner({}, [ferry]);
    const ids = await ask(p, "When do ferries leave Old Portsmouth?");
    expect(ids).toContain("mail:ferry-old");
  });

  test("a record of a thing being replaced is not itself replaced", async () => {
    const repair = new StaticSource("mail", "Mail", [
      {
        ref: "mac-repair",
        title: "MacBook battery replaced under warranty",
        text: "Your MacBook Air battery was replaced free of charge on 2 November 2026 at the Regent Street store.",
      },
    ]);
    const { p } = partner({}, [repair]);
    const ids = await ask(p, "Was my MacBook battery replacement free?");
    expect(ids).toContain("mail:mac-repair");
  });

  test("a 'today' request is no exemption: the stale sibling still loses", async () => {
    const { p } = partner({}, [statements()]);
    const ids = await ask(p, "What was my Monzo balance today?");
    expect(ids).toContain("mail:monzo-oct");
    if (ids.includes("mail:monzo-sep"))
      expect(ids.indexOf("mail:monzo-oct")).toBeLessThan(ids.indexOf("mail:monzo-sep"));
  });

  test("a notice that a thing expired is the current record, not a dead one", async () => {
    const docs = new StaticSource("mail", "Mail", [
      {
        ref: "passport-warn",
        title: "Your passport expired on 30 September 2026",
        text: "Your passport expired on 30 September 2026. Renew it before booking travel.",
        updatedAt: Date.parse("2026-10-02T00:00:00Z"),
      },
    ]);
    const { p } = partner({}, [docs]);
    const ids = await ask(p, "Do I need to renew my passport?");
    expect(ids).toContain("mail:passport-warn");
  });

  test("a title's yearless date is this year's, not next year's", async () => {
    const docs = new StaticSource("mail", "Mail", [
      {
        ref: "monzo-sep2",
        // The same September statement with no year written, updated in November: it is 2026's, and the
        // November revision beside it is the current record.
        title: "Monzo statement — September",
        text: "Your Monzo statement for September. Balance 3,800 GBP.",
        updatedAt: Date.parse("2026-11-01T00:00:00Z"),
      },
      {
        ref: "monzo-nov2",
        title: "Monzo statement — November 2026",
        text: "Your Monzo statement for November 2026. Balance 4,400 GBP.",
      },
    ]);
    const { p } = partner({ config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } }, [docs]);
    const ids = await say(p, "What was my Monzo balance?", [docs], { config: { groundSubject: true } });
    expect(ids).toContain("mail:monzo-nov2");
    expect(ids).not.toContain("mail:monzo-sep2");
  });

  test("an explicit expiry date alone silences the offer — no sibling, no body year", async () => {
    const docs = new StaticSource("mail", "Mail", [
      {
        ref: "bonus-sep",
        // Neither the title nor a body year dates this one: only its own deadline says when it died.
        title: "Weekend saver bonus",
        text: "Top up this weekend for a bonus. Offer ends 30 September.",
        updatedAt: Date.parse("2026-09-01T00:00:00Z"),
      },
      {
        ref: "bonus-nov",
        title: "Weekend saver bonus — November 2026",
        text: "Top up this November for a bonus.",
        updatedAt: Date.parse("2026-11-02T00:00:00Z"),
      },
    ]);
    const { p } = partner({ config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } }, [docs]);
    const ids = await say(p, "Is there a saver bonus for me?", [docs], { config: { groundSubject: true } });
    expect(ids).toContain("mail:bonus-nov");
    expect(ids).not.toContain("mail:bonus-sep");
  });

  test("a request naming the record's month asks for it, stale or not", async () => {
    const docs = new StaticSource("mail", "Mail", [
      {
        ref: "monzo-sep3",
        title: "Monzo statement — September 2026",
        text: "Your Monzo statement for September 2026. Balance 3,800 GBP.",
      },
      {
        ref: "monzo-nov3",
        title: "Monzo statement — November 2026",
        text: "Your Monzo statement for November 2026. Balance 4,400 GBP.",
      },
    ]);
    const { p } = partner({ config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } }, [docs]);
    const ids = await say(p, "Monzo balance on 30 September?", [docs], { config: { groundSubject: true } });
    expect(ids).toContain("mail:monzo-sep3");
  });

  test("a revision published ahead of its month is still the new record", async () => {
    const docs = new StaticSource("mail", "Mail", [
      {
        ref: "tariff-oct",
        title: "Octopus tariff summary — October 2026",
        text: "Flexible Octopus: unit rate 26.00p/kWh.",
      },
      {
        ref: "tariff-nov-early",
        // Published 25 October, dated 1 November: the coming revision, not last year's.
        title: "Octopus tariff summary — 1 November",
        text: "Flexible Octopus: unit rate 24.50p/kWh.",
        updatedAt: Date.parse("2026-10-25T00:00:00Z"),
      },
    ]);
    const { p } = partner({ config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } }, [docs]);
    const ids = await say(p, "What is my Octopus unit rate?", [docs], { config: { groundSubject: true } });
    expect(ids).toContain("mail:tariff-nov-early");
    expect(ids).not.toContain("mail:tariff-oct");
  });

  test("a person named May does not date the record", async () => {
    const docs = new StaticSource("mail", "Mail", [
      {
        ref: "may-statement",
        // "May Chen" is the sender, not a date: the body's own November is the record's month.
        title: "Monzo statement (May Chen)",
        text: "Your Monzo statement for November 2026. Balance 4,400 GBP. — May Chen",
      },
      {
        ref: "oct-statement",
        title: "Monzo statement — October 2026",
        text: "Your Monzo statement for October 2026. Balance 4,200 GBP.",
      },
    ]);
    const { p } = partner({ config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } }, [docs]);
    const ids = await say(p, "What was my Monzo balance?", [docs], { config: { groundSubject: true } });
    expect(ids).toContain("mail:may-statement");
    expect(ids).not.toContain("mail:oct-statement");
  });

  test("a day-month-year after a separator keeps its year", async () => {
    const docs = new StaticSource("mail", "Mail", [
      {
        ref: "tariff-2025",
        // The "— November 1, 2025" date is last year's: the November 2026 revision supersedes it.
        title: "Octopus tariff summary — November 1, 2025",
        text: "Flexible Octopus: unit rate 28.00p/kWh.",
      },
      {
        ref: "tariff-2026",
        title: "Octopus tariff summary — November 2026",
        text: "Flexible Octopus: unit rate 24.50p/kWh.",
      },
    ]);
    const { p } = partner({ config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } }, [docs]);
    const ids = await say(p, "What is my Octopus unit rate?", [docs], { config: { groundSubject: true } });
    expect(ids).toContain("mail:tariff-2026");
    expect(ids).not.toContain("mail:tariff-2025");
  });

  test("a month-only deadline runs out that month, not next year's", async () => {
    const docs = new StaticSource("mail", "Mail", [
      {
        ref: "offer-nov",
        title: "Weekend saver bonus",
        text: "Top up this weekend for a bonus. Offer ends November.",
        updatedAt: Date.parse("2026-11-10T00:00:00Z"),
      },
      {
        ref: "offer-dec",
        title: "Weekend saver bonus — December 2026",
        text: "Top up this December for a bonus.",
        updatedAt: Date.parse("2026-12-01T00:00:00Z"),
      },
    ]);
    // Written 10 November, asked about in December: the offer is dead and the current one wins.
    const dec5 = Date.parse("2026-12-05T12:00:00Z");
    const { p } = partner(
      { now: () => dec5, config: { groundSubject: true, confidentScore: 0.1, minMatchedTerms: 1 } },
      [docs],
    );
    const ids = await ask(p, "Is there a saver bonus for me?");
    expect(ids).toContain("mail:offer-dec");
    if (ids.includes("mail:offer-nov"))
      expect(ids.indexOf("mail:offer-dec")).toBeLessThan(ids.indexOf("mail:offer-nov"));
  });
});
