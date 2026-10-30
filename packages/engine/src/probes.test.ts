import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { timeWindow } from "./grounding";
import { ContextPartner } from "./partner";
import { cleanEntities, isScheduling, orgsOf, requestedRange, topicOf } from "./probes";
import { extractEntities } from "./text";

const item = (text: string, meta?: Record<string, string>): ContextItem => ({
  id: `x:${text.slice(0, 8)}`,
  sourceId: "x",
  ref: text.slice(0, 8),
  title: "",
  text,
  ...(meta ? { meta } : {}),
});

describe("probes: what a request implies", () => {
  test("a sentence's leading verb is not part of the name it starts; possessives are dropped", () => {
    expect(cleanEntities(["Send Rose Kimura", "Offer Globex", "Sam's", "Ask"])).toEqual([
      "Rose Kimura",
      "Globex",
      "Sam",
    ]);
    expect(cleanEntities(["Dana Lee", "Initech Capital"])).toEqual(["Dana Lee", "Initech Capital"]);
  });

  test("any capital starts a name, not only ASCII ones", () => {
    expect(extractEntities("Ask Łukasz Nowak to review it")).toContain("Ask Łukasz Nowak");
    expect(cleanEntities(extractEntities("Ask Łukasz Nowak to review it"))).toEqual(["Łukasz Nowak"]);
  });

  test("the time a request names is a window around it; a part of the day is its hours; none is null", () => {
    expect(requestedRange("dinner on Thursday at 19:00")).toEqual({ from: 960, to: 1320 });
    expect(requestedRange("call at 3pm tomorrow")).toEqual({ from: 720, to: 1080 });
    expect(requestedRange("a workshop Thursday afternoon")).toEqual({ from: 720, to: 1080 });
    expect(requestedRange("send the report")).toBeNull();
    expect(isScheduling("Set up dinner with Dana on Friday")).toBe(true);
    expect(isScheduling("Send Rose the Q3 report")).toBe(false);
  });

  test("the topic is what is neither a person, a day nor the action, at most two words", () => {
    expect(topicOf(["send", "rose", "kimura", "q3", "report"], ["Rose Kimura"])).toBe("q3 report");
    expect(topicOf(["ask", "review", "board", "deck", "friday"], [])).toBe("review board");
    expect(topicOf(["tomorrow", "3pm"], [])).toBe("");
  });

  test("a person's organisation: their address's domain matched to a name in the same results", () => {
    const items = [
      item("From: Sam Ortiz <sam.ortiz@globexventures.example>\nTo: Robin\n\nSee you Friday"),
      item("Globex Ventures renewal notes: pricing, legal review"),
    ];
    expect(orgsOf(["Sam Ortiz"], items)).toEqual(["Globex Ventures"]);
    // Free mail names no organisation, and another person's address is not theirs.
    expect(orgsOf(["Sam Ortiz"], [item("From: Sam Ortiz <sam@gmail.com>"), item("Gmail tips")])).toEqual([]);
    expect(orgsOf(["Dana Lee"], items)).toEqual([]);
  });

  test("a weekday written with its date is that date, not the coming one", () => {
    const now = Date.parse("2026-10-27T09:00:00Z"); // Tuesday
    expect([...timeWindow("the workshop on Wednesday 4 November at 10:00", now)!.days]).toEqual(["2026-11-04"]);
    expect([...timeWindow("Wednesday, Nov 4", now)!.days]).toEqual(["2026-11-04"]);
    expect([...timeWindow("on Wednesday", now)!.days]).toEqual(["2026-10-28"]);
  });
});

describe("probes in the engine (config.probes)", () => {
  const scope = { tenantId: "t", userId: "u" };
  const at = Date.parse("2026-10-27T09:00:00Z");
  const calendar = (start: string) =>
    new StaticSource("calendar", "Calendar", [
      { ref: "pe", title: "Parents' evening", text: "Hall B", meta: { start } },
      { ref: "standup", title: "Standup", text: "daily", meta: { start: "2026-10-29T09:00:00Z" } },
    ]);
  const run = async (source: StaticSource, probes: boolean, text: string) => {
    let calls = 0;
    const counted: Source = {
      id: source.id,
      kind: "test",
      description: source.description,
      listsByTime: source.listsByTime,
      search: (q) => (calls++, source.search(q)),
    };
    const p = new ContextPartner({
      sources: async () => [counted],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => at,
      config: { probes },
    });
    const sessionId = "s";
    const r = await p.observe({ ...scope, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 1_000 });
    const got = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId })].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
    return { got, calls };
  };
  const ask = "Set up dinner with Jamie Fox on Thursday 29 October at 19:00";

  test("an event near the time a scheduling request names, on its day, is a clash, whoever it is with", async () => {
    const on = await run(calendar("2026-10-29T18:30:00Z"), true, ask);
    expect(on.got).toEqual(["calendar:pe"]);
    // The same event the next week (the decoy) is no clash, and the morning standup is too far from 19:00.
    expect((await run(calendar("2026-11-05T18:30:00Z"), true, ask)).got).toEqual([]);
    // Off by default: the request's words alone do not find it.
    expect((await run(calendar("2026-10-29T18:30:00Z"), false, ask)).got).toEqual([]);
  });

  test("probes stay within probeCalls", async () => {
    const { calls } = await run(calendar("2026-10-29T18:30:00Z"), true, ask);
    expect(calls).toBeLessThanOrEqual(1 + 8);
  });
});

describe("probe state is the session's own (isolation)", () => {
  const at = Date.parse("2026-10-27T09:00:00Z");
  const notes = new StaticSource("drive", "Notes", [
    { ref: "n1", title: "People notes", text: "Dana Lee: severe nut allergy" },
    { ref: "n2", title: "Dana Lee intro", text: "Met Dana Lee at the offsite" },
  ]);
  test("a repeat in one session reuses its probes; another user probes afresh", async () => {
    let calls = 0;
    const counted: Source = {
      id: "drive",
      kind: "test",
      description: "Notes",
      search: (q) => (calls++, notes.search(q)),
    };
    const cache = new ItemCache();
    const p = new ContextPartner({
      sources: async () => [counted],
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(),
      model: null,
      now: () => at,
      config: { probes: true },
    });
    const say = async (userId: string, sessionId: string, turn: number, text: string) => {
      await p.observe({ tenantId: "t", userId, sessionId, at: at + turn, kind: "user_message", text } as AgentEvent, {
        waitMs: 1_000,
      });
    };
    await say("u1", "a", 0, "Order chocolates for Dana Lee");
    const first = calls;
    await say("u1", "a", 50, "Book a table for me and Dana Lee on Saturday");
    const repeat = calls - first;
    await say("u1", "b", 0, "Order chocolates for Dana Lee");
    const otherSession = calls - first - repeat;
    await say("u2", "a", 0, "Order chocolates for Dana Lee");
    const otherUser = calls - first - repeat - otherSession;
    // A repeat in the session costs no new probe calls (its memo, or the fan-out's per-user cache); another session of
    // the same user may share that cache; another user shares nothing and probes afresh.
    expect(first).toBeGreaterThan(0);
    expect(repeat).toBeLessThan(first);
    expect(otherSession).toBeLessThanOrEqual(first);
    expect(otherUser).toBe(first);
    // Cached items by id are the user's own.
    expect(cache.hits({ tenantId: "t", userId: "u1" }, ["drive:n1"], at).length).toBe(1);
    expect(cache.hits({ tenantId: "t", userId: "u3" }, ["drive:n1"], at)).toEqual([]);
  });
});

describe("probe state, review round (D46)", () => {
  const t0 = Date.parse("2026-10-27T09:00:00Z");
  const notes = () =>
    new StaticSource("drive", "Notes", [
      { ref: "n1", title: "People notes", text: "Dana Lee: severe nut allergy" },
      { ref: "w1", title: "Weather report", text: "weather forecast this week: rain, then sun" },
    ]);
  const setup = (config: Record<string, unknown>, sources: Source[], model: FakeModel | null = null) => {
    let clock = t0;
    const p = new ContextPartner({
      sources: async () => sources,
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model,
      now: () => clock,
      config: { probes: true, ...config },
    });
    const say = async (sessionId: string, minutes: number, text: string) => {
      clock = t0 + minutes * 60_000;
      await p.observe({ tenantId: "t", userId: "u", sessionId, at: clock, kind: "user_message", text } as AgentEvent, {
        waitMs: 1_000,
      });
    };
    return { say };
  };
  const counting = (source: StaticSource, log: string[]): Source => ({
    id: source.id,
    kind: "test",
    description: source.description,
    search: (q) => (log.push(q.text), source.search(q)),
  });

  test("the memo is the session's: a repeat within 10 minutes skips the person probe there, not elsewhere", async () => {
    const log: string[] = [];
    // No confident fast-path answer, so every turn looks up and probes (the cached note would answer otherwise).
    const { say } = setup({ confidentScore: 99 }, [counting(notes(), log)]);
    const probes = () => log.filter((q) => q === "Dana Lee").length;
    await say("a", 0, "Order chocolates for Dana Lee");
    expect(probes()).toBe(1);
    // Past the fan-out's 60 s result cache: only the memo can skip the call.
    // Each turn names someone else too: a new cue each time, not a repeat the cue cooldown would skip.
    await say("a", 2, "Book a table for me and Dana Lee at Nopi");
    expect(probes()).toBe(1);
    await say("b", 2, "Order chocolates for Dana Lee from Hotel Chocolat");
    expect(probes()).toBe(2);
    // Past the memo's 10 minutes, session a asks again: new mail about the person is found.
    await say("a", 15, "Order flowers for Dana Lee from Bloom");
    expect(probes()).toBe(3);
  });

  test("probes make exactly probeCalls source calls when there are more sources than that", async () => {
    const run = async (probes: boolean) => {
      const log: string[] = [];
      const many = Array.from({ length: 10 }, (_, i) =>
        counting(
          new StaticSource(`s${i}`, `Source ${i}`, [{ ref: "a", title: "Dana Lee", text: "Dana Lee notes" }]),
          log,
        ),
      );
      const { say } = setup({ probes, probeCalls: 2 }, many);
      await say("a", 0, "Order chocolates for Dana Lee and Sam Ortiz about the quarterly report");
      return log.length;
    };
    expect((await run(true)) - (await run(false))).toBe(2);
  });

  test("a lookup's probe finds are its own: a later unrelated turn never seats them with the judge", async () => {
    const shown: string[] = [];
    const model = new FakeModel((req) => {
      shown.push(req.messages.map((m) => m.content).join("\n"));
      return '{"pick": []}';
    });
    const { say } = setup({ probeWhen: "actions" }, [notes()], model);
    await say("a", 0, "Order chocolates for Dana Lee");
    const before = shown.length;
    await say("a", 30, "what is the weather forecast this week?");
    const later = shown.slice(before);
    expect(later.length).toBeGreaterThan(0);
    expect(later.some((prompt) => prompt.includes("nut allergy"))).toBe(false);
  });
});
