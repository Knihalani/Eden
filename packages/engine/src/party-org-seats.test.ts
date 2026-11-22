import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";
import { checkKey, checkMessages, PushChecker, type PushCheckInput } from "./push-check";
import { readerItem } from "./reader";

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
  options: {
    on?: boolean;
    stem?: boolean;
    check?: boolean;
    model?: Model | null;
    at?: typeof ref;
    empty?: boolean;
    text?: string;
    contents?: ContextItem[];
    poolSize?: number;
  } = {},
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
      {
        id: "mail",
        kind: "test",
        description: "Mail",
        search: async () => (options.empty ? [] : (options.contents ?? items)),
      },
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
      pushCheck: options.check ?? true,
      pushPartyOrgLink: options.on ?? DEFAULT_CONFIG.pushPartyOrgLink,
      pushConstraintStemSeats: options.stem ?? false,
      pushCandidates: 2,
      askReaderPool: options.poolSize ?? 6,
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
  const packets = partner.takePending(at);
  const ids = packets.flatMap((p) => p.citations.map((c) => c.itemId));
  return { ids, pools, packets, cache };
}

describe("organisation constraints have check-only seats", () => {
  test("affiliation evidence survives rule references, is redacted, and changes the check cache key", () => {
    const secret = "sk_live_" + "a".repeat(32);
    const affiliation = `Ahmed Hassan — Umbrella Health (contact Company field, ${secret})`;
    const candidate = readerItem(items[4]!, new Set());
    const input: PushCheckInput = {
      request: REQUEST,
      today: "2026-10-27",
      items: [{ ...candidate, affiliation }],
      sheet: [
        { id: candidate.id, title: candidate.title, statement: candidate.text, kind: "constraint", source: "mail" },
      ],
      sheetRefs: true,
    };
    const prompt = checkMessages(input).at(-1)!.content;
    expect(prompt).toContain('rule="1"');
    expect(prompt).toContain("Affiliation evidence (data): Ahmed Hassan");
    expect(prompt).not.toContain(secret);
    expect(checkKey(input)).not.toBe(checkKey({ ...input, items: [candidate] }));
    expect(checkKey(input)).not.toBe(checkKey({ ...input, items: [{ ...candidate, affiliation: "Other evidence" }] }));
  });

  test("org seats carry bounded provenance to the checker, never to packet text", async () => {
    const prompts: string[] = [];
    const model = new FakeModel((req) => {
      prompts.push(req.messages.at(-1)!.content);
      return '{"items":[]}';
    });
    await run({ model });
    expect(
      prompts.some((text) =>
        text.includes(
          "Affiliation evidence (data): Ahmed Hassan — Umbrella Health (sender-matched signature, mail:proof)",
        ),
      ),
    ).toBe(true);
    expect((await run()).packets.every((p) => !p.text.includes("Affiliation evidence"))).toBe(true);
    expect((await run({ model: null })).packets.every((p) => !p.text.includes("Affiliation evidence"))).toBe(true);
  });

  test("default on; enabling requires push check", () => {
    expect(DEFAULT_CONFIG.pushPartyOrgLink).toBe(true);
    expect(() => checkEngineConfig({ pushCheck: false, pushPartyOrgLink: true }, { deps: { checker: true } })).toThrow(
      /pushCheck/,
    );
    expect(checkEngineConfig({ pushCheck: false, pushPartyOrgLink: false }).pushPartyOrgLink).toBe(false);
  });

  test("affiliations stay unindexed without a checker or with check-only seats off", async () => {
    expect((await run()).cache.partyOrgs(ref, "Ahmed Hassan", NOW)).toHaveLength(1);
    for (const options of [{ model: null }, { check: false }, { on: false }]) {
      const result = await run(options);
      expect(result.cache.partyOrgs(ref, "Ahmed Hassan", NOW)).toEqual([]);
    }
    const unchecked = await run({ model: null, stem: DEFAULT_CONFIG.pushConstraintStemSeats });
    const off = await run({ model: null, on: false, stem: false });
    expect(unchecked.ids).toEqual(off.ids);
    expect(unchecked.pools.map((p) => p.pool)).toEqual(off.pools.map((p) => p.pool));
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

  test("stem and organisation seats coexist, bounded and de-duplicated, with the same unchecked fallback", async () => {
    const shared = ["north", "south"].map((id) =>
      item(id, `Umbrella Health renewals ${id}`, "Umbrella Health renewals are on hold."),
    );
    const legal = ["east", "west", "central"].map((id) =>
      item(id, `Legal ${id}`, "Umbrella Health contract commitments are on hold until MSA countersignature."),
    );
    const options = {
      text: "Reply to Ahmed Hassan about the renewal.",
      contents: [...items.slice(0, 2), ...shared, ...legal],
      poolSize: 8,
    };
    const base = (await run({ ...options, on: false })).pools.at(-1)!.pool;
    const stem = (await run({ ...options, on: false, stem: true })).pools.at(-1)!.pool;
    const org = (await run(options)).pools.at(-1)!.pool;
    expect(stem.filter((id) => !base.includes(id))).toEqual(expect.arrayContaining(shared.map((x) => x.id)));
    expect(stem.filter((id) => !base.includes(id))).toHaveLength(2);
    expect(org.filter((id) => !base.includes(id))).toHaveLength(2);
    expect(org.some((id) => shared.some((x) => x.id === id))).toBe(true);
    const both = await run({ ...options, stem: true });
    expect(both.pools.length).toBeGreaterThan(0);
    for (const { pool } of both.pools) {
      expect(new Set(pool).size).toBe(pool.length);
      expect(pool.length).toBeLessThanOrEqual(options.poolSize);
      expect(pool.filter((id) => shared.some((x) => x.id === id))).toHaveLength(2);
      expect(pool.filter((id) => legal.some((x) => x.id === id))).toHaveLength(2);
      expect(pool.filter((id) => !base.includes(id))).toHaveLength(4);
    }
    const unchecked = await run({ ...options, on: false, model: null });
    expect((await run({ ...options, stem: true, model: null })).ids).toEqual(unchecked.ids);
    expect((await run({ ...options, stem: true, model: new FakeModel(() => "not json") })).ids).toEqual(unchecked.ids);
  });

  test("superseded policies cannot crowd a current policy out of org or stem seats", async () => {
    const policies = [
      ...["old-a", "old-b"].map((id) =>
        item(id, `Legal [superseded] ${id}`, "Umbrella Health renewals are on hold. This policy has been superseded."),
      ),
      item("current", "Legal current", "Umbrella Health renewals are on hold until MSA countersignature."),
    ];
    for (const flags of [{ on: true }, { on: false, stem: true }, { on: true, stem: true }]) {
      const result = await run({
        ...flags,
        text: "Reply to Ahmed Hassan about the renewal.",
        contents: [...items.slice(0, 2), ...policies],
      });
      expect(result.pools.length).toBeGreaterThan(0);
      for (const { pool } of result.pools) {
        expect(pool).toContain("mail:current");
        expect(pool).not.toContain("mail:old-a");
        expect(pool).not.toContain("mail:old-b");
      }
      expect(result.ids).toContain("mail:current");
    }
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
