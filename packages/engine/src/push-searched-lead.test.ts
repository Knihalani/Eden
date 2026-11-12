import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { PushChecker } from "./push-check";
import { CANDIDATES_LEAD, SEARCHED_LEAD } from "./render";

// `pushSearchedLead` (F7, a trial): a candidates packet the push check picked says Eden searched for the request.

describe("pushSearchedLead (F7)", () => {
  const NOW = Date.parse("2026-10-27T09:00:00Z");
  const items: ContextItem[] = [
    {
      id: "mail:hold",
      sourceId: "mail",
      ref: "hold",
      title: "Harlow venue",
      text: "Payments to Harlow are on hold until the venue deposit dispute ends.",
      updatedAt: NOW - 7_200_000,
    },
  ];
  const named = new FakeModel(
    () => `{"items":[{"i":1,"on":"the Harlow deposit","hits":"the deposit invoice","act":true}]}`,
  );
  async function lead(config: Record<string, unknown>, model: Model | null): Promise<string | null> {
    const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => items };
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
      ...(model ? { checker: new PushChecker({ model, budget: new Budget() }) } : {}),
    });
    const at = { tenantId: "t", userId: "u", sessionId: "s" };
    const text = "Pay the Harlow venue deposit invoice.";
    await partner.observe({ ...at, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
    return partner.takePending(at).find((x) => x.reason.startsWith("candidates:"))?.text ?? null;
  }

  test("off in the default: a checked packet keeps the shipped lead", async () => {
    expect(DEFAULT_CONFIG.pushSearchedLead).toBe(false);
    const text = await lead({ pushCheck: true }, named);
    expect(text).toContain(CANDIDATES_LEAD);
  });

  test("on: a packet the check picked says so; an unchecked one (no checker, or a failed check) does not", async () => {
    const on = { pushCheck: true, pushSearchedLead: true };
    expect(await lead(on, named)).toContain(SEARCHED_LEAD);
    expect(await lead(on, named)).not.toContain("nothing has checked");
    expect(await lead({ ...on, pushCheck: false, pushSearchedLead: false }, null)).toContain(CANDIDATES_LEAD);
    expect(await lead(on, new FakeModel(() => "unreadable"))).toContain(CANDIDATES_LEAD);
  });
});

test("pushSearchedLead needs a checker and the check", () => {
  expect(() => checkEngineConfig({ pushSearchedLead: true }, { deps: { reader: true } })).toThrow(/checker/);
  expect(checkEngineConfig({ pushSearchedLead: true }, { deps: { checker: true } })).toEqual({
    pushSearchedLead: true,
  });
});
