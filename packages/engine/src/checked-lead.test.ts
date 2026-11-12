import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem, Injection } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { PushChecker } from "./push-check";
import { ASK_NUDGE, CANDIDATES_LEAD, CHECKED_LEAD } from "./render";

// `checkedLead` (F6, trial): a packet whose items the push check named is led by `CHECKED_LEAD` and holds them in the
// check's order; any packet the check did not pick (off, failed open) keeps `CANDIDATES_LEAD` and the pool's order.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string, ageH: number): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * 3_600_000,
});
const ITEMS = [
  item("hold", "Harlow venue", "Payments to Harlow are on hold until the venue deposit dispute ends.", 2),
  item("plain", "Harlow invoice", "Harlow invoice for the venue deposit: the PDF is attached.", 3),
  item("dated", "Harlow deposit", "The Harlow venue deposit is due on Friday 30 October.", 4),
];
const REQUEST = "Pay the Harlow venue deposit invoice.";

/** A model naming the items whose titles are in `yes`, in that order (the reply's "most decisive first"). */
function says(yes: string[]): FakeModel {
  return new FakeModel((req: ChatRequest) => {
    const user = req.messages.at(-1)!.content;
    const n = new Map<string, number>();
    for (const m of user.matchAll(/<item n="(\d+)"[^>]*>([^:]*):/g)) n.set(m[2]!, Number(m[1]));
    const entries = yes
      .filter((t) => n.has(t))
      .map((t) => `{"i":${n.get(t)},"on":"${t}","hits":"the Harlow deposit","act":true}`);
    return `{"items":[${entries.join(",")}]}`;
  });
}

function partnerWith(config: Record<string, unknown>, model: Model | null, user = "u1") {
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
  const checker = model ? new PushChecker({ model, budget: new Budget() }) : undefined;
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
      pushCandidates: 3,
      ...config,
    },
    ...(checker ? { checker } : {}),
  });
  return { partner, ref: { tenantId: "t", userId: user, sessionId: "s1" } };
}

async function packet(p: ContextPartner, ref: { tenantId: string; userId: string; sessionId: string }) {
  await p.observe({ ...ref, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 2_000 });
  return p.takePending(ref).find((x: Injection) => x.reason.startsWith("candidates:"));
}

describe("checkedLead (F6): a checked packet says so and keeps the check's order", () => {
  test("off in the default; needs the push check", () => {
    expect(DEFAULT_CONFIG.checkedLead).toBe(false);
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, checkedLead: true })).not.toThrow();
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, pushCheck: false, checkedLead: true })).toThrow();
  });

  test("the lead is about as long as the unchecked one (packet bytes level) and is Eden's own line", () => {
    expect(Buffer.byteLength(CHECKED_LEAD)).toBeLessThanOrEqual(Buffer.byteLength(CANDIDATES_LEAD) + 16);
    expect(CHECKED_LEAD.startsWith("Eden: ")).toBe(true);
    expect(CHECKED_LEAD).not.toContain("- [");
  });

  test("on: the check's items, in its order, under CHECKED_LEAD", async () => {
    const { partner, ref } = partnerWith(
      { pushCheck: true, checkedLead: true },
      says(["Harlow venue", "Harlow deposit"]),
    );
    const got = (await packet(partner, ref))!;
    expect(got.citations.map((c) => c.itemId)).toEqual(["mail:hold", "mail:dated"]);
    const lines = got.text.split("\n");
    expect(lines[1]).toBe(CHECKED_LEAD);
    expect(lines[2]).toStartWith("- [mail] Harlow venue");
  });

  test("on: a kept check reused by a later pass with no call keeps the reply's order (review)", async () => {
    const model = says(["Harlow venue", "Harlow deposit"]);
    // No cooldown, so the same request's second pass may hand the items again from the kept check.
    const { partner, ref } = partnerWith({ pushCheck: true, checkedLead: true, ledgerCooldownTurns: 0 }, model);
    expect((await packet(partner, ref))!.citations.map((c) => c.itemId)).toEqual(["mail:hold", "mail:dated"]);
    const again = (await packet(partner, ref))!;
    expect(model.calls.length).toBe(1);
    expect(again.citations.map((c) => c.itemId)).toEqual(["mail:hold", "mail:dated"]);
    expect(again.text.split("\n")[1]).toBe(CHECKED_LEAD);
  });

  test("on, with the default's settled cut and nudge: the cut keeps the check's first item; a nudge follows", async () => {
    const model = says(["Harlow venue", "Harlow deposit"]);
    const on = { pushCheck: true, checkedLead: true, pushCandidatesSettled: 1, askNudge: true };
    const { partner, ref } = partnerWith(on, model);
    const got = (await packet(partner, ref))!;
    // Settled (the request names Harlow; every item does): one item, the check's first, not the pool's.
    expect(got.citations.map((c) => c.itemId)).toEqual(["mail:hold"]);
    expect(got.text.split("\n")[1]).toBe(CHECKED_LEAD);
    const nudged = partnerWith(on, says(["Harlow venue", "Harlow deposit"]), "u2");
    await nudged.partner.observe(
      {
        ...nudged.ref,
        at: NOW,
        kind: "user_message",
        text: "Pay the Harlow venue deposit to Dana Okafor on Friday.",
      } as AgentEvent,
      { waitMs: 2_000 },
    );
    const lead = nudged.partner
      .takePending(nudged.ref)
      .find((x) => x.reason.startsWith("candidates:"))
      ?.text.split("\n")[1];
    expect(lead === undefined || lead === CHECKED_LEAD || lead === `${CHECKED_LEAD} ${ASK_NUDGE}`).toBe(true);
  });

  test("off: the same check's items in the pool's order, under CANDIDATES_LEAD", async () => {
    const { partner, ref } = partnerWith({ pushCheck: true }, says(["Harlow venue", "Harlow deposit"]));
    const got = (await packet(partner, ref))!;
    expect(got.citations.map((c) => c.itemId)).toEqual(["mail:dated", "mail:hold"]);
    expect(got.text.split("\n")[1]).toBe(CANDIDATES_LEAD);
  });

  test("on, but the check failed open (unreadable reply): unchecked candidates keep CANDIDATES_LEAD", async () => {
    const broken = new FakeModel(() => "not json");
    const { partner, ref } = partnerWith({ pushCheck: true, checkedLead: true }, broken);
    const got = (await packet(partner, ref))!;
    expect(got.citations.length).toBe(3);
    expect(got.text.split("\n")[1]).toBe(CANDIDATES_LEAD);
  });

  test("on: a check naming nothing still sends no packet", async () => {
    const { partner, ref } = partnerWith({ pushCheck: true, checkedLead: true }, says([]));
    expect(await packet(partner, ref)).toBeUndefined();
  });
});
