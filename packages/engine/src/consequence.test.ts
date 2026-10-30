import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { assess, frameOf } from "./conflict";
import { actionClass, CLASSES, classTies, hasWord, matchesClass } from "./consequence";
import { ProbeEconomy } from "./economy";
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

describe("action classes (consequence.ts)", () => {
  test("a request is the first class whose verbs it uses", () => {
    const cls = (raw: string) => actionClass(raw)?.id ?? null;
    expect(cls("Deploy the billing migration on Thursday")).toBe("release");
    expect(cls("Can you schedule the billing service release for thursday 2pm")).toBe("release");
    expect(cls("Delete the customer's data from the CRM")).toBe("delete");
    expect(cls("Pay the Hooli invoice to their new IBAN")).toBe("pay");
    // A payment is a payment before it is travel.
    expect(cls("Pay the hotel for the Lisbon trip")).toBe("pay");
    expect(cls("Extend an offer to the backend candidate")).toBe("people");
    expect(cls("Book me flights to Singapore next week")).toBe("travel");
    expect(cls("Book a table for six at Ottoline on Friday")).toBe("food");
    expect(cls("Order 2 laptops for the new starters")).toBe("spend");
    expect(cls("Forward the roadmap deck to Grace")).toBe("share");
    // Meeting over a meal is scheduling, not providing food; nothing here is an action of a class.
    expect(cls("Set up lunch with Sam on Friday")).toBeNull();
    expect(cls("Remind me about the 1:1 with Dana")).toBeNull();
  });

  test("whole words only: a term inside another word is no match", () => {
    expect(hasWord("legal hold on all records", "hold")).toBe(true);
    expect(hasWord("the card holder", "hold")).toBe(false);
    expect(hasWord("hold", "hold")).toBe(true);
    expect(hasWord("Łódź freeze", "freeze")).toBe(true);
    const release = CLASSES.find((c) => c.id === "release")!;
    expect(matchesClass(release, "Change freeze: no production changes 4-9 Nov")).toBe(true);
    expect(matchesClass(release, "Antifreeze for the car")).toBe(false);
  });

  test("the class's words tie a constraint the request's own words do not", () => {
    const release = CLASSES.find((c) => c.id === "release")!;
    const freeze = doc("f", "Quarter-end close", "Change freeze 4-9 Nov: no production changes.");
    const frame = frameOf("Deploy the billing migration on Thursday 5 November", ["2026-11-05"], NOW);
    // Untied, the freeze is no conflict with a request it shares no word with; tied by the class, it is.
    expect(assess(frame, freeze, NOW)).toBe("none");
    expect(assess(frame, freeze, NOW, classTies(release))).toBe("conflict");
    // A freeze over other days is not.
    const later = doc("g", "Year-end close", "Change freeze 20-25 Nov: no production changes.");
    expect(assess(frame, later, NOW, classTies(release))).not.toBe("conflict");
  });

  test("hostile input stays linear", () => {
    const shapes = [
      "book ".repeat(20_000),
      "book a a a a a a a a ".repeat(5_000),
      "send the the the ".repeat(8_000),
      "hold".repeat(25_000),
      "x".repeat(100_000),
      "remove the ".repeat(10_000),
    ];
    const travel = CLASSES.find((c) => c.id === "travel")!;
    for (const text of shapes) {
      const t0 = performance.now();
      actionClass(text);
      for (const c of CLASSES) matchesClass(c, text);
      hasWord(text, "hold");
      matchesClass(travel, text);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});

describe("how a source searches several words (ProbeEconomy forms)", () => {
  const alice = { tenantId: "t", userId: "alice" };
  const bob = { tenantId: "t", userId: "bob" };
  const it = (id: string, text: string): ContextItem => ({ id, sourceId: "drive", ref: id, title: id, text });

  test("an answer holding an item without every word is an any-word search; learned per user and forgotten", () => {
    const e = new ProbeEconomy();
    expect(e.formOf(alice, "drive")).toBe("unknown");
    e.observeForm(alice, "drive", ["dana", "lee"], [it("a", "Dana Lee"), it("b", "Dana Scully")]);
    expect(e.formOf(alice, "drive")).toBe("any");
    // Another user's evidence is theirs.
    expect(e.formOf(bob, "drive")).toBe("unknown");
    e.observeForm(bob, "drive", ["dana", "lee"], [it("a", "Dana Lee")]);
    expect(e.formOf(bob, "drive")).toBe("all");
    // An empty answer to a name says nothing; to a class's many terms it is every-word evidence.
    e.observeForm(alice, "mail", ["dana", "lee"], []);
    expect(e.formOf(alice, "mail")).toBe("unknown");
    e.observeForm(alice, "mail", ["freeze", "moratorium"], [], true);
    expect(e.formOf(alice, "mail")).toBe("all");
    e.forget(alice, "drive");
    expect(e.formOf(alice, "drive")).toBe("unknown");
    expect(e.formOf(alice, "mail")).toBe("all");
    e.forget(alice);
    expect(e.formOf(alice, "mail")).toBe("unknown");
    expect(e.formOf(bob, "drive")).toBe("all");
  });

  test("the consequence probe's answers are kept apart: they never move the user's pooled change rate", () => {
    const e = new ProbeEconomy();
    for (let k = 0; k < 10; k++) e.answered(alice, "mail", `term${k}`, [it("x", "same")], k * 60_000, true);
    for (let k = 0; k < 10; k++) e.answered(alice, "mail", `term${k}`, [it("x", "same")], (k + 10) * 60_000, true);
    // No pooled re-asks: a probe of the user's own is still too new to skip.
    e.answered(alice, "mail", "Dana Lee", [it("m", "a")], 0);
    e.answered(alice, "mail", "Dana Lee", [it("m", "a")], 60_000);
    expect(e.changeChance(alice, "mail", "Dana Lee", 2 * 60_000)).toBe(1);
    expect(e.askedAt(alice, "mail", "term3")).toBe(13 * 60_000);
    expect(e.lastIds(alice, "mail", "term3")).toEqual(["x"]);
    expect(e.askedAt(bob, "mail", "term3")).toBeNull();
  });
});

describe("the consequence probe in the engine (consequenceProbe)", () => {
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

  const run = async (
    config: Record<string, unknown>,
    items: ContextItem[],
    text = "Deploy the billing migration on Thursday 5 November.",
    users = ["u1"],
  ) => {
    const log: string[] = [];
    const p = new ContextPartner({
      sources: async () => [andSource("chat", items, log)],
      sourceMap: new SourceMap(),
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
        ...config,
      },
    });
    const out: Record<string, string[]> = {};
    for (const userId of users) {
      const scope = { tenantId: "t", userId };
      const r = await p.observe({ ...scope, sessionId: "s", at: NOW, kind: "user_message", text } as AgentEvent, {
        waitMs: 1_000,
      });
      out[userId] = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId: "s" })].flatMap(
        (i) => i.citations.map((c) => `${c.itemId} ${i.reason.split(":")[0]}`),
      );
    }
    return { out, log };
  };
  const freeze = (days: string) =>
    doc("f1", "Quarter-end close", `Change freeze ${days}: no production changes while finance closes the quarter.`);

  test("a freeze over the day a release is asked for is found and grounded with no model; flag off, it is not", async () => {
    const on = await run({ consequenceProbe: true }, [freeze("4-9 Nov")]);
    expect(on.out.u1).toEqual(["chat:f1 grounded-conflict"]);
    // One term to a source not known to search any word: the class's first.
    expect(on.log).toContain("freeze");
    const off = await run({}, [freeze("4-9 Nov")]);
    expect(off.out.u1).toEqual([]);
    expect(off.log).not.toContain("freeze");
  });

  test("a freeze over other days is found but not raised", async () => {
    const { out, log } = await run({ consequenceProbe: true }, [freeze("20-25 Nov")]);
    expect(log).toContain("freeze");
    expect(out.u1).toEqual([]);
  });

  test("a constraint on one party is raised only for that party", async () => {
    const hold = (org: string) =>
      doc("h1", "#legal", `Legal hold: litigation with ${org}. Do not delete any of their records or emails.`);
    const text = "Please delete Acme Corp's account and records from our systems today.";
    // The hold names another client: not this request's, with no model.
    expect((await run({ consequenceProbe: true }, [hold("Globex Ltd")], text)).out.u1).toEqual([]);
    expect((await run({ consequenceProbe: true }, [hold("Acme Corp")], text)).out.u1).toEqual([
      "chat:h1 grounded-conflict",
    ]);
  });

  test("a limit on an amount the request does not state is not raised with no model", async () => {
    const policy = doc("p1", "Expense policy", "Reminder: purchases over £500 need budget approval from now on.");
    const ask = (text: string) => run({ consequenceProbe: true }, [policy], text);
    expect((await ask("Order more printer paper for the office")).out.u1).toEqual([]);
    expect((await ask("Order 3 laptops for the new starters, £2,400 in total")).out.u1).toEqual([
      "chat:p1 grounded-conflict",
    ]);
  });

  test("a question is no action: nothing is probed for its class", async () => {
    const { log } = await run({ consequenceProbe: true }, [freeze("4-9 Nov")], "Did the billing release go out?");
    expect(log).not.toContain("freeze");
  });

  test("isolation: one user's find never reaches another; each asks their own sources", async () => {
    const { out, log } = await run({ consequenceProbe: true }, [freeze("4-9 Nov")], undefined, ["u1", "u2"]);
    expect(out.u1).toEqual(["chat:f1 grounded-conflict"]);
    expect(out.u2).toEqual(["chat:f1 grounded-conflict"]);
    // Each user's first lookup asks the class's first term itself: no user's memo answers for another.
    expect(log.filter((q) => q === "freeze").length).toBe(2);
  });
});

describe("the consequence probe with a judge (judgeTied) and with questions", () => {
  const freeze = doc("f1", "Quarter-end close", "Change freeze 4-9 Nov: no production changes while finance closes.");
  /** A source that returns an item only when it holds every word of the query. */
  const strict = (items: ContextItem[], log: string[]): Source => ({
    id: "chat",
    kind: "test",
    description: "Team chat",
    search: async (q) => {
      log.push(q.text);
      const words = q.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      if (words.length === 0) return [];
      return items.filter((i) => words.every((w) => hasWord(`${i.title} ${i.text}`.toLowerCase(), w)));
    },
  });
  const run = async (config: Record<string, unknown>, model: FakeModel | null, text: string) => {
    const log: string[] = [];
    const p = new ContextPartner({
      sources: async () => [strict([freeze], log)],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model,
      now: () => NOW,
      config: { probes: true, probeGraceMs: 1_000, confidentScore: 99, fallbackMatchedTerms: 0, ...config },
    });
    const scope = { tenantId: "t", userId: "u1", sessionId: "s" };
    const r = await p.observe({ ...scope, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 1_000 });
    const got = [...(r.injection ? [r.injection] : []), ...p.takePending(scope)].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
    return { got, log };
  };

  test("judgeTied does not silence a constraint the probe found: the judge still sees it", async () => {
    const config = { consequenceProbe: true, groundConflict: true, judgeTied: true };
    const model = new FakeModel(() => '{"pick": [0]}');
    const { got } = await run(config, model, "Deploy the billing migration on Thursday 5 November.");
    expect(model.calls.length).toBe(1);
    expect(got).toEqual(["chat:f1"]);
  });

  test("a question that mentions a release is no release: no class vocabulary is sent", async () => {
    for (const text of [
      "What did Sam say about the deploy at lunch?",
      "Have you read a great book on the migration?",
      "Did the release go out? Let's catch up over coffee Friday",
      "Did Sam tell you whether the billing release went out?",
      "Can you tell me if the billing migration finished?",
    ]) {
      const { log } = await run({ consequenceProbe: true }, null, text);
      expect(log.some((q) => /freeze|moratorium|change window/i.test(q))).toBe(false);
    }
  });
});
