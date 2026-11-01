import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { assess, frameOf } from "./conflict";
import { timeWindow } from "./grounding";
import { ContextPartner } from "./partner";
import { cleanEntities, isImperative, MORE_VERBS } from "./probes";
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
const frame = (request: string, vocab: boolean) =>
  frameOf(request, timeWindow(request, NOW)?.days ?? null, NOW, cleanEntities(extractEntities(request)), vocab);
/** The verdict without and with `conflictVocab`. */
const both = (request: string, title: string, text: string) =>
  [false, true].map((v) => assess(frame(request, v), item(title, text), NOW));

describe("conflictVocab: more ways to say an action is blocked (D75)", () => {
  test("an open end: until further notice", () => {
    const text = "Until further notice, no site visits to Initech; all contact goes through legal.";
    expect(both("Arrange a site visit to Initech next week", "Legal", text)).toEqual(["none", "conflict"]);
  });

  test("not signed, revoked, refused", () => {
    expect(both("Share the data export with Contoso", "DPA status", "Contoso: DPA not signed yet.")).toEqual([
      "none",
      "conflict",
    ]);
    expect(both("Give Priya Shah access to the finance drive", "Access", "Priya Shah: access revoked.")).toEqual([
      "none",
      "conflict",
    ]);
  });

  test("someone off over the day the request acts on, from their own message", () => {
    const text = "From: Marta Ruiz <marta@example.com>\n\nI'm off from 2 Nov to 13 Nov, back after that.";
    expect(both("Book a call with Marta on Thursday 5 November", "Leave", text)).toEqual(["none", "conflict"]);
    // Off on other days: no conflict, as before.
    const elsewhere = "From: Marta Ruiz <marta@example.com>\n\nI'm off from 16 Nov to 20 Nov.";
    expect(both("Book a call with Marta on Thursday 5 November", "Leave", elsewhere)[1]).not.toBe("conflict");
  });

  test("an order to hold, a hold on an account, no new commitments", () => {
    const hold = "Hold all customer emails to the full list until the migration is done.";
    expect(both("Send the customer update to the full list tomorrow", "Ops", hold)).toEqual(["none", "conflict"]);
    const account = "Account: Umbrella Corp\nStatus: credit hold";
    expect(both("Approve the extra seats for Umbrella Corp", "Umbrella Corp account", account)).toEqual([
      "none",
      "conflict",
    ]);
    const spend = "Vendors: Stark Ltd is under review; no new spend with Stark Ltd.";
    expect(both("Raise a purchase order with Stark Ltd for the laptops", "Vendors", spend)).toEqual([
      "none",
      "conflict",
    ]);
  });

  test("a plan dropped, a thing out of action", () => {
    const dropped = "Decisions: the printed brochures were scrapped, we go digital only.";
    expect(both("Order the printed brochures for the expo", "Minutes", dropped)).toEqual(["none", "conflict"]);
    const car = "From: Ben Ode <ben@example.com>\n\nMy van's in for repairs until the 12th, so I'm on foot for now.";
    expect(both("Ask Ben to help me move the sofa on Saturday", "van", car)).toEqual(["none", "conflict"]);
  });

  test("a standing constraint: someone who has stopped drinking, possessive names tie", () => {
    const text = "From: Nia Cole <nia@example.com>\n\nI've stopped drinking for good, feeling great.";
    expect(both("Buy a bottle of champagne to take to Nia's party", "news", text)).toEqual(["none", "conflict"]);
  });

  test("a security alert stands whatever its date", () => {
    const text = "The account details for your payee TOM REED were changed on 20 Oct from a device we don't recognise.";
    expect(both("Transfer £500 to Tom for the tickets", "Alert", text)).toEqual(["clear", "conflict"]);
  });

  test("someone travelling until a day after the one acted on", () => {
    const text = "Dad's off to Lisbon with his brother, back 10 Nov.";
    expect(both("Have flowers delivered to Dad on Sunday", "Dad", text)).toEqual(["none", "conflict"]);
  });
});

describe("conflictVocab: what is not a block or a clearance", () => {
  test("an idiom is no block", () => {
    const text = "From: Kai Lee <kai@example.com>\n\nI can't wait for Friday, see you at seven!";
    expect(both("Bring a cake for Kai on Friday", "Friday", text)).toEqual(["conflict", "none"]);
  });

  test("a sign-off courtesy does not clear a block", () => {
    const text = "Please don't book the venue yourself, I'll do it. Happy to jump on a call if easier.";
    expect(both("Book the venue for the workshop today", "venue", text)).toEqual(["clear", "conflict"]);
  });

  test("a table row about another party does not clear the named one's", () => {
    const table =
      "| Supplier | Status |\n|---|---|\n| Acme Tools | Suspended |\n| Globo Parts | Approved |\n| Initrode | Approved |";
    expect(both("Order 40 drills from Acme Tools", "Suppliers", table)).toEqual(["clear", "conflict"]);
    // The named one approved and another suspended: no conflict for the named one.
    const other = "| Supplier | Status |\n|---|---|\n| Acme Tools | Approved |\n| Globo Parts | Suspended |";
    expect(both("Order 40 drills from Acme Tools", "Suppliers", other)[1]).not.toBe("conflict");
  });

  test("prose: a clearance need not repeat the name", () => {
    const text = "Launch for Hooli was blocked on the security review, but it passed yesterday and the date holds.";
    expect(both("Tell Hooli the launch is on for Friday", "launch", text)[1]).toBe("clear");
  });

  test("a hold released clears", () => {
    const text = "Account: Umbrella Corp\nCredit hold released on 2 Oct, balance paid.";
    expect(both("Approve the extra seats for Umbrella Corp", "Umbrella Corp account", text)[1]).toBe("clear");
  });

  test("another domain is a sibling reference", () => {
    const text = "Let acme-promo.com lapse at expiry; do not renew.";
    expect(both("Renew the acme-events.com domain", "Domains", text)).toEqual(["conflict", "clear"]);
    const same = "Let acme-events.com lapse at expiry; do not renew.";
    expect(both("Renew the acme-events.com domain", "Domains", same)).toEqual(["conflict", "conflict"]);
  });
});

describe("conflictVocab: dates", () => {
  /** The verdict with the flag on for an item written at `sent` (none: no date known). */
  const dated = (request: string, text: string, sent?: number) =>
    assess(frame(request, true), { ...item("Room", text), ...(sent ? { updatedAt: sent } : {}) }, NOW);

  test("a day of the month alone and a weekday after an end word", () => {
    const ordinal = "The meeting room is unavailable until the 3rd for the audit.";
    // Written today, 27 Oct: "the 3rd" is 3 Nov, so a visit on Friday 30 Oct falls inside.
    expect(dated("Book the meeting room for Friday 30 October", ordinal, NOW)).toBe("conflict");
    const weekday = "The meeting room is unavailable until Thursday for the audit.";
    expect(dated("Book the meeting room for Monday 2 November", weekday, NOW)).not.toBe("conflict");
    expect(dated("Book the meeting room for Wednesday 28 October", weekday, NOW)).toBe("conflict");
  });

  test("a relative date counts from when the message was written, not from the request", () => {
    // Sent Thursday 1 Oct: "back Monday" meant 5 Oct, not the Monday after the request.
    const sent = Date.parse("2026-10-01T09:00:00Z");
    const weekday = "From: Leila Haddad\nI'm off until Monday, back Monday.";
    const ask = "Ask Leila Haddad to approve the invoice on Friday";
    expect(assess(frame(ask, false), { ...item("Re: invoices", weekday), updatedAt: sent }, NOW)).toBe("none");
    expect(assess(frame(ask, true), { ...item("Re: invoices", weekday), updatedAt: sent }, NOW)).not.toBe("conflict");
    // Sent 1 Sep: "till the 10th" was 10 Sep.
    const ordinal = "From: Leila Haddad\nI'm off till the 10th.";
    const sign = "Ask Leila Haddad to sign the contract on Thursday 5 November";
    const old = { ...item("Holiday", ordinal), updatedAt: Date.parse("2026-09-01T09:00:00Z") };
    expect(assess(frame(sign, true), old, NOW)).not.toBe("conflict");
    // The Date: header says when it was sent, ahead of `updatedAt`.
    const headed = item("Room", "Date: Thu, 1 Oct 2026 09:00:00 +0000\nThe meeting room is unavailable until the 3rd.");
    expect(assess(frame("Book the meeting room for Friday 30 October", true), headed, NOW)).not.toBe("conflict");
    // No date known: the relative date is not read, so the verdict is the one without the flag's dates.
    const undated = "The meeting room is unavailable until the 3rd.";
    const room = "Book the meeting room for Monday 9 November";
    expect(dated(room, undated)).toBe(assess(frame(room, false), item("Room", undated), NOW));
  });
});

describe("conflictVocab: precision", () => {
  test("something released is not a block lifted; a hold released is", () => {
    const freeze =
      "Production change freeze for billing until 6 November. The billing hotfix was released to staging yesterday.";
    expect(both("Deploy the billing service to production on Thursday 29 October", "Change freeze", freeze)).toEqual([
      "conflict",
      "conflict",
    ]);
    const lifted = "Production change freeze for billing until 6 November. Update: the freeze was released today.";
    expect(both("Deploy the billing service to production on Thursday 29 October", "Change freeze", lifted)[1]).toBe(
      "clear",
    );
  });

  test("a word with no object of its own blocks only what the request names", () => {
    const from = (text: string) => `From: Priya Shah <priya@example.com>\n${text}`;
    expect(
      both(
        "Book dinner with Priya Shah on Friday",
        "Re",
        from("My card was declined at the shop, ha. See you Friday!"),
      )[1],
    ).not.toBe("conflict");
    const sam = (text: string) => `From: Sam Lee <sam@example.com>\n${text}`;
    const table = "Book a table for me and Sam on Friday";
    expect(both(table, "Re", sam("Sam declined the second helping, Friday dinner is on."))[1]).not.toBe("conflict");
    expect(both(table, "Re", sam("The proposal was rejected by the board but Sam is free Friday."))[1]).not.toBe(
      "conflict",
    );
    expect(both("Send Priya the Q4 deck on Friday", "Re", from("Our partners abroad loved the Q3 deck."))[1]).not.toBe(
      "conflict",
    );
    // Tied to the request's own thing, it still blocks.
    expect(both("Book a table for four on Friday", "Re", "Your table booking request was declined.")[1]).toBe(
      "conflict",
    );
  });
});

describe("conflictVocab: more leading verbs", () => {
  test("only with the wider set", () => {
    expect(isImperative("Transfer £200 to Sam for the tickets")).toBe(false);
    expect(isImperative("Transfer £200 to Sam for the tickets", MORE_VERBS)).toBe(true);
    expect(isImperative("Renew the parking permit", MORE_VERBS)).toBe(true);
    expect(isImperative("What did Sam say about tickets?", MORE_VERBS)).toBe(false);
  });
});

describe("conflictVocab through the engine", () => {
  const blocking: ContextItem = {
    id: "mail:1",
    sourceId: "mail",
    ref: "1",
    title: "Vendors",
    text: "Vendors: Stark Ltd is under review; no new spend with Stark Ltd.",
    updatedAt: NOW - 86_400_000,
  };
  const run = async (conflictVocab: boolean, userId = "u1") => {
    const partner = new ContextPartner({
      sources: async () => [new StaticSource("mail", "Mail", [blocking])],
      sourceMap: new SourceMap(":memory:"),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: {
        probes: true,
        probeGraceMs: 1_000,
        confidentScore: 99,
        fallbackMatchedTerms: 0,
        groundConflict: true,
        quietNameOnly: true,
        conflictVocab,
      },
    });
    const scope = { tenantId: "t", userId, sessionId: "s" };
    await partner.observe({ ...scope, at: NOW, kind: "session_start" } as AgentEvent);
    const r = await partner.observe(
      {
        ...scope,
        at: NOW,
        kind: "user_message",
        text: "Raise a purchase order with Stark Ltd for laptops",
      } as AgentEvent,
      { waitMs: 2_000 },
    );
    const all = [r.injection, ...partner.takePending(scope)];
    const got = all.flatMap((x) => x?.citations ?? []).map((c) => c.itemId);
    return got.includes("mail:1");
  };

  test("off: as before; on: the block is raised", async () => {
    expect(await run(false)).toBe(false);
    expect(await run(true)).toBe(true);
  });
});
