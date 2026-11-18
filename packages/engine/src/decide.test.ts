import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, type Model } from "@eden/llm";
import type { AgentEvent, Scope } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
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
  opts: {
    model?: Model | null;
    onCandidates?: (d: CandidateDump) => void;
    users?: string[];
    /** Sessions asked in turn, per user: each answer is kept as `user/session`, the first one as `user` too. */
    sessions?: string[];
    sources?: (scope: Scope) => Promise<Source[]>;
    budget?: Budget;
  } = {},
) => {
  const p = new ContextPartner({
    sources: opts.sources ?? (async () => [new StaticSource("drive", "Notes", [NOTE, POLICY])]),
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: opts.budget ?? new Budget(),
    model: opts.model ?? null,
    now: () => NOW,
    // The candidates push (D237, with no reader since D276) dumps its own rows; these tests are the lookup's.
    config: { probes: true, probeGraceMs: 1_000, pushCandidates: 0, ...config },
    ...(opts.onCandidates ? { onCandidates: opts.onCandidates } : {}),
  });
  const out: Record<string, string[]> = {};
  for (const userId of opts.users ?? ["u1"]) {
    const scope = { tenantId: "t", userId };
    for (const [k, sessionId] of (opts.sessions ?? ["s"]).entries()) {
      const r = await p.observe({ ...scope, sessionId, at: NOW, kind: "user_message", text: TEXT } as AgentEvent, {
        waitMs: 1_000,
      });
      // What a lookup queues lands a tick later.
      await Bun.sleep(5);
      const got = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId })].flatMap((i) =>
        i.citations.map((c) => `${c.itemId} ${i.reason.split(":")[0]}`),
      );
      if (k === 0) out[userId] = got;
      out[`${userId}/${sessionId}`] = got;
    }
  }
  return out;
};

describe("decide.ts: the candidates' facts, a lab instrument (D67)", () => {
  test("a fact vector holds every fact once, in FACT_NAMES order", () => {
    const facts = Object.fromEntries(FACT_NAMES.map((k, i) => [k, i])) as unknown as Facts;
    expect(vectorOf(facts)).toEqual(FACT_NAMES.map((_, i) => i));
    expect(new Set(FACT_NAMES).size).toBe(FACT_NAMES.length);
  });

  test("the engine carries no decision model or its flags", () => {
    for (const gone of ["decide", "decideThreshold", "decideModel", "decideConflict"]) {
      expect(gone in DEFAULT_CONFIG).toBe(false);
    }
  });
});

describe("the candidate hook (`onCandidates`)", () => {
  test("it gets ids and numbers only, never content", async () => {
    const dumps: CandidateDump[] = [];
    await run({ groundConflict: true }, { onCandidates: (d) => dumps.push(d) });
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

  test("a delivery is never dumped as silence", async () => {
    const dumps: CandidateDump[] = [];
    const out = await run({ groundConflict: true, companions: false }, { onCandidates: (d) => dumps.push(d) });
    expect(out.u1).toEqual(["drive:n1 sources"]);
    const delivering = dumps.filter((d) => d.delivered.length > 0);
    expect(delivering.length).toBeGreaterThan(0);
    for (const d of delivering) expect(d.how).toBe("sure");
    for (const d of dumps.filter((d) => d.delivered.length === 0)) expect(d.how).toBe("");
  });

  test("unwired, the engine decides the same", async () => {
    const dumps: CandidateDump[] = [];
    const wired = await run({ groundConflict: true }, { onCandidates: (d) => dumps.push(d) });
    expect(wired).toEqual(await run({ groundConflict: true }));
  });
});
