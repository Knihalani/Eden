import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import {
  LOCAL_CHECK_ITEM_CHARS,
  LocalPushChecker,
  localCheckText,
  type LocalCheckInput,
  type PushCheckScorer,
  PushChecker,
} from "./push-check";

// M1 (D894): the `pushCheckLocal` trial. A distilled student scores each item of the push's pool; those at or above
// the pass mark are the candidates, in pool order; any failure leaves the default's.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string, ageH: number): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * 3_600_000,
});
const LONG = "Further detail on the venue booking terms. ".repeat(30);
const ITEMS = [
  item("hold", "Harlow venue", "Payments to Harlow are on hold until the venue deposit dispute ends.", 2),
  item("plain", "Harlow invoice", "Harlow invoice for the venue deposit: the PDF is attached.", 3),
  item("dated", "Harlow deposit", `The Harlow venue deposit is due on Friday 30 October. ${LONG}`, 4),
  item("other", "Invoice archive", "Older invoice for a venue deposit, paid last year.", 500),
];
const REQUEST = "Pay the Harlow venue deposit invoice, key AKIAIOSFODNN7EXAMPLE.";

/** A scorer that says yes (log-odds 4) to titles in `yes`, no (-4) to the rest, and records what it was given. */
function scorer(yes: string[], fail?: "throw" | "short" | "nan") {
  const calls: LocalCheckInput[] = [];
  const s: PushCheckScorer = {
    async score(input) {
      calls.push(input);
      if (fail === "throw") throw new Error("endpoint down");
      const out = input.items.map((it) => (yes.includes(it.title) ? 4 : -4));
      if (fail === "short") return out.slice(1);
      if (fail === "nan") return out.map(() => Number.NaN);
      return out;
    },
  };
  return { s, calls };
}

function setup(config: Record<string, unknown>, sc: PushCheckScorer | null, failures: unknown[] = []) {
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
  const checker = sc ? new LocalPushChecker({ scorer: sc, pass: 0.5, onFailure: (e) => failures.push(e) }) : undefined;
  const partner = new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: {
      ...CORE_CONFIG,
      askReader: true,
      readerPush: true,
      readerGate: true,
      confidentScore: 99,
      fallbackMatchedTerms: 99,
      pushCandidates: 2,
      ...config,
    },
    ...(checker ? { checker } : {}),
  });
  return { partner, checker };
}

const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
async function handed(p: ContextPartner, at = ref): Promise<string[] | null> {
  await p.observe({ ...at, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 2_000 });
  const got = p.takePending(at).find((x) => x.reason.startsWith("candidates:"));
  return got ? got.citations.map((c) => c.itemId) : null;
}

const ON = { pushCheck: true, pushCheckLocal: true };

describe("pushCheckLocal (M1, D894): a student's scores pick the push's candidates", () => {
  test("off in the default", () => {
    expect(DEFAULT_CONFIG.pushCheckLocal).toBe(false);
    expect(DEFAULT_CONFIG.pushCheckLocalPass).toBe(0.5);
  });

  test("on: items at or above the mark enter in pool order; the rest leave", async () => {
    const { s, calls } = scorer(["Invoice archive", "Harlow deposit"]);
    const { partner, checker } = setup(ON, s);
    const ids = await handed(partner);
    expect(new Set(ids)).toEqual(new Set(["mail:dated", "mail:other"]));
    expect(calls.length).toBe(1);
    expect(checker!.stats.calls).toBe(1);
    expect(checker!.stats.costUsd).toBe(0);
  });

  test("the student reads the request redacted and each item's cached text, cut at its own length", async () => {
    const { s, calls } = scorer([]);
    const { partner } = setup(ON, s);
    await handed(partner);
    const got = calls[0]!;
    expect(got.request).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(got.today).toBe("2026-10-27");
    const dated = got.items.find((it) => it.title === "Harlow deposit")!;
    // Not the reader's 200-character excerpt: the item's text from its start, up to the student's 700.
    expect(dated.text.startsWith("The Harlow venue deposit is due on Friday 30 October.")).toBe(true);
    expect(dated.text.length).toBe(LOCAL_CHECK_ITEM_CHARS);
    expect(localCheckText("key AKIAIOSFODNN7EXAMPLE")).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("none passing sends no candidates packet (pushCheckSilent, the default for the check)", async () => {
    const { s } = scorer([]);
    const { partner } = setup(ON, s);
    expect(await handed(partner)).toBeNull();
  });

  for (const fail of ["throw", "short", "nan"] as const) {
    test(`fails open to the default's candidates when the scorer ${fail}s`, async () => {
      const failures: unknown[] = [];
      const { s } = scorer(["Invoice archive"], fail);
      const { partner, checker } = setup(ON, s, failures);
      const { partner: plain } = setup({}, null);
      expect(await handed(partner)).toEqual(await handed(plain));
      expect(checker!.stats.failures).toBe(1);
      expect(failures.length).toBe(1);
    });
  }

  test("the pass mark is a probability on the score's sigmoid", async () => {
    const at = (pass: number, score: number) =>
      new LocalPushChecker({ scorer: { score: async (i) => i.items.map(() => score) }, pass }).check(
        { tenantId: "t", userId: "u" },
        "s",
        {
          request: "r",
          today: "2026-10-27",
          items: [{ id: "a", source: "m", title: "t", date: "", from: "", text: "x", hash: "h" }],
        },
        new AbortController().signal,
      );
    expect([...(await at(0.5, 0.01)).yes!]).toEqual(["a"]);
    expect([...(await at(0.5, -0.01)).yes!]).toEqual([]);
    expect([...(await at(0.05, -2.9)).yes!]).toEqual(["a"]);
    expect([...(await at(0.05, -3.0)).yes!]).toEqual([]);
  });

  test("config: needs pushCheck and a checker; the mark is a probability", () => {
    expect(checkEngineConfig({ ...ON, pushCheckLocalPass: 0.2 }, { deps: { checker: true } })).toEqual({
      ...ON,
      pushCheckLocalPass: 0.2,
    });
    expect(() => checkEngineConfig({ ...ON, pushCheckLocalPass: 1.5 }, { deps: { checker: true } })).toThrow();
    expect(() => checkEngineConfig({ pushCheck: false, pushCheckLocal: true }, { deps: { checker: true } })).toThrow();
    expect(() => checkEngineConfig(ON, { deps: {} })).toThrow();
  });

  test("isolation: each user's check reads only that user's items", async () => {
    const { s, calls } = scorer(["Harlow deposit"]);
    const own: Record<string, ContextItem[]> = {
      u1: ITEMS,
      u2: [item("u2only", "Harlow venue hold", "Payments to Harlow are on hold for u2's own dispute.", 2)],
    };
    const checker = new LocalPushChecker({ scorer: s, pass: 0.5 });
    const partner = new ContextPartner({
      sources: async (scope) => [
        { id: "mail", kind: "test", description: "Mail", search: async () => own[scope.userId] ?? [] },
      ],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: {
        ...CORE_CONFIG,
        askReader: true,
        readerPush: true,
        readerGate: true,
        confidentScore: 99,
        fallbackMatchedTerms: 99,
        pushCandidates: 2,
        ...ON,
      },
      checker,
    });
    await handed(partner, ref);
    await handed(partner, { tenantId: "t", userId: "u2", sessionId: "s2" });
    expect(calls.length).toBe(2);
    const titles = (i: number) => calls[i]!.items.map((it) => it.title);
    expect(titles(0)).not.toContain("Harlow venue hold");
    expect(titles(1)).toEqual(["Harlow venue hold"]);
  });

  test("a second push of the same request over the same pool reuses the kept answer, with no new score", async () => {
    const { s, calls } = scorer(["Harlow deposit"]);
    const { partner } = setup(ON, s);
    const first = await handed(partner);
    await partner.observe({ ...ref, at: NOW + 1, kind: "user_message", text: REQUEST } as AgentEvent, {
      waitMs: 2_000,
    });
    expect(first).toEqual(["mail:dated"]);
    expect(calls.length).toBe(1);
  });

  test("the request and titles the scorer is sent are bounded, whatever the event's length", async () => {
    const { s, calls } = scorer([]);
    const checker = new LocalPushChecker({ scorer: s, pass: 0.5 });
    await checker.check(
      { tenantId: "t", userId: "u" },
      "s",
      {
        request: "r".repeat(5_000),
        today: "2026-10-27",
        items: [
          { id: "a", source: "m", title: "t".repeat(2_000), date: "", from: "", text: "x".repeat(5_000), hash: "h" },
        ],
      },
      new AbortController().signal,
    );
    expect(calls[0]!.request.length).toBe(400);
    expect(calls[0]!.items[0]!.title.length).toBe(300);
    expect(calls[0]!.items[0]!.text.length).toBe(LOCAL_CHECK_ITEM_CHARS);
  });
});

describe("pushCheckLocal with pushOpen (M1, D896)", () => {
  test("a request on no verb list still pushes, and is checked: the student is not a paid call", async () => {
    const { s, calls } = scorer(["Harlow deposit"]);
    const text = "Settle the Harlow venue deposit invoice today";
    const run = async (config: Record<string, unknown>, sc: PushCheckScorer | null) => {
      const { partner } = setup({ pushOpen: true, ...config }, sc);
      await partner.observe({ ...ref, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
      return partner.takePending(ref).find((x) => x.reason.startsWith("candidates:"));
    };
    expect(await run({}, null)).toBeDefined();
    const got = await run(ON, s);
    expect(got?.citations.map((c) => c.itemId)).toEqual(["mail:dated"]);
    expect(calls.length).toBe(1);
  });
});

describe("pushCheckLocal with the paid checker wired (D894, the review's case)", () => {
  test("the switch is inert: the paid call gets the shipped item text, never the student's", async () => {
    const model = new FakeModel(() => '{"items":[]}');
    const checker = new PushChecker({ model, budget: new Budget() });
    const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
    const partner = new ContextPartner({
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: {
        ...CORE_CONFIG,
        askReader: true,
        readerPush: true,
        readerGate: true,
        confidentScore: 99,
        fallbackMatchedTerms: 99,
        pushCandidates: 2,
        ...ON,
      },
      checker,
    });
    await partner.observe({ ...ref, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 2_000 });
    expect(model.calls.length).toBe(1);
    // The paid call reads the reader's excerpts, never the student's 700 characters.
    expect(JSON.stringify(model.calls[0]!.messages)).not.toContain(LONG.slice(0, 300));
  });
});
