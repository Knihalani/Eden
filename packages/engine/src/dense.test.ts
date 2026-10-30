import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { anchorsOf, foldEchoes } from "./fold";
import { ContextPartner } from "./partner";
import { compactText, messageParts } from "./render";

const item = (id: string, sourceId: string, title: string, text: string): ContextItem => ({
  id,
  sourceId,
  ref: id,
  title,
  text,
});

const EVENT_TEXT =
  "When: Wednesday 4 Nov 2026, 10:30–12:00\nWhere: Padella, London\nAttendees: Robin Carter, Nadia Petrova";
const INVITE_TITLE = "Invitation: Lunch with Nadia Petrova @ Wednesday 4 Nov 10:30";
const INVITE_TEXT =
  "From: Google Calendar <calendar-notification@google.com>\nDate: Mon, 26 Oct 2026 01:00\n\n" +
  "Lunch with Nadia Petrova Wednesday 4 Nov ⋅ 10:30 Padella, London Join with Google Meet: " +
  "https://meet.google.com/abc-defg-hij Invitation from Google Calendar. You are receiving this email because you are " +
  "an attendee on the event.";

describe("dense compaction (densePacket)", () => {
  const dense = (text: string, title: string, self: string | null = "Robin Carter") =>
    compactText(text, new Set(), 320, () => false, 2026, self, { title });

  test("a notification's echo of its own title and a footer run into the line go; the place stays", () => {
    expect(dense(INVITE_TEXT, INVITE_TITLE)).toBe("From: Google Calendar Date: Mon 26 Oct 01:00 Padella, London");
    // Without `dense`, as before: the echo and the run-in footer stay.
    expect(compactText(INVITE_TEXT, new Set(), 320, () => false, 2026, "Robin Carter")).toContain("Join with Google");
  });

  test("an attendee list leaves out the user and the people the title names; empty, the line goes", () => {
    expect(dense(EVENT_TEXT, "Lunch with Nadia Petrova")).toBe(
      "When: Wednesday 4 Nov, 10:30–12:00 Where: Padella, London",
    );
    expect(dense("Attendees: Robin Carter, Dana Lee, Rose Kimura", "Initech <> Northwind")).toBe(
      "Attendees: Dana Lee, Rose Kimura",
    );
    // A first name alone is not someone the title names in full: "Dana" in the title keeps "Dana Lee".
    expect(dense("Attendees: Dana Lee", "Robin / Dana 1:1")).toBe("Attendees: Dana Lee");
  });

  test("a sentence does not end at a title or street abbreviation", () => {
    expect(dense("Perfect, booked St. John for Tuesday 08:30. See you there!", "Re: Lunch?")).toBe(
      "Perfect, booked St. John for Tuesday 08:30. See you there!",
    );
    expect(dense("Ask Dr. Okafor. He knows.", "Dentist")).toBe("Ask Dr. Okafor. He knows.");
  });

  test("a greeting by the time of day and stock courtesies go; what follows stays", () => {
    const text = "Morning Robin, Sorry for the slow reply, it's been a week. Wednesday at 19:30 works.";
    expect(dense(text, "Re: Drinks?")).toBe("Wednesday at 19:30 works.");
  });

  test("header parts are marked as such", () => {
    const parts = messageParts("From: Dana Lee\nDate: Mon, 26 Oct 2026 01:00\n\nLet's meet.", undefined, 2026);
    expect(parts.map((p) => p.header)).toEqual([true, true, false]);
  });
});

describe("occurrence anchors", () => {
  test("a weekday and a time, however a source writes them", () => {
    expect(anchorsOf("When: Monday 2 Nov, 18:00–19:30")).toEqual(["mon|18:00"]);
    expect(anchorsOf("When: Monday 2 Nov 2026, 18:00–19:30")).toEqual(["mon|18:00"]);
    expect(anchorsOf("Drinks with Jamie @ Monday 2 Nov 18:00")).toEqual(["mon|18:00"]);
    expect(anchorsOf("Monday 2 Nov ⋅ 18:00 Hoppers")).toEqual(["mon|18:00"]);
    expect(anchorsOf("Perfect, booked Hoppers for Friday 9:30.")).toEqual(["fri|09:30"]);
    expect(anchorsOf("Yes! Thursday at 13:00 works.")).toEqual(["thu|13:00"]);
    // A word that starts like a weekday is none; a time with no day pins nothing.
    expect(anchorsOf("Monitor at 18:00")).toEqual([]);
    expect(anchorsOf("see you at 18:00")).toEqual([]);
  });
});

describe("folding echoes (densePacket)", () => {
  const x = (id: string, sourceId: string, title: string, text: string) => ({ item: item(id, sourceId, title, text) });
  const event = x("e", "calendar", "Lunch with Nadia Petrova", EVENT_TEXT);
  const fold = (xs: { item: ContextItem }[], rare: (w: string) => boolean = () => false) =>
    foldEchoes(xs, { focus: new Set(["nadia", "lunch"]), year: 2026, self: "Robin Carter", rare }).map(
      (y) => y.item.id,
    );

  test("the invitation for an event the packet already shows is folded out; the first item always stays", () => {
    const invite = x("i", "gmail", INVITE_TITLE, INVITE_TEXT);
    expect(fold([event, invite])).toEqual(["e"]);
    expect(fold([invite, event])).toEqual(["i"]);
    expect(fold([invite])).toEqual(["i"]);
  });

  test("an item that adds a constraint, a change, a number, a name or a rare word is no echo", () => {
    const reply = (text: string) => x("r", "gmail", "Re: Lunch?", `From: Nadia Petrova\n\n${text}`);
    // A constraint or a change.
    expect(fold([event, reply("Wednesday at 10:30 works. I'll have to leave by 11:45.")])).toEqual(["e", "r"]);
    expect(fold([event, reply("Wednesday at 10:30 is cancelled, sorry.")])).toEqual(["e", "r"]);
    // A place the packet does not show yet.
    expect(fold([event, reply("Perfect, booked St. John for Wednesday 10:30.")])).toEqual(["e", "r"]);
    // A word the user's items rarely hold.
    expect(fold([event, reply("Wednesday at 10:30 works, vegan please.")], (w) => w === "vegan")).toEqual(["e", "r"]);
    // The same words, common ones only: the reply that booked it.
    expect(fold([event, reply("Perfect, booked Padella for Wednesday 10:30.")])).toEqual(["e"]);
  });

  test("another occurrence is not an echo, however alike", () => {
    const other = x(
      "o",
      "calendar",
      "Lunch with Nadia Petrova",
      EVENT_TEXT.replace("Wednesday 4 Nov", "Thursday 5 Nov"),
    );
    expect(fold([event, other])).toEqual(["e", "o"]);
  });

  test("hostile text is read in linear time", () => {
    for (const n of [8_000, 32_000]) {
      const junk = [
        "Monday ".repeat(n / 7),
        "Mon 2 Nov ".repeat(n / 10),
        "a ".repeat(n / 2),
        "A, ".repeat(n / 3),
        "St. ".repeat(n / 4),
        `${"x ".repeat(n / 2)}Join with Google Meet`,
        "Morning ".repeat(n / 8),
      ];
      const t0 = performance.now();
      for (const j of junk) {
        anchorsOf(j);
        compactText(j, new Set(["x"]), 320, () => false, 2026, "Robin Carter", { title: j.slice(0, 400) });
        fold([event, x("h", "gmail", j.slice(0, 200), j)]);
      }
      expect(performance.now() - t0).toBeLessThan(1_500);
    }
  });
});

describe("rare words in the user's items (densePacket)", () => {
  const a = { tenantId: "t", userId: "a" };
  const b = { tenantId: "t", userId: "b" };

  test("a word on few of the user's items is rare, one on many is common; each user's items count for them alone", () => {
    const cache = new ItemCache();
    const items = Array.from({ length: 60 }, (_, k) =>
      item(`m${k}`, "gmail", `Note ${k}`, k < 30 ? "perfect, booked" : k === 30 ? "vegan" : "other words"),
    );
    cache.put(a, items, Date.parse("2026-10-27T09:00:00Z"));
    expect(cache.isRare(a, "perfect", 0.03)).toBe(false);
    expect(cache.isRare(a, "vegan", 0.03)).toBe(true);
    expect(cache.isRare(a, "unheard", 0.03)).toBe(true);
    // User b holds none of a's items: every word is rare to them (too few items for a share to mean anything).
    expect(cache.isRare(b, "perfect", 0.03)).toBe(true);
  });
});

describe("the engine (densePacket, groundOccasion, recoverNames)", () => {
  const scope = { tenantId: "t", userId: "u" };
  const at = Date.parse("2026-10-27T09:00:00Z");
  const partner = (sources: StaticSource[], config: Record<string, unknown>, sourceMap = new SourceMap()) =>
    new ContextPartner({
      sources: async () => sources,
      sourceMap,
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => at,
      config: { probes: true, probeGraceMs: 1_000, ...config },
    });
  const ask = async (p: ContextPartner, text: string, who = scope, kind = "user_message") => {
    const r = await p.observe({ ...who, sessionId: "s", at, kind, text } as AgentEvent, { waitMs: 1_000 });
    return [...(r.injection ? [r.injection] : []), ...p.takePending({ ...who, sessionId: "s" })];
  };
  const cites = (injs: Awaited<ReturnType<typeof ask>>) =>
    injs.flatMap((i) => i.citations.map((c) => `${c.itemId} ${i.reason.split(":")[0]}`));

  test("densePacket: a packet cites the event once, not its invitation too", async () => {
    const cal = new StaticSource("calendar", "Calendar", [
      { ref: "e1", title: "Lunch with Nadia Petrova", text: EVENT_TEXT, meta: { start: "2026-11-04T10:30:00Z" } },
    ]);
    const mail = new StaticSource("gmail", "Mail", [{ ref: "i1", title: INVITE_TITLE, text: INVITE_TEXT }]);
    // Both items are sure on their words alone: the confident path delivers them together.
    const config = { compactInjection: true, confidentScore: 0.1, minMatchedTerms: 1 };
    const text = "When is lunch with Nadia Petrova on Wednesday?";
    const plain = await ask(partner([cal, mail], config), text);
    expect(plain.flatMap((i) => i.citations).length).toBe(2);
    const dense = await ask(partner([cal, mail], { ...config, densePacket: true }), text);
    expect(dense.flatMap((i) => i.citations).length).toBe(1);
    expect(dense[0]!.text).toContain("Padella");
    expect(dense[0]!.text.length).toBeLessThan(plain[0]!.text.length);
  });

  // Nothing is sure on its words alone, and the plain fallback is off: only grounding can deliver.
  const quiet = { confidentScore: 99, fallbackMatchedTerms: 0 };
  const occasions = () => [
    new StaticSource("calendar", "Calendar", [
      {
        ref: "lunch",
        title: "Lunch with Nadia Petrova",
        text: "When: Wednesday 4 Nov 2026, 10:30–12:00\nWhere: Padella, London",
        meta: { start: "2026-11-04T10:30:00Z", people: "Nadia Petrova <nadia@x.example>" },
      },
      {
        ref: "past",
        title: "Lunch with Nadia Petrova",
        text: "When: Monday 19 Oct 2026, 12:00–13:00\nWhere: Hoppers, London",
        meta: { start: "2026-10-19T12:00:00Z", people: "Nadia Petrova <nadia@x.example>" },
      },
      {
        ref: "one",
        title: "Robin / Nadia 1:1",
        text: "When: Tuesday 3 Nov 2026, 09:00–09:30\nLunch plans and the Q4 hiring plan",
        meta: { start: "2026-11-03T09:00:00Z", people: "Nadia Petrova <nadia@x.example>" },
      },
    ]),
  ];

  test("groundOccasion: the next event whose title holds the occasion and the name, a first name alone included", async () => {
    const text = "What time am I seeing Nadia for lunch?";
    expect(cites(await ask(partner(occasions(), { ...quiet, groundOccasion: true }), text))).toEqual([
      "calendar:lunch grounded-occasion-person",
    ]);
    expect(cites(await ask(partner(occasions(), quiet), text))).toEqual([]);
  });

  test("groundOccasion: by occasion and day for a question; a day no such event is on grounds nothing", async () => {
    const on = await ask(
      partner(occasions(), { ...quiet, groundOccasion: true }),
      "Where are we having lunch on Wednesday 4 November?",
    );
    expect(cites(on)).toEqual(["calendar:lunch grounded-occasion-day"]);
    // A new occasion on another day ("an invite for lunch on Saturday") is not the one on Wednesday.
    const other = await ask(
      partner(occasions(), { ...quiet, groundOccasion: true }),
      "Send Nadia an invite for lunch on Saturday",
    );
    expect(cites(other).filter((c) => c.includes("occasion"))).toEqual([]);
  });

  test("groundOccasion: a message from someone about meeting grounds the next event that names them", async () => {
    const text = 'New email from Nadia Petrova: "Running a bit late, still ok to meet?"';
    const got = cites(await ask(partner(occasions(), { ...quiet, groundOccasion: true }), text, scope, "external"));
    expect(got).toEqual(["calendar:lunch grounded-occasion-sender"]);
  });

  test("recoverNames: a name typed in lowercase grounds as a capitalised one does, from this user's sources only", async () => {
    const drinks = (title: string) =>
      new StaticSource("calendar", "Calendar", [
        {
          ref: "d1",
          title,
          text: "When: Monday 2 Nov 2026, 19:00–20:30\nWhere: Rochelle Canteen, London",
          meta: { start: "2026-11-02T19:00:00Z", people: "Chen Wei <chen.wei@x.example>" },
        },
      ]);
    const text = "please reschedule my drinks with chen wei";
    const map = new SourceMap();
    const a = { tenantId: "t", userId: "a" };
    const b = { tenantId: "t", userId: "b" };
    // User a's sources write the name capitalised (a recorded mention); user b's never do.
    const sources = async (s: { userId: string }) => [drinks(s.userId === "a" ? "Drinks with Chen Wei" : "drinks")];
    const p = (recoverNames: boolean) =>
      new ContextPartner({
        sources,
        sourceMap: map,
        cache: new ItemCache(),
        budget: new Budget(),
        model: null,
        now: () => at,
        config: { probes: true, probeGraceMs: 1_000, ...quiet, recoverNames },
      });
    expect(cites(await ask(p(true), text, a))).toEqual(["calendar:d1 grounded-person"]);
    expect(cites(await ask(p(false), text, a))).toEqual([]);
    // b's item has the same participant, but b's sources never named "Chen Wei": a's record is not b's.
    expect(cites(await ask(p(true), text, b))).toEqual([]);
  });
});
