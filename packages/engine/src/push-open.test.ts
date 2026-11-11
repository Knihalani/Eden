import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { checkEngineConfig } from "./config-check";
import { CORE_CONFIG } from "./parts";
import { isImperative, isOpenRequest, MORE_VERBS } from "./probes";
import { PushChecker } from "./push-check";

// O3 (D702): `pushOpen` starts the candidates' push for a request whose verb is on no list.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - 3_600_000,
});
const ITEMS = [
  item("hold", "Premium Bonds", "Premium Bonds withdrawals are on hold until the boiler dispute with Halden ends."),
  item("plain", "Boiler quote", "The boiler quote from Halden for the Premium Bonds money: the PDF is attached."),
];
const REQUEST = "Cash in £3,000 of my Premium Bonds to pay for a new boiler.";

function setup(config: Record<string, unknown>) {
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
  return new ContextPartner({
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
  });
}
const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
async function packets(p: ContextPartner, text: string, at = ref) {
  await p.observe({ ...at, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return p.takePending(at).filter((x) => x.reason.startsWith("candidates:"));
}

describe("isOpenRequest (D702): a message that opens like an instruction, whatever its verb", () => {
  test("requests whose verb is on no list", () => {
    for (const text of [
      REQUEST,
      "Top up Maya's dinner account on ParentPay with £50.",
      "Reimburse Oskar the £180 for the train tickets to the Leeds client visit.",
      "Can you tag v2.8.0 of billing-service and publish the release notes?",
      "Hey can you tag v2.8.0 and publish the notes?",
      "So could you top up Maya's dinner account?",
      "Please spin up four more A100 nodes for Bob's experiments this week",
      "Überweise 50 Euro an Maya heute",
    ]) {
      expect(isImperative(text, MORE_VERBS)).toBe(false);
      expect(isOpenRequest(text)).toBe(true);
    }
  });

  test("not a question (with or without its mark), a request to be told, a remark, a statement or a short reply", () => {
    for (const text of [
      "What time is the flight to Porto on Saturday?",
      "What time is the flight to Porto on Saturday",
      "How much are my Premium Bonds worth now",
      "Is the Harlow invoice paid yet?",
      "Is the invoice paid? I need to know today.",
      "Will the Premium Bonds cover a new boiler?",
      "Could the boiler dispute be over by Friday?",
      "Can I still cash in my Premium Bonds?",
      "Please, what is the boiler quote from Halden?",
      "Cash in £3,000 of my Premium Bonds. Is that ok?",
      "Can you tell me if the migration finished?",
      "Thanks, that works for me now",
      "Sounds good, thanks a lot for that",
      "lol that was a funny one",
      "I think my Premium Bonds did well this year.",
      "The boiler broke down again last night",
      "Yes go ahead",
      "ok",
      "",
      "? ? ? ?",
    ]) {
      expect(isOpenRequest(text)).toBe(false);
    }
  });

  test("bounded: a megabyte of text is read at its head and tail only", () => {
    const long = "cash in the bonds ".repeat(60_000);
    const t0 = performance.now();
    for (let k = 0; k < 50; k++) isOpenRequest(long);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(isOpenRequest(long)).toBe(true);
    expect(isOpenRequest(`${long}?`)).toBe(false);
  });
});

describe("pushOpen (D702, promoted by D710)", () => {
  test("on in the default", () => {
    expect(DEFAULT_CONFIG.pushOpen).toBe(true);
  });

  test("off, a request with an unlisted verb starts no push; on, it gets the candidates", async () => {
    expect((await packets(setup({}), REQUEST)).length).toBe(0);
    const got = await packets(setup({ pushOpen: true }), REQUEST);
    expect(got.length).toBe(1);
    expect(got[0]!.citations.length).toBe(2);
  });

  test("on, a question still starts no push", async () => {
    expect((await packets(setup({ pushOpen: true }), "Are my Premium Bonds enough for a new boiler?")).length).toBe(0);
  });

  test("it needs the candidates: the reader's own push keeps its verb list", async () => {
    expect((await packets(setup({ pushOpen: true, pushCandidates: 0 }), REQUEST)).length).toBe(0);
  });

  test("isolation: one user's open push queues nothing for another user with a session of their own", async () => {
    const partner = setup({ pushOpen: true });
    const other = { ...ref, userId: "u2" };
    await partner.observe({ ...other, at: NOW, kind: "user_message", text: "ok" } as AgentEvent);
    expect((await packets(partner, REQUEST)).length).toBe(1);
    expect(partner.takePending(other)).toEqual([]);
  });

  test("with pushCheck on, an opened message starts no push: the check's paid call stays on listed verbs", async () => {
    const model = new FakeModel(() => '{"items":[]}');
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
        pushOpen: true,
        pushCheck: true,
      },
      checker: new PushChecker({ model, budget: new Budget() }),
    });
    expect((await packets(partner, REQUEST)).length).toBe(0);
    expect(model.calls.length).toBe(0);
  });

  test("pushCheckOpen (P2, D823): with the check, an opened message is pushed and checked like a listed one", async () => {
    const model = new FakeModel(() => '{"items":[{"i":1,"on":"Premium Bonds hold","hits":"its bonds","act":true}]}');
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
        pushOpen: true,
        pushCheck: true,
        pushCheckForm: 2,
        pushCheckOpen: true,
      },
      checker: new PushChecker({ model, budget: new Budget() }),
    });
    const got = await packets(partner, REQUEST);
    expect(model.calls.length).toBe(1);
    expect(got).toHaveLength(1);
    expect(got[0]!.citations.map((c) => c.itemId)).toEqual([ITEMS[0]!.id]);
  });

  test("pushCheckOpen needs pushCheck and pushOpen (D823)", () => {
    const deps = { deps: { cards: true, reader: true, checker: true } };
    expect(() => checkEngineConfig({ pushCheck: true, pushOpen: false, pushCheckOpen: true }, deps)).toThrow(
      /pushOpen/,
    );
    expect(() => checkEngineConfig({ pushCheckOpen: true }, deps)).toThrow(/pushCheck/);
  });

  test("an opened message is not kept as an acting request for plan alerts (D301)", async () => {
    const acted = (p: ContextPartner) =>
      (p as unknown as { sessions: Map<string, { acted?: unknown[] }> }).sessions.values().next().value?.acted
        ?.length ?? 0;
    const open = setup({ pushOpen: true, planConflict: true });
    await packets(open, REQUEST);
    expect(acted(open)).toBe(0);
    const listed = setup({ pushOpen: true, planConflict: true });
    await packets(listed, "Pay for a new boiler with £3,000 of my Premium Bonds.");
    expect(acted(listed)).toBe(1);
  });
});
