import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";
import { PushChecker } from "./push-check";

const NOW = Date.parse("2026-10-27T09:00:00Z");
const ref = { tenantId: "t", userId: "u", sessionId: "s" };
const REQUEST = "Reply to Ahmed Hassan and tell them we'll ship the SSO integration next month.";
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW,
});
const proof = item(
  "proof",
  "A note",
  "From: Ahmed Hassan <ahmed.hassan@umbrellahealth.com>\n\n-- Ahmed Hassan CFO | Umbrella Health",
);
const items = [
  item("baseline", "SSO handoff", "SSO handoff for Ahmed Hassan requires manager approval."),
  item("plain", "SSO update", "SSO integration update for Ahmed Hassan."),
  item("pricing", "Umbrella Health procurement", "Umbrella Health pricing is pending review."),
  item("pricing2", "Umbrella Health pricing", "Umbrella Health pricing is pending review."),
  ...["one", "two", "three"].map((id) =>
    item(id, `Legal ${id}`, "Umbrella Health contract commitments are on hold until MSA countersignature."),
  ),
  item("other", "Other legal", "Umbrella Finance contract commitments are on hold until MSA countersignature."),
  item("chain", "Chained legal", "Evil Corp contract commitments are on hold until MSA countersignature."),
];

function judge(): Model {
  return new FakeModel((req) => {
    const ns = [...req.messages.at(-1)!.content.matchAll(/<item n="(\d+)"[^>]*>([^:]*):/g)];
    return JSON.stringify({
      items: ns
        .filter((m) => m[2]!.startsWith("Legal"))
        .map((m) => ({ i: +m[1]!, on: m[2], hits: "commitment approval", act: true })),
    });
  });
}

async function run(
  options: { on?: boolean; model?: Model | null; at?: typeof ref; empty?: boolean; text?: string } = {},
) {
  const cache = new ItemCache();
  cache.close();
  if (!options.empty)
    cache.put(ref, [proof, item("hop", "Contact", "Contact: Umbrella Health\nCompany: Evil Corp")], NOW);
  const pools: PushPoolReport[] = [];
  const model = options.model === undefined ? judge() : options.model;
  const checker = model ? new PushChecker({ model, budget: new Budget() }) : undefined;
  const partner = new ContextPartner({
    sources: async () => [
      { id: "mail", kind: "test", description: "Mail", search: async () => (options.empty ? [] : items) },
    ],
    sourceMap: new SourceMap(),
    cache,
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: {
      ...CORE_CONFIG,
      askReader: true,
      readerPush: true,
      readerGate: true,
      pushCheck: true,
      pushPartyOrgLink: options.on ?? true,
      pushCandidates: 2,
      askReaderPool: 6,
      confidentScore: 99,
      fallbackMatchedTerms: 99,
    },
    ...(checker ? { checker } : {}),
    onPushPool: (p) => pools.push(p),
  });
  const at = options.at ?? ref;
  await partner.observe({ ...at, at: NOW, kind: "user_message", text: options.text ?? REQUEST } as AgentEvent, {
    waitMs: 2_000,
  });
  const ids = partner.takePending(at).flatMap((p) => p.citations.map((c) => c.itemId));
  return { ids, pools };
}

describe("organisation constraints have check-only seats", () => {
  test("default off; enabling requires push check", () => {
    expect(DEFAULT_CONFIG.pushPartyOrgLink).toBe(false);
    expect(() => checkEngineConfig({ pushCheck: false, pushPartyOrgLink: true })).toThrow(/pushCheck/);
    expect(checkEngineConfig({ pushCheck: false, pushPartyOrgLink: false }).pushPartyOrgLink).toBe(false);
  });

  test("at most two organisation constraints enter the capped pool, never aliases, other orgs or a second hop", async () => {
    const off = await run({ on: false });
    const on = await run();
    const isPolicy = (id: string) => ["mail:one", "mail:two", "mail:three"].includes(id);
    expect(on.pools.length).toBeGreaterThan(0);
    for (const pool of on.pools) {
      expect(pool.pool.filter(isPolicy)).toHaveLength(2);
      expect(pool.pool.length).toBeLessThanOrEqual(6);
      expect(pool.pool.some((id) => id === "mail:other" || id === "mail:chain")).toBe(false);
    }
    expect(off.pools.every((p) => p.pool.every((id) => !isPolicy(id)))).toBe(true);
    expect(on.ids.some(isPolicy)).toBe(true);
    expect(off.ids.some(isPolicy)).toBe(false);
  });

  test("absent/failed checks keep the exact unchecked handout; empty checks cannot hand seats", async () => {
    const off = await run({ on: false, model: null });
    expect(off.ids.length).toBeGreaterThan(0);
    expect((await run({ model: null })).ids).toEqual(off.ids);
    expect((await run({ model: new FakeModel(() => "not json") })).ids).toEqual(off.ids);
    expect((await run({ model: new FakeModel(() => '{"items":[]}') })).ids).toEqual([]);
    expect((await run({ empty: true })).ids).toEqual([]);
  });

  test("full party names are recognised even when entity extraction includes a leading verb", async () => {
    const { ids } = await run({ text: "Tell Ahmed Hassan we'll ship the SSO integration next month." });
    expect(ids.some((id) => ["mail:one", "mail:two", "mail:three"].includes(id))).toBe(true);
  });

  test("another tenant or user cannot use the original scope's affiliation", async () => {
    for (const at of [
      { ...ref, tenantId: "other" },
      { ...ref, userId: "other" },
    ]) {
      const { ids, pools } = await run({ at });
      expect(ids.some((id) => ["mail:one", "mail:two", "mail:three"].includes(id))).toBe(false);
      expect(pools.every((p) => p.pool.every((id) => !["mail:one", "mail:two", "mail:three"].includes(id)))).toBe(true);
    }
  });
});
