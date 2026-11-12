import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type ChatResponse, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { PushChecker } from "./push-check";
import { CANDIDATES_LEAD, LOOKUP_HEAD_LEAD, LOOKUP_LEAD, LOOKUP_QUIET } from "./render";

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
  // A plain record (no constraint wording) naming the request's entity: what a lookup hands.
  item("thread", "Harlow venue booking", "Thanks for booking the Harlow venue for the team dinner, see you there.", 6),
];
const REQUEST = "Pay the Harlow venue deposit invoice today.";
const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };

/** A check that names nothing (`{"items":[]}`), or one whose reply does not parse (the check failed). */
const silent = () => new FakeModel(() => `{"items":[]}`);
const broken = () => new FakeModel(() => "not json");
/** A check that names nothing, answering after `ms`: past a short `pushCheckWaitMs` it lands late. */
const slowSilent = (ms: number): Model & { calls: ChatRequest[] } => {
  const inner = silent();
  return {
    id: "slow",
    calls: inner.calls,
    chat: async (req: ChatRequest): Promise<ChatResponse> => {
      await new Promise((r) => setTimeout(r, ms));
      return inner.chat(req);
    },
  };
};

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

  test("on: a constraint-like record the check rejected is never handed as reference (a look-alike)", async () => {
    const got = await taken(partner({ pushLookup: 3, pushLookupAny: true }, silent()));
    const ids = got!.citations.map((c) => c.itemId);
    expect(ids).toContain("mail:thread");
    // "on hold until…" is constraint wording: the check read it and named nothing, so it stays out.
    expect(ids).not.toContain("mail:hold");
  });

  test("on, k caps the records", async () => {
    const got = await taken(partner({ pushLookup: 1 }, silent()));
    expect(got!.citations.length).toBe(1);
  });

  test("on, but the check failed: the unchecked candidates go out as before, never framed as reference", async () => {
    const got = await taken(partner({ pushLookup: 3 }, broken()));
    expect(got).toBeDefined();
    expect(got!.text).toContain(CANDIDATES_LEAD);
    expect(got!.text).not.toContain(LOOKUP_LEAD);
  });

  test("a check that landed late and is read again (no call this pass) still gives the lookup (review finding 1)", async () => {
    // The first request's check is past the wait, so the push fails open to one unchecked candidate. The same request
    // again reads the settled answer, which named nothing, with no new call (`called` false): the lookup must still
    // hand the other record that names the request.
    const model = slowSilent(150);
    const p = partner({ pushLookup: 3, pushCheckWaitMs: 20, pushCandidates: 1 }, model);
    const first = await taken(p);
    expect(first!.text).toContain(CANDIDATES_LEAD);
    await new Promise((r) => setTimeout(r, 250));
    const got = await taken(p);
    expect(model.calls.length).toBe(1);
    expect(got).toBeDefined();
    expect(got!.text).toContain(LOOKUP_LEAD);
    expect(got!.citations.map((c) => c.itemId)).not.toContain(first!.citations[0]!.itemId);
  });

  test("a record already handed is not handed again (the not-twice ledger)", async () => {
    const p = partner({ pushLookup: 3 }, silent());
    const first = await taken(p);
    expect(first!.citations.length).toBeGreaterThan(0);
    const again = await taken(p);
    const repeated = (again?.citations ?? []).filter((c) => first!.citations.some((f) => f.itemId === c.itemId));
    expect(repeated).toEqual([]);
  });

  test("on, nothing in the pool names the request's anchors: still silent", async () => {
    expect(await taken(partner({ pushLookup: 3 }, silent()), "Pay the venue deposit invoice today.")).toBeUndefined();
  });

  test("pushLookupAny: nothing named, so the pool's head goes out under the same lead", async () => {
    const got = await taken(
      partner({ pushLookup: 2, pushLookupAny: true }, silent()),
      "Pay the venue deposit invoice today.",
    );
    expect(got).toBeDefined();
    // Nothing names the request, so the lead says only that Eden's search ranked them first (review finding 2).
    expect(got!.text).toContain(LOOKUP_HEAD_LEAD);
    expect(got!.text).not.toContain(LOOKUP_LEAD);
    expect(got!.citations.length).toBe(2);
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, pushLookup: 3, pushLookupAny: true })).not.toThrow();
    // Without a count the child switches would do nothing; a count must be a small whole number.
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, pushLookupAny: true })).toThrow(/pushLookup/);
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, pushLookupQuiet: true })).toThrow(/pushLookup/);
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, pushLookup: 2.5 })).toThrow();
    expect(DEFAULT_CONFIG.pushLookupAny).toBe(false);
  });

  test("pushLookupQuiet: the lead closes on the background line, not the details line", async () => {
    const got = await taken(partner({ pushLookup: 3, pushLookupQuiet: true }, silent()));
    expect(got!.text).toContain(LOOKUP_QUIET);
    expect(got!.text).not.toContain("Use them for details the request needs.");
    expect(LOOKUP_LEAD).toContain("Use them for details the request needs.");
    expect(DEFAULT_CONFIG.pushLookupQuiet).toBe(false);
  });

  test("on, no checker wired (no model key): no lookup packet, the push is as before", async () => {
    const got = await taken(partner({ pushLookup: 3 }, null));
    expect(got?.text ?? "").not.toContain(LOOKUP_LEAD);
  });
});
