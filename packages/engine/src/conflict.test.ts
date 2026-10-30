import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { assess, frameOf, namesRef } from "./conflict";
import { timeWindow } from "./grounding";
import { ContextPartner } from "./partner";
import { cleanEntities } from "./probes";
import { extractEntities } from "./text";

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (title: string, text: string): ContextItem => ({
  id: `x:${title}`,
  sourceId: "x",
  ref: title,
  title,
  text,
});
const frame = (request: string) =>
  frameOf(request, timeWindow(request, NOW)?.days ?? null, NOW, cleanEntities(extractEntities(request)));
const verdict = (request: string, title: string, text: string) => assess(frame(request), item(title, text), NOW);

describe("the request's frame", () => {
  test("days, amounts and references", () => {
    const f = frame("Book the team dinner for 15 people on Thursday 5 November, £85 a head, and pay INV-5842");
    expect(f.days).toEqual(["2026-11-05"]);
    expect(f.named).toBe(true);
    expect(f.amounts).toContainEqual({ unit: "£", value: 85 });
    expect(f.amounts).toContainEqual({ unit: "£", value: 1_275 });
    expect(f.refs).toContainEqual({ kind: "inv", value: "5842", noun: "" });
  });

  test("an action that names no day acts today", () => {
    const f = frame("Send Rose Kimura the Q3 report");
    expect(f.days).toEqual(["2026-10-27"]);
    expect(f.named).toBe(false);
    expect(f.refs).toContainEqual({ kind: "quarter", value: "q3", noun: "report" });
  });

  test("a quoted subject line is not a name", () => {
    const f = frame('New email from May Lindqvist: "Any update on the pricing?"');
    expect(f.names).toContain("may lindqvist");
    expect(f.names.some((n) => n.includes("pricing"))).toBe(false);
  });
});

describe("conflict: what would change the action", () => {
  test("an absence over a day the request acts on, and not over other days", () => {
    const ask = "Get Robert Haddad to sign off the MSA by Friday";
    expect(verdict(ask, "Robert away", "Robert Haddad is on leave 26 Oct to 6 Nov.")).toBe("conflict");
    expect(verdict(ask, "Robert away", "Robert Haddad is on leave 16 Nov to 20 Nov.")).toBe("clear");
    // A later line that only repeats the dated one does not undo it.
    const later = "Robert Haddad is out of office 16 Nov to 20 Nov. Reviews go to Rose while Robert is away.";
    expect(verdict(ask, "Robert away", later)).toBe("clear");
  });

  test("a freeze over the requested day, for a request that names no one", () => {
    const ask = "schedule the billing service release for thursday 2pm";
    const freeze = "No production releases from Wednesday 28 October to Tuesday 3 November while finance closes.";
    expect(verdict(ask, "Change freeze", freeze)).toBe("conflict");
    expect(
      verdict(ask, "Change freeze", freeze.replace("28 October", "16 November").replace("3 November", "20 November")),
    ).toBe("clear");
  });

  test("a deadline before the requested day; an expiry before the trip", () => {
    const ask = "Remind me to send the SOC 2 evidence pack to the auditor next week";
    expect(verdict(ask, "SOC 2 evidence", "We now need your SOC 2 evidence by Thursday 29 October.")).toBe("conflict");
    const trip = "find me flights to Ljubljana for the weekend of the 21st of November";
    expect(verdict(trip, "Ljubljana flights", "Passport for the flights: expires 2 Nov 2026.")).toBe("conflict");
  });

  test("an amount above a threshold the item states; at or under it clears", () => {
    const ask = "Raise a PO for the Aperture Labs licence renewal, £48k, and route it to the CFO";
    const policy = (limit: string) => `Purchases above ${limit}, including renewals, require two competing quotes.`;
    expect(verdict(ask, "Procurement policy", policy("£40,000"))).toBe("conflict");
    expect(verdict(ask, "Procurement policy", policy("£75,000"))).toBe("clear");
    const discount = "Offer Globex 15% off their renewal";
    expect(verdict(discount, "Globex renewals", "Globex: discounts above 10% need CFO sign-off.")).toBe("conflict");
    expect(verdict(discount, "Globex renewals", "Globex: you can offer up to 20% without approval.")).toBe("clear");
  });

  test("done already, for the reference the request names; a sibling reference clears", () => {
    const ask = "Tyrell Bio says invoice INV-7174 is overdue. Please pay it today.";
    const paid = (id: string) => `Your transfer to Tyrell Bio for invoice ${id} was sent on Monday 26 October.`;
    expect(verdict(ask, "Payment sent", paid("INV-7174"))).toBe("conflict");
    expect(verdict(ask, "Payment sent", paid("INV-7157"))).toBe("clear");
    expect(verdict("Send Rose Kimura the Q3 report", "Q2 report", "Attached is the Q2 report.")).toBe("clear");
  });

  test("a standing constraint in a named sender's own words, not undone by a partial reassurance", () => {
    const ask = "Book a table for me and Jamie Fox somewhere nice for seafood on Thursday";
    const mail = (body: string) => `From: Jamie Fox <jamie@x.example>\nTo: Robin <r@x.example>\n\n${body}`;
    expect(verdict(ask, "Re: dinner", mail("I'm allergic to shellfish, so no prawns. Fish is fine."))).toBe("conflict");
    expect(verdict(ask, "Re: dinner", mail("Tested for coeliac and it's negative, I eat everything!"))).not.toBe(
      "conflict",
    );
  });

  test("a block that is lifted, or one in a condition, reads as it should", () => {
    const ask = "Share the Q3 results folder with Kofi at Cyberdyne";
    expect(verdict(ask, "Cyberdyne access", "Cyberdyne access was suspended, but it is restored now.")).toBe("clear");
    const hold = "Do not commit delivery dates to Cyberdyne until the MSA is countersigned.";
    expect(verdict(ask, "Cyberdyne", hold)).toBe("conflict");
  });

  test("a move: the old day is in conflict, the new one is not", () => {
    const ask = "Can you confirm my dentist appointment on Thursday morning?";
    const moved = "Dentist appointment rescheduled from Thursday 29 October to Friday 30 October at 14:40.";
    expect(verdict(ask, "Dental check-up", moved)).toBe("conflict");
    expect(verdict("Confirm my dentist appointment on Friday 30 October", "Dental check-up", moved)).toBe("clear");
  });

  test("a block not tied to the request, or in a footer, is no conflict", () => {
    const ask = "When is my lunch with Oskar Lindgren?";
    const policy = "From: Oskar Lindgren <o@x.example>\n\nReminder that travel over £500 needs pre-approval.";
    expect(verdict(ask, "Expense policy", policy)).toBe("none");
    const footer =
      "From: Oskar Lindgren <o@x.example>\n\nLunch on Thursday works.\n-- \nOskar\nCONFIDENTIALITY NOTICE: This email " +
      "and any attachments are confidential and may not be shared.";
    expect(verdict(ask, "Re: Lunch", footer)).toBe("none");
  });

  test("a clearance needs something that could have blocked: a friendly line clears nothing", () => {
    expect(
      verdict("Where are we with the Globex deal?", "Globex call notes", "Globex are happy with the product."),
    ).toBe("none");
  });

  test("namesRef: an item naming the request's identifier", () => {
    const f = frame("Pay INV-7174 today");
    expect(namesRef(f, item("Payment sent", "Transfer for INV-7174"))).toBe(true);
    expect(namesRef(f, item("Payment sent", "Transfer for INV-7157"))).toBe(false);
  });

  test("a restriction that has ended frees the request; a thing the request needs that has ended does not", () => {
    const ended = "Your minimum term ended on 30 Jun 2026, so you can end the plan any time with no charge.";
    expect(verdict("Cancel Hooli today", "Hooli: your agreement", ended)).toBe("clear");
    expect(verdict("Cancel Hooli today", "Hooli: your agreement", "The freeze on cancellations has ended.")).toBe(
      "clear",
    );
    expect(verdict("book flights abroad on my passport", "Passport", "Your passport expired on 30 Sep.")).toBe(
      "conflict",
    );
  });

  test("a clearance undoes a conflict about the same matter in another form of its word", () => {
    const text =
      "finally got the allergy clinic results back this morning. " +
      "I'm not allergic to shellfish after all, test was negative, so panic over.";
    expect(verdict("Book a seafood lunch for me and Ana Ruiz", "allergy test results", text)).toBe("clear");
  });

  test("a range over the new year, read in summer, ends in the year after its start", () => {
    const july = Date.parse("2026-07-01T09:00:00Z");
    const deploy = "Deploy the billing release to production";
    const at = (text: string, days: string[] | null = null) =>
      assess(frameOf(deploy, days, july, []), item("Freeze", text), july);
    expect(at("Release freeze 20 Dec - 5 Jan: no production releases over the holidays.")).not.toBe("conflict");
    expect(at("Release freeze 20 Dec to 5 Jan: no production releases over the holidays.")).not.toBe("conflict");
    // A day inside it, the year after its start, is covered.
    const jan2 = ["2027-01-02"];
    expect(at("Release freeze 20 Dec - 5 Jan: no production releases.", jan2)).toBe("conflict");
    expect(at("Release freeze from Dec 20 to Jan 5: no production releases.", jan2)).toBe("conflict");
  });

  test("a block that remains, stays or holds is confirmed, not cleared", () => {
    const deploy = "Deploy the billing release to production on Thursday 5 November";
    for (const text of [
      "The production release freeze remains in place until 9 Nov.",
      "The release freeze stays in place until 9 Nov.",
      "Release freeze 4-9 Nov still holds for production.",
      "Release freeze 4-9 Nov: the freeze is still active for production.",
    ]) {
      expect(verdict(deploy, "Freeze", text)).toBe("conflict");
    }
    // Before any block, the same words still clear ("the booking stands", after a freeze lifted).
    expect(verdict(deploy, "Freeze", "Release freeze 4-9 Nov. Update: the production release slot stands.")).toBe(
      "clear",
    );
  });

  test("an impossible date is no date", () => {
    // Read as a real day, "31 Feb" would be 3 Mar, and a payment on 4 Mar would be late.
    expect(verdict("Pay the Hooli invoice on 4 March", "Payment terms", "Hooli payment is due by 31 Feb.")).toBe(
      "none",
    );
    expect(verdict("Pay the Hooli invoice on 4 March", "Payment terms", "Hooli payment is due by 3 Mar.")).toBe(
      "conflict",
    );
  });

  test("hostile input stays linear (32 KB)", () => {
    const shapes = [
      "do not ".repeat(4_600),
      "1".repeat(32_000),
      "12 to ".repeat(5_400),
      "from 1 nov ".repeat(3_000),
      "above £1".repeat(4_000),
      "no a".repeat(8_000),
      "[09:14] a: ".repeat(3_000),
      `${"a".repeat(31_000)} until`,
      "push ".repeat(6_400),
      "q3 ".repeat(10_000),
      `${"7".repeat(2_000)}%`,
    ];
    for (const text of shapes) {
      const t0 = performance.now();
      const f = frameOf(text, null, NOW, [text.slice(0, 40)]);
      assess(f, item(text.slice(0, 200), text), NOW);
      assess(frame("Pay £50k to Hooli by Friday 30 October"), item("x", text), NOW);
      expect(performance.now() - t0).toBeLessThan(300);
    }
  });
});

describe("the conflict ground in the engine (groundConflict, quietClear)", () => {
  const at = NOW;
  const run = async (config: Record<string, unknown>, docs: { ref: string; title: string; text: string }[]) => {
    const p = new ContextPartner({
      sources: async () => [new StaticSource("drive", "Notes", docs)],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => at,
      config: { probes: true, probeGraceMs: 1_000, ...config },
    });
    const out: Record<string, string[]> = {};
    // Two users with the same request: what one's sources say never reaches the other.
    for (const userId of ["u1", "u2"]) {
      const scope = { tenantId: "t", userId };
      const text = "Raise a PO for the Aperture Labs licence renewal, £48k, and route it to the CFO";
      const r = await p.observe({ ...scope, sessionId: "s", at, kind: "user_message", text } as AgentEvent, {
        waitMs: 1_000,
      });
      out[userId] = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId: "s" })].flatMap(
        (i) => i.citations.map((c) => `${c.itemId} ${i.reason.split(":")[0]}`),
      );
    }
    return out;
  };
  const policy = (limit: string) => ({
    ref: "p1",
    title: "Procurement policy v4",
    text: `Purchases above ${limit}, including licence renewals, require two competing quotes and CFO sign-off.`,
  });

  test("an item over the request's amount is grounded with no model; the near-miss twin is not pushed", async () => {
    // Nothing is sure on its words alone and the plain fallback is off: only grounding can deliver.
    const base = { confidentScore: 99, fallbackMatchedTerms: 0 };
    expect((await run({ ...base, groundConflict: true }, [policy("£40,000")])).u1).toEqual([
      "drive:p1 grounded-conflict",
    ]);
    expect((await run(base, [policy("£40,000")])).u1).toEqual([]);
    expect((await run({ ...base, groundConflict: true }, [policy("£75,000")])).u1).toEqual([]);
    // The twin on the confident path: delivered on its words without `quietClear`, held back with it.
    const sure = { confidentScore: 0.1, minMatchedTerms: 1 };
    expect((await run(sure, [policy("£75,000")])).u1).toEqual(["drive:p1 sources"]);
    expect((await run({ ...sure, quietClear: true }, [policy("£75,000")])).u1).toEqual([]);
  });

  test("the request's today is the user's: a deadline is not past while it is still that day where they are", async () => {
    // 20:00 on 31 Dec in Los Angeles is 04:00 on 1 Jan UTC; the user's calendar gives their offset.
    const late = Date.parse("2027-01-01T04:00:00Z");
    const deadline = { ref: "p", title: "Expenses policy", text: "Submit your expense report by 31 Dec." };
    const run = async (calendar: boolean) => {
      const cache = new ItemCache();
      const scope = { tenantId: "t", userId: "la" };
      if (calendar) {
        const start = "2026-12-31T19:00:00-08:00";
        cache.put(scope, [
          { id: "cal:e", sourceId: "cal", ref: "e", title: "Dinner", text: "Dinner", meta: { start } },
        ]);
      }
      const p = new ContextPartner({
        sources: async () => [new StaticSource("drive", "Notes", [deadline])],
        sourceMap: new SourceMap(),
        cache,
        budget: new Budget(),
        model: null,
        now: () => late,
        config: {
          probes: true,
          probeGraceMs: 1_000,
          confidentScore: 99,
          fallbackMatchedTerms: 0,
          groundConflict: true,
        },
      });
      const text = "Submit my expense report";
      const r = await p.observe({ ...scope, sessionId: "s", at: late, kind: "user_message", text } as AgentEvent, {
        waitMs: 1_000,
      });
      return [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId: "s" })].map(
        (i) => i.reason.split(":")[0],
      );
    };
    // In UTC it is 1 Jan and the deadline has passed; in Los Angeles it is still 31 Dec.
    expect(await run(false)).toEqual(["grounded-conflict"]);
    expect(await run(true)).toEqual([]);
  });

  test("isolation: each user's verdict comes from their own sources' items, under their own scope", async () => {
    const out = await run({ confidentScore: 99, fallbackMatchedTerms: 0, groundConflict: true }, [policy("£40,000")]);
    expect(out.u1).toEqual(["drive:p1 grounded-conflict"]);
    expect(out.u2).toEqual(["drive:p1 grounded-conflict"]);
  });
});
