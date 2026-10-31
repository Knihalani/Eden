import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type Model } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import { StaticSource, type ListPage, type SearchQuery, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { DEFAULT_CONFIG } from "./config";
import { FACT_NAMES, vectorOf, type Facts } from "./decide";
import { ContextPartner, type CandidateDump } from "./partner";

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const TEXT = "Raise a PO for the Aperture Labs licence renewal, £48k, and route it to the CFO";
/** A note that holds the request's own words and names: sure on its words alone. */
const NOTE = {
  ref: "n1",
  title: "Aperture Labs licence renewal",
  text: "Aperture Labs licence renewal: raise the PO for £48k and route it to the CFO when the quote is in.",
};
/** A policy the request breaks (over £40k needs two quotes): a conflict, with too few of its words to be sure. */
const POLICY = {
  ref: "p1",
  title: "Procurement policy v4",
  text: "Purchases above £40,000, including licence renewals, require two competing quotes and CFO sign-off.",
};

const run = async (
  config: Record<string, unknown>,
  opts: { model?: Model; onCandidates?: (d: CandidateDump) => void; users?: string[] } = {},
) => {
  const p = new ContextPartner({
    sources: async () => [new StaticSource("drive", "Notes", [NOTE, POLICY])],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: opts.model ?? null,
    now: () => NOW,
    config: { probes: true, probeGraceMs: 1_000, ...config },
    ...(opts.onCandidates ? { onCandidates: opts.onCandidates } : {}),
  });
  const out: Record<string, string[]> = {};
  for (const userId of opts.users ?? ["u1"]) {
    const scope = { tenantId: "t", userId };
    const r = await p.observe({ ...scope, sessionId: "s", at: NOW, kind: "user_message", text: TEXT } as AgentEvent, {
      waitMs: 1_000,
    });
    out[userId] = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId: "s" })].flatMap((i) =>
      i.citations.map((c) => `${c.itemId} ${i.reason.split(":")[0]}`),
    );
  }
  return out;
};

describe("decide.ts: the candidates' facts, a lab instrument (D67)", () => {
  test("a fact vector holds every fact once, in FACT_NAMES order", () => {
    const facts = Object.fromEntries(FACT_NAMES.map((k, i) => [k, i])) as unknown as Facts;
    expect(vectorOf(facts)).toEqual(FACT_NAMES.map((_, i) => i));
    expect(new Set(FACT_NAMES).size).toBe(FACT_NAMES.length);
  });

  test("decideConflict is off by default, and the engine carries no decision model or its flags", () => {
    expect(DEFAULT_CONFIG.decideConflict).toBe(false);
    for (const gone of ["decide", "decideThreshold", "decideModel"]) expect(gone in DEFAULT_CONFIG).toBe(false);
  });
});

describe("decideConflict: a sure match no longer silences a conflict", () => {
  test("off, the sure note alone; on, the policy the request breaks joins it", async () => {
    expect((await run({ groundConflict: true })).u1).toEqual(["drive:n1 sources"]);
    expect((await run({ groundConflict: true, decideConflict: true })).u1).toEqual([
      "drive:n1 sources+decide-conflict",
      "drive:p1 sources+decide-conflict",
    ]);
  });

  test("the twin under the limit is no conflict: nothing joins", async () => {
    const twin = { ...POLICY, text: POLICY.text.replace("£40,000", "£75,000") };
    const p = new ContextPartner({
      sources: async () => [new StaticSource("drive", "Notes", [NOTE, twin])],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: { probes: true, probeGraceMs: 1_000, decideConflict: true },
    });
    const scope = { tenantId: "t", userId: "u" };
    const r = await p.observe({ ...scope, sessionId: "s", at: NOW, kind: "user_message", text: TEXT } as AgentEvent, {
      waitMs: 1_000,
    });
    const got = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId: "s" })];
    expect(got.flatMap((i) => i.citations.map((c) => c.itemId))).toEqual(["drive:n1"]);
  });

  test("it never displaces what a rule path chose: a full packet stays as it is", async () => {
    expect((await run({ decideConflict: true, maxItemsPerInjection: 1 })).u1).toEqual(["drive:n1 sources"]);
  });

  test("with a model, the judge decides: nothing is added", async () => {
    let calls = 0;
    const model: Model = {
      id: "stub",
      chat: async () => {
        calls++;
        const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
        return { text: `{"pick": []}`, usage, costUsd: 0, truncated: false, model: "stub", latencyMs: 0 };
      },
    };
    expect((await run({ decideConflict: true }, { model })).u1).toEqual(["drive:n1 sources"]);
    expect(calls).toBe(0);
  });

  test("isolation: each user's addition comes from their own lookup", async () => {
    const out = await run({ decideConflict: true }, { users: ["u1", "u2"] });
    expect(out.u1).toEqual(out.u2);
    expect(out.u1).toContain("drive:p1 sources+decide-conflict");
  });
});

describe("the candidate hook (`onCandidates`)", () => {
  test("it gets ids and numbers only, never content", async () => {
    const dumps: CandidateDump[] = [];
    await run({ decideConflict: true }, { onCandidates: (d) => dumps.push(d) });
    expect(dumps.length).toBeGreaterThan(0);
    for (const d of dumps) {
      for (const c of d.candidates) {
        expect(c.id.startsWith("drive:")).toBe(true);
        expect(Object.keys(c.facts)).toEqual([...FACT_NAMES]);
        for (const v of Object.values(c.facts)) expect(typeof v).toBe("number");
      }
    }
    // No content: the dump's text holds neither the request nor an item's words.
    const json = JSON.stringify(dumps);
    expect(json).not.toContain("Aperture");
    expect(json).not.toContain("Procurement");
  });

  test("unwired, the engine decides the same", async () => {
    const dumps: CandidateDump[] = [];
    const wired = await run({ decideConflict: true }, { onCandidates: (d) => dumps.push(d) });
    expect(wired).toEqual(await run({ decideConflict: true }));
  });
});

/** A connector whose recent-first listing can be held open (`hold`), so the world can change while a poll is out. */
class HeldListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  readonly items: ContextItem[] = [];
  private held: Promise<void> | null = null;
  private free: (() => void) | null = null;
  constructor(readonly id: string) {}
  add(note: { ref: string; title: string; text: string }, at: number): void {
    this.items.push({ id: itemId(this.id, note.ref), sourceId: this.id, ...note, updatedAt: at });
  }
  hold(): void {
    this.held = new Promise((r) => (this.free = r));
  }
  release(): void {
    this.free?.();
    this.held = null;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    if (this.held) await this.held;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

// The econ synthesis's interaction (section 2): `syncPollBehind`'s follow-up lookup, made once the poll the first
// lookup did not wait for stored something, adds only sure or grounded items after a delivery. It runs the
// `decideConflict` pass too, so a fresh item the request breaks reaches the agent unasked, not only via `ask_context`.
describe("decideConflict on syncPollBehind's follow-up lookup", () => {
  const HOUR = 3_600_000;
  const scope = { tenantId: "t", userId: "u" };
  const follow = async (config: Record<string, unknown>) => {
    let clock = NOW - 6 * HOUR;
    const src = new HeldListSource("drive");
    src.add(NOTE, clock - HOUR);
    const p = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: {
        sync: true,
        syncPollBehind: true,
        syncPageSize: 2,
        syncCallsPerMin: 600,
        syncMaxStaleMs: 4 * HOUR,
        ...config,
      },
    });
    p.sync!.track(scope);
    while (!p.sync!.warm(scope)) await p.sync!.tick();
    clock = NOW; // Stale now: the lookup polls, behind its answer.
    src.hold();
    const r = await p.observe({ ...scope, sessionId: "s", at: NOW, kind: "user_message", text: TEXT } as AgentEvent, {
      waitMs: 1_000,
    });
    // The policy is filed while the poll is out: only the follow-up lookup can read it.
    src.add(POLICY, NOW);
    src.release();
    const table = (p as unknown as { sessions: Map<string, { inflight: unknown; behind?: unknown }> }).sessions;
    for (let k = 0; k < 500 && [...table.values()].some((x) => x.inflight || x.behind); k++) await Bun.sleep(1);
    const tag = (i: { citations: { itemId: string }[]; reason: string }) =>
      i.citations.map((c) => `${c.itemId} ${i.reason.split(":")[0]}`);
    return {
      first: r.injection ? tag(r.injection) : [],
      later: p.takePending({ ...scope, sessionId: "s" }).flatMap(tag),
    };
  };

  test("off, the follow-up adds nothing; on, it delivers the fresh policy the request breaks", async () => {
    const off = await follow({});
    expect(off.first).toEqual(["drive:n1 sources"]);
    expect(off.later).toEqual([]);
    const on = await follow({ decideConflict: true });
    expect(on.first).toEqual(["drive:n1 sources"]);
    expect(on.later).toEqual(["drive:p1 sources+decide-conflict"]);
  });
});

describe("decideConflict with judgeBehind: the lookup's own conflict, then the judge on the rest", () => {
  const judged = async (decideConflict: boolean) => {
    const OTHER = { ref: "o1", title: "Aperture Labs onboarding", text: "Aperture Labs onboarding call notes." };
    const model = new FakeModel(() => '{"pick": []}');
    const p = new ContextPartner({
      sources: async () => [new StaticSource("drive", "Notes", [POLICY, OTHER])],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model,
      now: () => NOW,
      config: { judgeBehind: true, decideConflict },
    });
    const scope = { tenantId: "t", userId: "u" };
    const r = await p.observe({ ...scope, sessionId: "s", at: NOW, kind: "user_message", text: TEXT } as AgentEvent, {
      waitMs: 1_000,
    });
    await Bun.sleep(5);
    return {
      answer: r.injection?.citations.map((c) => c.itemId) ?? [],
      judgeSaw: model.calls.map((c) => JSON.stringify(c.messages)).join("\n"),
    };
  };

  test("off, the judge reads the policy behind a silent answer; on, the answer holds it and the judge reads the rest", async () => {
    // Nothing is sure and no ground holds (`groundConflict` off): with no model's say, silence.
    const off = await judged(false);
    expect(off.answer).toEqual([]);
    expect(off.judgeSaw).toContain("competing quotes");
    const on = await judged(true);
    expect(on.answer).toEqual(["drive:p1"]);
    expect(on.judgeSaw).toContain("onboarding call notes");
    expect(on.judgeSaw).not.toContain("competing quotes");
  });
});
