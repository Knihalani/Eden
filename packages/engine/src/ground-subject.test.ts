import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner, StaticSource, type Source } from "@eden/sources";
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

describe("groundSubject: a request about a subject it names gets the context around it", () => {
  // Wednesday 11 November 2026, noon UTC.
  const at = Date.parse("2026-11-11T12:00:00Z");
  const mail = new StaticSource("mail", "Mail", [
    {
      ref: "ba-booking",
      title: "Your booking ABC123: London to Lisbon",
      text: "Flight BA 500, Friday 13 Nov, departs LHR 07:25, seat 14C. Booking reference ABC123.",
    },
    {
      ref: "ba-policy",
      title: "Changing your BA booking",
      text: "Changes to Economy Light fares cost 65 GBP per person plus the fare difference.",
    },
    {
      ref: "train",
      title: "Lisbon train reservation",
      text: "Comboio Lisboa, Saturday 14 Nov, 08:00.",
    },
  ]);
  const calendar = new StaticSource("calendar", "Calendar", [
    { ref: "evt-lisbon", title: "Lisbon trip", text: "Flight out Friday 13 Nov, back Sunday 15 Nov." },
  ]);
  const run = async (text: string, extra: Partial<PartnerDeps> = {}, sources = [mail, calendar]) => {
    const { p, traces } = partner(extra, sources);
    const sessionId = `g${clock++}`;
    const event = { ...scope, sessionId, at, kind: "user_message", text };
    const r = await p.observe(event as AgentEvent, { waitMs: 1_000 });
    const ids = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId })].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
    return { ids, reasons: traces.map((t) => t.reason) };
  };

  test("the booking and the event it is about, and the train the move would clash with", async () => {
    const { ids, reasons } = await run("Can you move my Lisbon flight to the Saturday morning instead?", {
      config: { groundSubject: true },
    });
    expect(ids.sort()).toEqual(["calendar:evt-lisbon", "mail:ba-booking", "mail:train"]);
    expect(reasons.some((r) => r.startsWith("grounded-subject:"))).toBe(true);
  });

  test("a move names the day it lands on: the day's items join, even ones naming nothing else of the request", async () => {
    const cal = new StaticSource("calendar", "Calendar", [
      {
        ref: "dentist",
        title: "Dentist appointment",
        text: "Saturday 14 Nov, in the morning.",
        meta: { start: "2026-11-14T10:30:00Z" },
      },
    ]);
    const { ids } = await run(
      "Can you move my Lisbon flight to the Saturday morning instead?",
      {
        config: { groundSubject: true },
      },
      [mail, cal],
    );
    expect(ids).toContain("calendar:dentist");
  });

  test("a move naming both days leaves the origin day's items out of the packet", async () => {
    const cal = new StaticSource("calendar", "Calendar", [
      {
        ref: "standup",
        title: "Team standup",
        text: "Weekly standup, Friday 13 Nov, 09:00.",
        meta: { start: "2026-11-13T09:00:00Z" },
      },
      {
        ref: "dentist",
        title: "Dentist appointment",
        text: "Saturday 14 Nov, 10:30.",
        meta: { start: "2026-11-14T10:30:00Z" },
      },
    ]);
    const { ids } = await run(
      "Move my Lisbon flight from Friday 13 Nov to Saturday 14 Nov",
      {
        config: { groundSubject: true },
      },
      [mail, cal],
    );
    expect(ids).toContain("calendar:dentist");
    expect(ids).not.toContain("calendar:standup");
  });

  test("an availability ask on a named day is the day's question, not the subject's", async () => {
    const cal = new StaticSource("calendar", "Calendar", [
      {
        ref: "dentist",
        title: "Dentist appointment",
        text: "On Friday 13 Nov — the Lisbon flight has to wait.",
        meta: { start: "2026-11-13T10:30:00Z" },
      },
    ]);
    const { ids } = await run("Is Friday free for a Lisbon flight?", { config: { groundSubject: true } }, [mail, cal]);
    expect(ids).toContain("calendar:dentist");
  });

  test("the companion search hands an item the request's own words never rank", async () => {
    const shop = new StaticSource("mail", "Mail", [
      { ref: "kettle", title: "Your Smeg kettle order", text: "Ordered 2 March, arrived 5 March." },
      {
        ref: "policy",
        title: "Lakeland returns policy",
        text: "Smeg appliances: returns within 30 days of purchase for a faulty kettle.",
      },
    ]);
    const { ids } = await run("Can I still get a refund on the Smeg kettle?", { config: { groundSubject: true } }, [
      shop,
    ]);
    expect(ids).toContain("mail:policy");
  });

  test("a dated item about the subject is handed; the undated look-alike on the same word is not", async () => {
    const notion = new StaticSource("mail", "Mail", [
      {
        ref: "renew",
        title: "Your Notion Plus plan renews on 5 Nov",
        text: "Your plan renews at 10 USD per member per month, up from 8 USD.",
      },
      { ref: "tips", title: "5 ways to use Notion AI", text: "Tips for summarising pages." },
    ]);
    const { ids } = await run("Is my Notion subscription going up in price?", { config: { groundSubject: true } }, [
      notion,
    ]);
    expect(ids).toEqual(["mail:renew"]);
  });

  test("an entity used as a setting anchors nothing", async () => {
    const travel = new StaticSource("calendar", "Calendar", [
      { ref: "delhi", title: "Delhi trip", text: "Fly out 28 November, back 20 December." },
    ]);
    const { ids } = await run(
      "Recommend three novels set in Delhi for the flight",
      { config: { groundSubject: true } },
      [travel],
    );
    expect(ids).toEqual([]);
  });

  test("off in the core: the subject items stay silent", async () => {
    const { ids, reasons } = await run("Can you move my Lisbon flight to the Saturday morning instead?");
    expect(ids).not.toContain("mail:ba-booking");
    expect(ids).not.toContain("calendar:evt-lisbon");
    expect(reasons.some((r) => r.startsWith("grounded-subject:"))).toBe(false);
  });

  test("no entity, no subject", async () => {
    const { ids } = await run("Can you move my appointment to the Saturday morning instead?", {
      config: { groundSubject: true },
    });
    expect(ids).not.toContain("mail:ba-booking");
  });
});
