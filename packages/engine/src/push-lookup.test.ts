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
import { CANDIDATES_LEAD, LOOKUP_LEAD } from "./render";

// `pushLookup` (F11, D1252, trial, off): a push the check left silent hands the pool's records that name the
// request's anchors, for reference, instead of nothing.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string, ageH: number): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * 3_600_000,
});
// Constraint wording on the first, so the gate hands candidates and the check is asked.
const ITEMS = [
  item("hold", "Harlow venue", "Payments to Harlow are on hold until the venue deposit dispute ends.", 2),
  item("dated", "Harlow deposit", "The Harlow venue deposit is due on Friday 30 October.", 4),
  item("other", "Invoice archive", "Older invoice for a venue deposit, paid last year.", 500),
];
const REQUEST = "Pay the Harlow venue deposit invoice today.";
const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };

/** A check that names nothing (`{"items":[]}`), or one whose reply does not parse (the check failed). */
const silent = () => new FakeModel(() => `{"items":[]}`);
const broken = () => new FakeModel(() => "not json");

function partner(config: Record<string, unknown>, model: Model | null) {
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
      pushCheck: true,
      ...config,
    },
    ...(model ? { checker: new PushChecker({ model, budget: new Budget() }) } : {}),
  });
}

async function taken(p: ContextPartner, text = REQUEST) {
  await p.observe({ ...ref, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return p.takePending(ref).find((x) => x.reason.startsWith("candidates:"));
}

describe("pushLookup (D1252)", () => {
  test("off in the default; a valid setting with the push check", () => {
    expect(DEFAULT_CONFIG.pushLookup).toBe(0);
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, pushLookup: 3 })).not.toThrow();
  });

  test("off: a check that names nothing sends no packet (D828's silence)", async () => {
    expect(await taken(partner({}, silent()))).toBeUndefined();
  });

  test("on: the check named nothing, so the records naming the request's anchors go out under the lookup lead", async () => {
    const got = await taken(partner({ pushLookup: 3 }, silent()));
    expect(got).toBeDefined();
    expect(got!.text).toContain(LOOKUP_LEAD);
    expect(got!.text).not.toContain(CANDIDATES_LEAD);
    const ids = got!.citations.map((c) => c.itemId);
    // Only items that name Harlow (the request's entity); the archive names neither it nor the day.
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain("mail:other");
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  test("on, k caps the records", async () => {
    const got = await taken(partner({ pushLookup: 1 }, silent()));
    expect(got!.citations.length).toBe(1);
  });

  test("on, but the check failed: the unchecked candidates go out as before, never framed as checked", async () => {
    const got = await taken(partner({ pushLookup: 3 }, broken()));
    expect(got?.text ?? "").not.toContain(LOOKUP_LEAD);
  });

  test("on, nothing in the pool names the request's anchors: still silent", async () => {
    expect(await taken(partner({ pushLookup: 3 }, silent()), "Pay the Pellham catering bill today.")).toBeUndefined();
  });

  test("on, no checker wired (no model key): no lookup packet, the push is as before", async () => {
    const got = await taken(partner({ pushLookup: 3 }, null));
    expect(got?.text ?? "").not.toContain(LOOKUP_LEAD);
  });
});
