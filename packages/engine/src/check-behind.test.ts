import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { PushChecker } from "./push-check";
import { CHECK_BEHIND_LEAD } from "./render";
import type { Trace } from "./trace";

// O3 (D700): the `pushCheckBehind` trial. The push does not wait for its check: the default's candidates go at once,
// the check runs behind, and the items it names that the agent has not been handed follow as a packet of their own.

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
  item("other", "Invoice archive", "Older invoice for a venue deposit, paid last year.", 500),
];
const REQUEST = "Pay the Harlow venue deposit invoice.";

function numbers(req: ChatRequest): Map<string, number> {
  const user = req.messages.at(-1)!.content;
  const out = new Map<string, number>();
  for (const m of user.matchAll(/<item n="(\d+)"[^>]*>([^:]*):/g)) out.set(m[2]!, Number(m[1]));
  return out;
}

/** A model that names the items titled in `yes`, after `gate` resolves (a check still on the wire until then). */
function says(yes: string[], gate: Promise<void> = Promise.resolve()) {
  const fake = new FakeModel((req) => {
    const n = numbers(req);
    const entries = yes.filter((t) => n.has(t)).map((t) => `{"i":${n.get(t)},"why":"it changes it","act":true}`);
    return `{"items":[${entries.join(",")}]}`;
  });
  const model: Model & { calls: ChatRequest[] } = {
    id: "gated",
    calls: fake.calls,
    chat: async (r) => {
      await gate;
      return fake.chat(r);
    },
  };
  return model;
}

function setup(config: Record<string, unknown>, model: Model, traces: Trace[] = []) {
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
      pushCheck: true,
      pushCheckBehind: true,
      ...config,
    },
    checker: new PushChecker({ model, budget: new Budget() }),
    onTrace: (t) => traces.push(t),
  });
  return partner;
}

const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
const say = (p: ContextPartner, text = REQUEST, at = ref) =>
  p.observe({ ...at, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
const ids = (xs: { citations: { itemId: string }[] }[]) => xs.flatMap((x) => x.citations.map((c) => c.itemId));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("pushCheckBehind (O3, D700): the check runs behind the default's packet", () => {
  test("off in the default, with no ask wait", () => {
    expect(DEFAULT_CONFIG.pushCheckBehind).toBe(false);
    expect(DEFAULT_CONFIG.pushCheckAskWaitMs).toBe(0);
  });

  test("the default's candidates go without waiting for the check; what it adds follows as its own packet", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const model = says(["Harlow venue", "Invoice archive"], gate);
    const traces: Trace[] = [];
    const partner = setup({}, model, traces);
    await say(partner);
    // The check is still on the wire: the default's first two candidates are already there.
    const first = partner.takePending(ref);
    expect(first.length).toBe(1);
    expect(first[0]!.reason.startsWith("candidates:")).toBe(true);
    const had = ids(first);
    expect(had.length).toBe(2);
    expect(partner.takePending(ref)).toEqual([]);
    open();
    await tick();
    const later = partner.takePending(ref);
    expect(later.length).toBe(1);
    expect(later[0]!.reason.startsWith("check-behind:")).toBe(true);
    expect(later[0]!.text).toContain(CHECK_BEHIND_LEAD);
    // Only what the check named and the first packet did not hold; a named item already handed is not sent twice.
    const named = ["mail:hold", "mail:other"];
    expect(ids(later).sort()).toEqual(named.filter((id) => !had.includes(id)).sort());
    expect(ids(later).length).toBeGreaterThan(0);
    expect(model.calls.length).toBe(1);
    // The call is traced on its own, with its cost; the follow-up has a trace of its own.
    const late = traces.filter((t) => t.decision === "check-late");
    expect(late.length).toBe(1);
    expect(late[0]!.reason).toBe("push check behind");
    expect(late[0]!.modelCalls).toBe(1);
    expect(traces.some((t) => t.reason === "check behind" && t.itemIds.length === ids(later).length)).toBe(true);
  });

  test("a check that names nothing, or only what was handed, queues nothing and never silences the packet", async () => {
    const silent = setup({}, says([]));
    await say(silent);
    await tick();
    const got = silent.takePending(ref);
    expect(got.length).toBe(1);
    expect(got[0]!.reason.startsWith("candidates:")).toBe(true);
    const partner = setup({}, says(["Harlow venue", "Harlow invoice", "Harlow deposit", "Invoice archive"]));
    await say(partner);
    const first = ids(partner.takePending(ref));
    await tick();
    const later = ids(partner.takePending(ref));
    for (const id of later) expect(first).not.toContain(id);
  });

  test("a failed or unreadable check queues nothing", async () => {
    const down: Model = {
      id: "down",
      chat: async () => {
        throw new Error("down");
      },
    };
    for (const model of [new FakeModel(() => "not json"), down]) {
      const partner = setup({}, model);
      await say(partner);
      await tick();
      expect(partner.takePending(ref).every((x) => x.reason.startsWith("candidates:"))).toBe(true);
    }
  });

  test("a follow-up that lands after the user's next request is not queued; one queued untaken is withdrawn", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const partner = setup({}, says(["Invoice archive"], gate));
    await say(partner);
    partner.takePending(ref);
    await say(partner, "What is the weather like?");
    open();
    await tick();
    expect(partner.takePending(ref).some((x) => x.reason.startsWith("check-behind:"))).toBe(false);

    const again = setup({}, says(["Invoice archive"]));
    const at = { ...ref, sessionId: "s2" };
    await say(again, REQUEST, at);
    await tick();
    // Queued and not taken: the next request withdraws it, and its item is deliverable again.
    await say(again, "What is the weather like?", at);
    expect(again.takePending(at).some((x) => x.reason.startsWith("check-behind:"))).toBe(false);
  });

  test("a session closed while the check runs queues nothing", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const partner = setup({}, says(["Invoice archive"], gate));
    await say(partner);
    await partner.observe({ ...ref, at: NOW, kind: "session_end" } as AgentEvent);
    open();
    await tick();
    expect(partner.takePending(ref)).toEqual([]);
  });

  test("an ask in the request waits a bounded moment for the check, so its follow-up is there at the next take", async () => {
    const slow = (ms: number) => says(["Invoice archive"], new Promise<void>((r) => setTimeout(r, ms)));
    const waits = setup({ pushCheckAskWaitMs: 400 }, slow(80));
    await say(waits);
    waits.takePending(ref);
    await waits.ask({ ...ref, question: "Harlow dispute" });
    expect(waits.takePending(ref).some((x) => x.reason.startsWith("check-behind:"))).toBe(true);

    // No wait configured: the ask returns at once and the follow-up is not there yet.
    const at = { ...ref, sessionId: "s3" };
    const none = setup({}, slow(80));
    await say(none, REQUEST, at);
    none.takePending(at);
    await none.ask({ ...at, question: "Harlow dispute" });
    expect(none.takePending(at).some((x) => x.reason.startsWith("check-behind:"))).toBe(false);

    // The wait is bounded: a check slower than it does not hold the ask.
    const at4 = { ...ref, sessionId: "s4" };
    const bounded = setup({ pushCheckAskWaitMs: 30 }, slow(1_000));
    await say(bounded, REQUEST, at4);
    const t0 = performance.now();
    await bounded.ask({ ...at4, question: "Harlow dispute" });
    expect(performance.now() - t0).toBeLessThan(500);
  });

  test("isolation: one user's follow-up is never another's", async () => {
    const partner = setup({}, says(["Invoice archive"]));
    const other = { ...ref, userId: "u2" };
    await say(partner);
    await tick();
    expect(partner.takePending(other)).toEqual([]);
    expect(partner.takePending(ref).length).toBeGreaterThan(0);
  });

  test("the settings need pushCheck and a checker; the ask wait needs pushCheckBehind", () => {
    const base = { ...DEFAULT_CONFIG };
    const deps = { deps: { checker: true } };
    expect(() => checkEngineConfig({ ...base, pushCheck: true, pushCheckBehind: true })).toThrow();
    expect(() => checkEngineConfig({ ...base, pushCheckBehind: true }, deps)).toThrow();
    expect(() => checkEngineConfig({ ...base, pushCheck: true, pushCheckBehind: true }, deps)).not.toThrow();
    expect(() => checkEngineConfig({ ...base, pushCheck: true, pushCheckAskWaitMs: 300 }, deps)).toThrow();
  });
});
