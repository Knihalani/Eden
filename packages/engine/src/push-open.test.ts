import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { isImperative, isOpenRequest, MORE_VERBS } from "./probes";
import { CANDIDATES_SPECIFICS } from "./render";

// O3 (D702, D703): `pushOpen` starts the candidates' push for a request whose verb is on no list;
// `candidatesSpecifics` adds one line to the candidates' lead.

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

describe("isOpenRequest (D702): a request by its shape, not its verb", () => {
  test("requests whose verb is on no list", () => {
    for (const text of [
      REQUEST,
      "Top up Maya's dinner account on ParentPay with £50.",
      "Reimburse Oskar the £180 for the train tickets to the Leeds client visit.",
      "Can you tag v2.8.0 of billing-service and publish the release notes?",
      "Please spin up four more A100 nodes for Bob's experiments this week",
    ]) {
      expect(isImperative(text, MORE_VERBS)).toBe(false);
      expect(isOpenRequest(text)).toBe(true);
    }
  });

  test("not a question, a request to be told, a remark or a short reply", () => {
    for (const text of [
      "What time is the flight to Porto on Saturday?",
      "Is the Harlow invoice paid yet?",
      "Can you tell me if the migration finished?",
      "Let me know when the deploy is done please",
      "Thanks, that works for me now",
      "Yes go ahead",
      "ok",
      "",
    ]) {
      expect(isOpenRequest(text)).toBe(false);
    }
  });
});

describe("pushOpen (D702) and candidatesSpecifics (D703)", () => {
  test("both are off in the default", () => {
    expect(DEFAULT_CONFIG.pushOpen).toBe(false);
    expect(DEFAULT_CONFIG.candidatesSpecifics).toBe(false);
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

  test("isolation: one user's open push queues nothing for another", async () => {
    const partner = setup({ pushOpen: true });
    await packets(partner, REQUEST);
    expect(partner.takePending({ ...ref, userId: "u2" })).toEqual([]);
  });

  test("candidatesSpecifics adds its line to the candidates' lead, and only then", async () => {
    const plain = await packets(setup({ pushOpen: true }), REQUEST);
    expect(plain[0]!.text).not.toContain(CANDIDATES_SPECIFICS);
    const said = await packets(setup({ pushOpen: true, candidatesSpecifics: true }), REQUEST);
    expect(said[0]!.text).toContain(CANDIDATES_SPECIFICS);
  });
});
