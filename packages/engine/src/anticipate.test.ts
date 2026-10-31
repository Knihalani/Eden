import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { FOLLOW_MIN, IntentPatterns, PATTERN_TTL_MS, predict } from "./anticipate";
import { ItemCache } from "./cache";
import { hasWord } from "./consequence";
import { ContextPartner } from "./partner";

/** Friday 30 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-30T09:00:00Z");
const doc = (id: string, title: string, text: string, sourceId = "chat"): ContextItem => ({
  id: `${sourceId}:${id}`,
  sourceId,
  ref: id,
  title,
  text,
});

describe("predict (anticipate.ts)", () => {
  test("names, the days a scheduling event names, and the intent", () => {
    const p = predict("Set up dinner with Jamie Fox on Thursday 5 November", NOW, 0);
    expect(p.names).toEqual(["Jamie Fox"]);
    expect(p.days).toEqual(["2026-11-05"]);
    expect(predict("Deploy the billing migration on Thursday", NOW, 0).cls?.id).toBe("release");
    // A day that schedules nothing is no listing; an event that does not act has no class, and its intent is its
    // situation.
    const q = predict("Did Jamie Fox say anything about Thursday?", NOW, 0);
    expect(q.days).toEqual([]);
    expect(q.cls).toBeNull();
    expect(q.intent).toBe("general");
    // An arriving message acts whatever its wording.
    expect(predict("the IBAN for our invoices has changed, please pay to the new one", NOW, 0, true).cls?.id).toBe(
      "pay",
    );
  });

  test("reads a bounded head: a long tool result costs what its head costs, and hostile input stays linear", () => {
    for (const text of [
      "put ".repeat(50_000),
      "Book A B C D ".repeat(20_000),
      "on Thursday ".repeat(30_000),
      "x".repeat(1_000_000),
      "Jamie Fox, ".repeat(50_000),
    ]) {
      const t0 = performance.now();
      predict(text, NOW, 0);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});

describe("IntentPatterns", () => {
  const a = { tenantId: "t", userId: "a" };
  const b = { tenantId: "t", userId: "b" };

  test("a name is prefetched for an intent once it followed it FOLLOW_MIN times, per user", () => {
    const p = new IntentPatterns();
    for (let i = 0; i < FOLLOW_MIN - 1; i++) p.note(a, "release", ["Platform Team"], ["chat"]);
    expect(p.follows(a, "release")).toEqual([]);
    p.note(a, "release", ["Platform Team"], ["chat"]);
    expect(p.follows(a, "release")).toEqual(["Platform Team"]);
    // Another intent, another user: nothing.
    expect(p.follows(a, "pay")).toEqual([]);
    expect(p.follows(b, "release")).toEqual([]);
  });

  test("a learned name expires PATTERN_TTL_MS after it was last noted, as the items that taught it do", () => {
    const p = new IntentPatterns();
    const t0 = Date.UTC(2026, 9, 20);
    for (let i = 0; i < FOLLOW_MIN; i++) p.note(a, "release", ["Platform Team"], ["chat"], t0);
    expect(p.follows(a, "release", 1, t0 + PATTERN_TTL_MS)).toEqual(["Platform Team"]);
    expect(p.follows(a, "release", 1, t0 + PATTERN_TTL_MS + 1)).toEqual([]);
    // Noted again after expiry: it counts from one, not from where it stood.
    p.note(a, "release", ["Platform Team"], ["chat"], t0 + 2 * PATTERN_TTL_MS);
    expect(p.follows(a, "release", 1, t0 + 2 * PATTERN_TTL_MS)).toEqual([]);
  });

  test("forget drops the user, or what one source alone held", () => {
    const p = new IntentPatterns();
    for (let i = 0; i < FOLLOW_MIN; i++) {
      p.note(a, "release", ["Platform Team"], ["chat"]);
      p.note(a, "release", ["Change Board"], ["mail"]);
      p.note(b, "release", ["Platform Team"], ["chat"]);
    }
    p.forget(a, "chat");
    expect(p.follows(a, "release", 5)).toEqual(["Change Board"]);
    expect(p.follows(b, "release")).toEqual(["Platform Team"]);
    p.forget(a);
    expect(p.follows(a, "release")).toEqual([]);
    expect(p.userCount).toBe(1);
  });

  test("bounded: intents and names per user", () => {
    const p = new IntentPatterns();
    for (let i = 0; i < 100; i++) for (let k = 0; k < FOLLOW_MIN; k++) p.note(a, `intent${i}`, [`Name ${i}`], ["s"]);
    expect(p.follows(a, "intent0")).toEqual([]);
    expect(p.follows(a, "intent99")).toEqual(["Name 99"]);
    for (let i = 0; i < 100; i++) for (let k = 0; k < FOLLOW_MIN; k++) p.note(a, "x", [`Name ${i}`], ["s"]);
    expect(p.follows(a, "x", 100).length).toBeLessThanOrEqual(8);
  });
});

describe("anticipation in the engine (anticipate)", () => {
  /** A chat search that matches only items holding every query word, as mail and chat search do. */
  const andSource = (id: string, items: ContextItem[], log: string[]): Source => ({
    id,
    kind: "test",
    description: "Team chat",
    search: async (q) => {
      log.push(q.text);
      const words = q.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      if (words.length === 0) return [];
      return items.filter((i) => {
        const hay = `${i.title} ${i.text}`.toLowerCase();
        return words.every((w) => hasWord(hay, w));
      });
    },
  });
  const freeze = doc("f1", "Quarter-end close", "Change freeze 4-9 Nov: no production changes while finance closes.");
  const away = doc("a1", "Out of office", "Jamie Fox is away 2-6 Nov, back Monday 9th. Urgent: ask Sam.");

  const make = (config: Record<string, unknown>, items: ContextItem[], log: string[], cache = new ItemCache()) =>
    new ContextPartner({
      sources: async () => [andSource("chat", items, log)],
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: {
        probes: true,
        probeGraceMs: 1_000,
        confidentScore: 99,
        fallbackMatchedTerms: 0,
        groundConflict: true,
        groundAway: true,
        ...config,
      },
    });
  /** Waits until the session's prefetch has finished (a harness may read the session table; product code may not). */
  const settle = async (p: ContextPartner, key: string) => {
    const sessions = (p as unknown as { sessions: Map<string, { ant?: { running: unknown } }> }).sessions;
    for (let i = 0; i < 1_000 && sessions.get(key)?.ant?.running; i++) await Bun.sleep(1);
  };
  const ev = (userId: string, text: string, draft = false) =>
    ({
      tenantId: "t",
      userId,
      sessionId: "s",
      at: NOW,
      kind: "user_message",
      text,
      ...(draft ? { draft } : {}),
    }) as AgentEvent;

  test("flag off, a draft is ignored: no session, no call", async () => {
    const log: string[] = [];
    const p = make({}, [freeze], log);
    const r = await p.observe(ev("u1", "Deploy the billing migration on", true));
    expect(r.injection).toBeNull();
    expect(p.sessionCount).toBe(0);
    expect(log).toEqual([]);
  });

  test("a draft's class vocabulary is fetched ahead; the request is answered from it at once, with no class call", async () => {
    const log: string[] = [];
    const p = make({ anticipate: true }, [freeze], log);
    await p.observe(ev("u1", "Deploy the billing migration on Thursday", true));
    await settle(p, "t/u1#s");
    expect(log).toEqual(["freeze"]);
    // waitMs 0: only what is decided on the critical path comes back with the reply.
    const r = await p.observe(ev("u1", "Deploy the billing migration on Thursday 5 November."));
    expect(r.injection?.citations.map((c) => c.itemId)).toEqual(["chat:f1"]);
    expect(r.injection?.reason.split(":")[0]).toBe("anticipated-conflict");
    expect(log.filter((q) => q === "freeze").length).toBe(1);
  });

  test("a draft's names are probed ahead; the request's own probe of them makes no call", async () => {
    const log: string[] = [];
    const p = make({ anticipate: true }, [away], log);
    await p.observe(ev("u1", "Ask Jamie Fox to review the board deck", true));
    await settle(p, "t/u1#s");
    expect(log).toContain("Jamie Fox");
    const r = await p.observe(ev("u1", "Ask Jamie Fox to review the board deck on Wednesday 4 November."), {
      waitMs: 1_000,
    });
    expect(r.injection?.citations.map((c) => c.itemId)).toEqual(["chat:a1"]);
    expect(log.filter((q) => q === "Jamie Fox").length).toBe(1);
  });

  test("a tool result's names are fetched when the user's items have them as people; not with anticipateOff names", async () => {
    const tool = (config: Record<string, unknown>, known: boolean) => {
      const log: string[] = [];
      const cache = new ItemCache();
      // Jamie Fox takes part in one of the user's items (a mail's From): someone the user deals with, not a company
      // or a signature's colleague.
      if (known) {
        cache.put(
          { tenantId: "t", userId: "u1" },
          [doc("m0", "Lunch?", "From: Jamie Fox <jamie@globex.com>\nHi")],
          NOW,
        );
      }
      const p = make({ anticipate: true, ...config }, [away], log, cache);
      return { p, log };
    };
    for (const [config, known, expected] of [
      [{}, true, true],
      [{}, false, false],
      [{ anticipateOff: ["names"] }, true, false],
    ] as const) {
      const { p, log } = tool(config, known);
      await p.observe({
        tenantId: "t",
        userId: "u1",
        sessionId: "s",
        at: NOW,
        kind: "tool_result",
        tool: "crm.search",
        output: "Contact: Jamie Fox, Globex. Last touch 3 Oct.",
      });
      await settle(p, "t/u1#s");
      expect(log.includes("Jamie Fox")).toBe(expected);
    }
  });

  test("isolation: one user's prefetch never answers another's request", async () => {
    const log: string[] = [];
    const p = make({ anticipate: true }, [freeze], log);
    await p.observe(ev("u1", "Deploy the billing migration on Thursday", true));
    await settle(p, "t/u1#s");
    const r = await p.observe(ev("u2", "Deploy the billing migration on Thursday 5 November."));
    // u2 had nothing fetched ahead: nothing on the critical path, and u2's class is read from u2's own cache only.
    expect(r.injection).toBeNull();
    expect(log.filter((q) => q === "freeze").length).toBe(2);
  });

  test("bounded: a session's prefetches stop at anticipateSessionCalls", async () => {
    const log: string[] = [];
    const p = make({ anticipate: true, anticipateSessionCalls: 2 }, [away], log);
    const names = ["Jamie Fox", "Dana Lee", "Priya Raman", "Omar Haddad", "Grace Liu"];
    for (const n of names) {
      await p.observe(ev("u1", `Ask ${n} about the review`, true));
      await settle(p, "t/u1#s");
    }
    expect(log.length).toBeLessThanOrEqual(2);
  });

  test("forget drops the session and its prefetch with the user", async () => {
    const log: string[] = [];
    const p = make({ anticipate: true }, [freeze], log);
    await p.observe(ev("u1", "Deploy the billing migration on Thursday", true));
    await settle(p, "t/u1#s");
    p.forget({ tenantId: "t", userId: "u1" });
    expect(p.sessionCount).toBe(0);
    const r = await p.observe(ev("u1", "Deploy the billing migration on Thursday 5 November."));
    expect(r.injection).toBeNull();
  });
});
