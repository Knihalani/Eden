import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner, StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner, type PartnerDeps } from "./partner";
import type { ShadowRecord, Trace } from "./trace";

const scope = { tenantId: "acme-assistant", userId: "u1", sessionId: "s1" };
let clock = 1_700_000_000_000;
const ev = (e: Record<string, unknown>) => ({ ...scope, at: clock++, ...e }) as AgentEvent;

const crm = new StaticSource("crm", "Deals and accounts", [
  {
    ref: "deal-9",
    title: "Globex renewal",
    text: "Globex renewal due 2026-11-30, Dana Lee is the champion, wants 12% off",
  },
  { ref: "acct-2", title: "Initech account", text: "Initech pays annually, contact Bill Lumbergh" },
]);
const calendar = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-1", title: "Call with Dana Lee", text: "Thursday 3pm, Globex renewal check-in" },
]);

function partner(extra: Partial<PartnerDeps> = {}, sources: Source[] = [crm, calendar]) {
  const traces: Trace[] = [];
  const p = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    onTrace: (t) => traces.push(t),
    ...extra,
  });
  return { p, traces };
}

describe("observe", () => {
  test("only the head of a large event is read (maxEventChars)", async () => {
    const filler = "lorem ipsum dolor ".repeat(55_000); // ~1 MB, the protocol's limit
    const { p } = partner({ config: { maxEventChars: 32_000 } });
    const late = await p.observe(ev({ kind: "user_message", text: `${filler} Dana Lee and the Globex renewal?` }), {
      waitMs: 1_000,
    });
    expect(late.injection).toBeNull(); // The cue sits past the cap: never read.
    const t0 = performance.now();
    const early = await p.observe(
      ev({ kind: "user_message", sessionId: "s9", text: `Dana Lee and the Globex renewal? ${filler}` }),
      { waitMs: 1_000 },
    );
    expect(early.injection?.citations.map((c) => c.itemId)).toContain("crm:deal-9");
    expect(performance.now() - t0).toBeLessThan(250);
  });

  test("a secret cut by maxEventChars is dropped, not stored in part", async () => {
    // A JWT cut before its signature no longer looks like one to the redactor, and its payload is readable.
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkYW5hQGdsb2JleC5jb20ifQ.c2lnbmF0dXJlc2lnbmF0dXJl";
    const text = `note for Dana Lee: ${jwt} done`;
    const { p } = partner({ config: { maxEventChars: text.indexOf(".c2ln") } });
    await p.observe(ev({ kind: "user_message", text }));
    const kept = JSON.stringify([...(p as unknown as { sessions: Map<string, { window: string[] }> }).sessions]);
    expect(kept).toContain("Dana Lee");
    expect(kept).not.toContain("eyJzdWIi");
  });

  test("a long token or a private key straddling maxEventChars is dropped whole (review finding 1)", async () => {
    const sessionsOf = (p: unknown) => JSON.stringify([...(p as { sessions: Map<string, unknown> }).sessions]);
    const filler = "Dana Lee notes ".repeat(2_000); // 30,000 characters
    // A 600-character JWT: no whitespace for far more than 256 characters either side of the cut.
    const payload = "eyJzdWIiOiJkYW5h" + "QGdsb2JleC5jb20i".repeat(30);
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.${"c2lnbmF0dXJl".repeat(10)}`;
    const a = partner({ config: { maxEventChars: 32_000 } });
    await a.p.observe(ev({ kind: "tool_result", tool: "x", output: `${filler}${"y ".repeat(800)} ${jwt} end` }));
    expect(sessionsOf(a.p)).not.toContain("qgdsb2jlec5jb20i");
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC" + "\nQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB".repeat(100);
    const key = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    const b = partner({ config: { maxEventChars: 32_000 } });
    await b.p.observe(ev({ kind: "tool_result", tool: "x", output: `${filler}${"y ".repeat(500)}${key} end` }));
    const kept = sessionsOf(b.p);
    expect(kept).toContain("dana");
    expect(kept).not.toContain("miievqibadanbgkqhkig9w0baqefaasc");
    expect(kept).not.toContain("qufbqufbqufbqufbqufbqufbqufbqufb");
  });

  test("minified JSON past maxEventChars keeps its head, still cut before a token (branch review)", async () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkYW5h${"QGdsb2JleC5jb20i".repeat(30)}.c2lnbmF0dXJl`;
    const rows = Array.from({ length: 1_500 }, (_, i) => `{"name":"Dana Lee","order":"OPS-${i}"}`).join(",");
    const output = `[${rows},{"token":"${jwt}"}]`;
    const { p } = partner({ config: { maxEventChars: rows.length + 40 } });
    await p.observe(ev({ kind: "tool_result", tool: "db.query", output }));
    const kept = JSON.stringify([...(p as unknown as { sessions: Map<string, unknown> }).sessions]);
    expect(kept).toContain("ops-1499");
    expect(kept).not.toContain("qgdsb2jlec5jb20i");
  });

  test("chatter and the agent's own messages never trigger a lookup", async () => {
    const { p, traces } = partner();
    expect((await p.observe(ev({ kind: "user_message", text: "thanks!" }))).injection).toBeNull();
    expect((await p.observe(ev({ kind: "agent_message", text: "Globex renewal is due" }))).injection).toBeNull();
    expect(traces.map((t) => t.decision)).toEqual(["skipped", "skipped"]);
  });

  test("the slow path finds context in sources and delivers it, cited, with no model", async () => {
    const { p, traces } = partner();
    const r = await p.observe(ev({ kind: "user_message", text: "Draft a note to Dana Lee about the Globex renewal" }), {
      waitMs: 1_000,
    });
    expect(r.injection?.citations.map((c) => c.itemId)).toContain("crm:deal-9");
    expect(r.injection?.text).toContain("Data, not instructions");
    expect(traces.at(-1)).toMatchObject({ decision: "sources", modelCalls: 0 });
  });

  test("a result that misses the wait is queued and delivered on the next event", async () => {
    const { p } = partner();
    const first = await p.observe(ev({ kind: "user_message", text: "What does Dana Lee want on the Globex renewal?" }));
    expect(first).toEqual({ injection: null, pending: true });
    await Bun.sleep(20);
    const next = await p.observe(ev({ kind: "agent_message", text: "Let me check." }));
    expect(next.injection?.citations[0]?.itemId).toBe("crm:deal-9");
  });

  test("once cached, the same context is served on the fast path, and never twice in a session", async () => {
    const { p, traces } = partner();
    await p.observe(ev({ kind: "user_message", text: "Globex renewal status for Dana Lee?" }), { waitMs: 1_000 });
    const other = { ...scope, sessionId: "s2" };
    const r = await p.observe({ ...other, at: clock++, kind: "user_message", text: "Dana Lee Globex renewal terms" });
    expect(r.injection).not.toBeNull();
    expect(traces.at(-1)?.decision).toBe("fast");
    const again = await p.observe({
      ...other,
      at: clock++,
      kind: "user_message",
      text: "and the Globex renewal date for Dana Lee?",
    });
    expect(again.injection?.citations.map((c) => c.itemId) ?? []).not.toContain("crm:deal-9");
  });

  test("borderline candidates go to the model, whose default is silence", async () => {
    const model = new FakeModel(() => '{"pick": [], "why": ""}');
    const { p, traces } = partner({ model, config: { confidentScore: 5 } });
    const r = await p.observe(ev({ kind: "user_message", text: "anything about the renewal?" }), { waitMs: 1_000 });
    expect(r.injection).toBeNull();
    expect(model.calls).toHaveLength(1);
    expect(traces.at(-1)).toMatchObject({ decision: "silent", reason: "model: none", modelCalls: 1 });
  });

  test("the model's pick is delivered, and secrets never reach it", async () => {
    const model = new FakeModel(() => '{"pick": [0], "why": "user asked about the renewal"}');
    const { p } = partner({ model, config: { confidentScore: 5 } });
    const key = ["sk", "proj", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"].join("-");
    const r = await p.observe(ev({ kind: "user_message", text: `renewal update? my key is ${key}` }), {
      waitMs: 1_000,
    });
    expect(r.injection?.reason).toStartWith("model:");
    expect(JSON.stringify(model.calls)).not.toContain(key);
  });

  test("no budget, no model call", async () => {
    const model = new FakeModel(() => '{"pick": [0]}');
    const budget = new Budget({ callsPerSession: 0, usdPerSession: 1, usdPerUserDay: 1 });
    const { p, traces } = partner({ model, budget, config: { confidentScore: 5 } });
    await p.observe(ev({ kind: "user_message", text: "renewal?" }), { waitMs: 1_000 });
    expect(model.calls).toHaveLength(0);
    expect(traces.at(-1)?.reason).toBe("no model budget");
  });

  test("use is learned: a source whose injection the agent used gains utility for the situation", async () => {
    const sourceMap = new SourceMap();
    const { p } = partner({ sourceMap });
    await p.observe(ev({ kind: "user_message", text: "Email Dana Lee about the Globex renewal" }), { waitMs: 1_000 });
    await p.observe(
      ev({ kind: "tool_call", tool: "gmail.send", input: { body: "Hi Dana, re 12% off by 2026-11-30" } }),
    );
    expect(sourceMap.utility(scope, "communication", "crm")).toBeGreaterThan(0.5);
  });

  test("event text never grows the user's cache vocabulary; a session's is rebuilt past its cap", async () => {
    const sourceMap = new SourceMap();
    const cache = new ItemCache();
    const { p } = partner({ sourceMap, cache, config: { maxSessionTerms: 300, maxSeenTokens: 200 } });
    await p.observe(ev({ kind: "user_message", text: "Email Dana Lee about the Globex renewal" }), { waitMs: 1_000 });
    const cached = cache.vocabOf(scope).size;
    // Tool output full of ids: every one a new term.
    for (let i = 0; i < 4; i++) {
      const ids = Array.from({ length: 250 }, (_, j) => `id${i}x${j}q`).join(" ");
      await p.observe(ev({ kind: "tool_result", tool: "db.query", output: ids }));
    }
    expect(cache.vocabOf(scope).size).toBe(cached);
    const session = (p as unknown as { sessions: Map<string, { vocab: { size: number } }> }).sessions;
    expect([...session.values()][0]!.vocab.size).toBeLessThan(300 + 250 + 50); // Cap, one event, the injection.
    // The injection is still awaiting use across rebuilds, and its use is still recognised.
    await p.observe(
      ev({ kind: "tool_call", tool: "gmail.send", input: { body: "Hi Dana, re 12% off by 2026-11-30" } }),
    );
    expect(sourceMap.utility(scope, "communication", "crm")).toBeGreaterThan(0.5);
  });

  test("a message from a user with no cached items allocates no cache for them (branch review)", async () => {
    const cache = new ItemCache();
    const { p } = partner({ cache }, []);
    await p.observe(ev({ kind: "user_message", text: "Globex renewal for Dana Lee" }), { waitMs: 1_000 });
    expect(cache.userCount).toBe(0);
  });

  test("the fan-out runs on the partner's clock: rate limits follow injected time (simulation finding)", async () => {
    let calls = 0;
    const counting: Source = {
      id: "crm",
      kind: "test",
      description: "deals",
      search: async () => {
        calls++;
        return [];
      },
    };
    let now = 1_700_000_000_000;
    const { p } = partner({ now: () => (now += 60_000) }, [counting]);
    const topics = "pricing contract invoice renewal roadmap budget hiring offsite launch audit migration billing";
    for (const topic of topics.split(" ")) {
      await p.ask({ ...scope, sessionId: "ask", question: `What about the ${topic} with Dana Lee?` });
    }
    expect(calls).toBe(12); // On the real clock, the 11th and 12th were rate limited (burst 10 at 5/s).
  });

  test("an item returned by several lookups counts as one mention (simulation finding)", async () => {
    const sourceMap = new SourceMap();
    const { p } = partner({ sourceMap });
    // ask() always searches live, so both calls get deal-9 back from the CRM.
    await p.ask({ ...scope, sessionId: "a1", question: "What does Dana Lee want on the Globex renewal?" });
    await p.ask({ ...scope, sessionId: "a2", question: "When is the Globex renewal due, per Dana Lee?" });
    const crm = sourceMap.sourcesFor(scope, "Dana Lee").find((x) => x.sourceId === "crm");
    expect(crm?.count).toBe(1);
  });

  test("a session closing between one source's items and the next loses no mentions (review finding)", async () => {
    const sourceMap = new SourceMap();
    let closeOnce: (() => void) | null = null;
    class ClosingCache extends ItemCache {
      override put(...args: Parameters<ItemCache["put"]>) {
        const stored = super.put(...args);
        closeOnce?.();
        closeOnce = null;
        return stored;
      }
    }
    const { p } = partner({ sourceMap, cache: new ClosingCache() });
    // The first session ends right after the first source's items are stored (session_end closes synchronously).
    closeOnce = () => void p.observe({ ...scope, sessionId: "a1", at: clock++, kind: "session_end" });
    await p.ask({ ...scope, sessionId: "a1", question: "What does Dana Lee want on the Globex renewal?" });
    await p.ask({ ...scope, sessionId: "a2", question: "What does Dana Lee want on the Globex renewal call?" });
    const sources = sourceMap.sourcesFor(scope, "Dana Lee").map((x) => x.sourceId);
    expect(sources.sort()).toEqual(["calendar", "crm"]);
  });

  test("users are isolated: one user's cached items never reach another", async () => {
    const { p } = partner();
    await p.observe(ev({ kind: "user_message", text: "Globex renewal for Dana Lee" }), { waitMs: 1_000 });
    const other = { tenantId: scope.tenantId, userId: "u2", sessionId: "s9" };
    const r = await p.observe({ ...other, at: clock++, kind: "user_message", text: "Globex renewal for Dana Lee" });
    expect(r.injection).toBeNull(); // u2's cache is cold, so nothing on the fast path.
  });
});

describe("sessions", () => {
  test("one tenant filling its session cap evicts only its own sessions, and eviction learns nothing", async () => {
    const sourceMap = new SourceMap();
    const { p } = partner({ sourceMap, config: { maxSessionsPerTenant: 2 } });
    const victim = { tenantId: "victim", userId: "u", sessionId: "v1" };
    await p.observe(
      { ...victim, at: clock++, kind: "user_message", text: "Globex renewal for Dana Lee" },
      { waitMs: 1_000 },
    );
    for (const sessionId of ["a1", "a2", "a3"]) {
      await p.observe({ tenantId: "attacker", userId: "u", sessionId, at: clock++, kind: "user_message", text: "hi" });
    }
    expect(p.sessionCount).toBe(3); // victim's v1 plus attacker's newest two
    expect(sourceMap.utility(victim, "general", "crm")).toBe(0.5);
  });

  test("an idle session is dropped when the next session starts", async () => {
    let now = 0;
    const { p } = partner({ now: () => now, config: { sessionIdleMs: 1_000 } });
    await p.observe({ ...scope, at: 0, kind: "user_message", text: "hello there friend" });
    now = 5_000;
    await p.observe({ ...scope, sessionId: "s-new", at: now, kind: "user_message", text: "hello again friend" });
    expect(p.sessionCount).toBe(1);
  });
});

describe("ask", () => {
  test("answers from sources without a model, citing items", async () => {
    const { p } = partner();
    const res = await p.ask({ ...scope, question: "When is the call with Dana Lee?" });
    expect(res.usedModel).toBe(false);
    expect(res.citations.map((c) => c.itemId)).toContain("calendar:evt-1");
  });

  test("with askWithModel, uses the model to answer when one is configured", async () => {
    const model = new FakeModel(() => "Thursday 3pm [0]");
    const { p } = partner({ model, config: { askWithModel: true } });
    const res = await p.ask({ ...scope, question: "When is the call with Dana Lee?" });
    expect(res.usedModel).toBe(true);
    expect(res.answer).toContain("Thursday 3pm [0]");
    expect(res.answer).toStartWith("<context"); // Model text derived from sources is wrapped as data, too.
  });

  test("a model answer cut off at its cap is not shown: the cited items stand (D45)", async () => {
    const model = new FakeModel(() => ({ text: "The call with Dana is at", truncated: true }));
    const { p } = partner({ model, config: { askWithModel: true } });
    const res = await p.ask({ ...scope, question: "When is the call with Dana Lee?" });
    expect(res.answer).not.toContain("The call with Dana is at");
    expect(res.citations.map((c) => c.itemId)).toContain("calendar:evt-1");
    expect(res.answer).toContain("Call with Dana Lee: Thursday 3pm");
    expect(model.calls[0]).toMatchObject({ maxTokens: 1_000, reasoning: "low" });
  });

  test("by default answers with the cited items and no model call, even with a model configured (D43)", async () => {
    const model = new FakeModel(() => "Thursday 3pm [0]");
    const { p } = partner({ model });
    const res = await p.ask({ ...scope, question: "When is the call with Dana Lee?" });
    expect(res.usedModel).toBe(false);
    expect(model.calls.length).toBe(0);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.answer).toStartWith("<context");
  });
});

describe("query planner wiring", () => {
  /** A connector that matches the whole query as one substring, and records what it was sent. */
  function substringCrm() {
    const sent: string[] = [];
    const inner = crm;
    const source: Source = {
      id: "crm",
      kind: "test",
      description: "Deals and accounts",
      async search(q) {
        sent.push(q.text);
        const all = await inner.search({ ...q, text: "globex renewal dana lee bill initech" });
        return all.filter((i) => `${i.title} ${i.text}`.toLowerCase().includes(q.text.toLowerCase()));
      },
    };
    return { source, sent };
  }
  // Each question differs: the fan-out caches a lookup's result by its cue for a minute, so a repeat never reaches
  // the planner. Numbered from 101: one-character terms are dropped from cues, so "item 1" and "item 2" would repeat.
  let n = 0;
  const ask = (p: ContextPartner) =>
    p.observe(
      ev({
        kind: "user_message",
        sessionId: `s-${clock}`,
        text: `Globex renewal status for Dana Lee, item ${100 + ++n}?`,
      }),
      { waitMs: 1_000 },
    );

  test("serving and shadow lookups start no call their source timeout would cut off", async () => {
    // A slow substring connector: the cue's terms find nothing, so the planner would cascade, but after one 40 ms
    // call only 20 ms of the 60 ms timeout are left: the second call would be cut off, so it is never sent.
    // Calls are counted when they start: one the timeout cuts off never gets to answer.
    const slow = () => {
      const { source } = substringCrm();
      const sent: string[] = [];
      const search = source.search.bind(source);
      source.search = async (q, signal) => (sent.push(q.text), await Bun.sleep(40), search(q, signal));
      return { source, sent };
    };
    const config = { sourceTimeoutMs: 60 };
    const served = slow();
    const planner = new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0 });
    const { p } = partner({ planner, config }, [served.source]);
    await ask(p);
    expect(served.sent).toHaveLength(1);
    const shadowed = slow();
    const records: ShadowRecord[] = [];
    const shadow = new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0, mode: "shadow" });
    const { p: q } = partner({ planner: shadow, config, onShadow: (r) => records.push(r) }, [shadowed.source]);
    await ask(q);
    for (let i = 0; i < 20 && records.length === 0; i++) await Bun.sleep(10);
    expect(records.map((r) => r.calls)).toEqual([1]);
    // Served once without a planner, shadowed once: two calls, no third.
    expect(shadowed.sent).toHaveLength(2);
  });

  test("without a planner, the connector gets the cue's terms only (off by default)", async () => {
    const { source, sent } = substringCrm();
    const { p } = partner({}, [source]);
    await ask(p);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("globex");
    expect(sent[0]).toContain("renewal");
  });

  test("with a planner, entity calls are sent and traces carry shapes and counts, not the query", async () => {
    const { source, sent } = substringCrm();
    const { p, traces } = partner({ planner: new QueryPlanner({ seed: 1 }) }, [source]);
    for (let i = 0; i < 12; i++) await ask(p);
    expect(sent.some((q) => q === "Globex" || q === "Dana Lee")).toBe(true);
    const plans = traces.flatMap((t) => t.plans ?? []);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0]!.sourceId).toBe("crm");
    expect(JSON.stringify(plans)).not.toMatch(/globex|dana/i);
  });

  test("a delivery credits the planner for each delivered item (D39)", async () => {
    const planner = new QueryPlanner({ seed: 1 });
    const credited: string[] = [];
    const credit = planner.creditDelivery.bind(planner);
    planner.creditDelivery = (sc, sourceId, itemId) => {
      credited.push(`${sc.userId}/${itemId}`);
      credit(sc, sourceId, itemId);
    };
    const { p } = partner({ planner });
    const r = await p.observe(ev({ kind: "user_message", text: "Email Dana Lee about the Globex renewal" }), {
      waitMs: 1_000,
    });
    const delivered = [...(r.injection ? [r.injection] : []), ...p.takePending(scope)].flatMap((i) =>
      i.citations.map((c) => `${scope.userId}/${c.itemId}`),
    );
    expect(delivered.length).toBeGreaterThan(0);
    expect(credited).toEqual(delivered);
  });

  test("credit comes when the agent receives the injection, not when it is built (D18, D39)", async () => {
    const run = async (take: boolean) => {
      const planner = new QueryPlanner({ seed: 1 });
      const credited: string[] = [];
      const credit = planner.creditDelivery.bind(planner);
      planner.creditDelivery = (sc, sourceId, itemId) => {
        credited.push(itemId);
        credit(sc, sourceId, itemId);
      };
      const { p } = partner({ planner });
      const r = await p.observe(ev({ kind: "user_message", text: "Email Dana Lee about the Globex renewal" }));
      expect(r.injection).toBeNull(); // Not waited for: the lookup's result is queued.
      await new Promise((res) => setTimeout(res, 100)); // Static sources answer at once.
      if (take) expect(p.takePending(scope).length).toBeGreaterThan(0);
      else await p.observe(ev({ kind: "session_end" }));
      return credited;
    };
    expect(await run(false)).toEqual([]);
    expect((await run(true)).length).toBeGreaterThan(0);
  });

  test("forget clears what the planner learned for the user", async () => {
    const { source } = substringCrm();
    const planner = new QueryPlanner({ seed: 1 });
    const { p } = partner({ planner }, [source]);
    const prior = new QueryPlanner().means(scope, "crm", true);
    for (let i = 0; i < 12; i++) await ask(p);
    expect(planner.means(scope, "crm", true)).not.toEqual(prior);
    p.forget(scope);
    expect(planner.means(scope, "crm", true)).toEqual(prior);
  });

  test("shadow mode: serving is unchanged, the planner's lookup is reported and learned from, never delivered", async () => {
    const { source, sent } = substringCrm();
    const planner = new QueryPlanner({ seed: 1, mode: "shadow" });
    const records: ShadowRecord[] = [];
    // Seconds between questions, as a real conversation has: the rate limit refills, so shadow has spare tokens.
    let t = 1_700_000_000_000;
    const { p } = partner({ planner, onShadow: (r) => records.push(r), now: () => (t += 1_000) }, [source]);
    const prior = planner.means(scope, "crm", true);
    let delivered = 0;
    for (let i = 0; i < 12; i++) {
      const r = await ask(p);
      delivered += r.injection?.citations.length ?? 0;
      await Bun.sleep(5); // The shadow lookup runs after the served one.
    }
    // Served: the cue's terms, which this substring connector never matches, so nothing is delivered.
    expect(delivered).toBe(0);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.sourceId === "crm" && r.servedItemIds.length === 0)).toBe(true);
    // In shadow, the planner found the deal by entity, learned so, and still delivered none of it.
    expect(records.some((r) => r.itemIds.includes("crm:deal-9"))).toBe(true);
    expect(planner.means(scope, "crm", true)).not.toEqual(prior);
    expect(JSON.stringify(records)).not.toMatch(/globex|dana/i);
    expect(sent.some((q) => q === "Globex" || q === "Dana Lee")).toBe(true);
  });

  test("shadow lookups never read or fill the fan-out's cache of planner calls (D29)", async () => {
    const { source, sent } = substringCrm();
    let t = 1_700_000_000_000;
    const planner = new QueryPlanner({ seed: 1, mode: "shadow" });
    const { p } = partner({ planner, now: () => (t += 1_000) }, [source]);
    for (let i = 0; i < 12; i++) {
      await ask(p);
      await Bun.sleep(5);
    }
    // Twelve questions within a minute name the same person: a shadow lookup sends the entity query every time,
    // where a cached answer would have spared all but the first.
    expect(sent.filter((q) => q === "Dana Lee").length).toBeGreaterThan(2);
  });

  /** A connector that answers any query with one item echoing it, so every served lookup can deliver something. */
  function echo(id = "notes", ref = (q: string) => `n-${q.length}-${q.split(" ")[0]}`) {
    let calls = 0;
    const source: Source = {
      id,
      kind: "test",
      description: "Notes",
      async search(q) {
        calls++;
        return [
          {
            id: `${id}:${ref(q.text)}`,
            sourceId: id,
            ref: ref(q.text),
            title: `Globex ${q.text}`,
            text: `Dana Lee ${q.text} Globex renewal`,
          },
        ];
      },
    };
    return { source, calls: () => calls };
  }

  test("shadow never costs serving its rate budget: every lookup of a burst is still sent", async () => {
    // A connector that never answers, so every question is a live lookup (nothing is ever cached). Served calls carry
    // the cue's entities; the planner always clears them, so its calls are told apart.
    const run = async (planner?: QueryPlanner) => {
      let served = 0;
      let shadow = 0;
      const silent: Source = {
        id: "crm",
        kind: "test",
        description: "",
        async search(q) {
          if (q.entities.length > 0) served++;
          else shadow++;
          return [];
        },
      };
      const { p } = partner({ planner, now: () => 1_700_000_000_000 }, [silent]);
      for (let i = 0; i < 12; i++) await ask(p);
      await Bun.sleep(20);
      return { served, shadow };
    };
    const off = await run();
    const shadowed = await run(new QueryPlanner({ seed: 1, mode: "shadow" }));
    // The burst is 10: both serve exactly 10 lookups, the rest are limited for both.
    expect(off.served).toBe(10);
    expect(shadowed.served).toBe(off.served);
    // Shadow had its own, smaller budget: it ran, within half the burst.
    expect(shadowed.shadow).toBeGreaterThan(0);
    expect(shadowed.shadow).toBeLessThanOrEqual(5);
  });

  test("shadow records carry sanitized ids: a secret in an item's ref never reaches them", async () => {
    const token = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
    const { source } = echo("crm", () => `deal-${token}`);
    const records: ShadowRecord[] = [];
    const { p } = partner(
      { planner: new QueryPlanner({ seed: 1, mode: "shadow" }), onShadow: (r) => records.push(r) },
      [source],
    );
    await ask(p);
    await Bun.sleep(20);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(token);
    // The shadow's id for the item is the id serving gave it.
    expect(records[0]!.itemIds[0]).toBe(records[0]!.servedItemIds[0]);
  });

  test("a shadow lookup's errors never touch serving, and forget mid-shadow leaves no learning", async () => {
    let shadowPhase = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const flaky: Source = {
      id: "crm",
      kind: "test",
      description: "",
      async search(q) {
        if (!shadowPhase)
          return [{ id: "crm:1", sourceId: "crm", ref: "1", title: "Globex renewal", text: `Dana Lee ${q.text}` }];
        await gate;
        throw new Error("500 Internal Server Error");
      },
    };
    const planner = new QueryPlanner({ seed: 1, mode: "shadow" });
    const prior = planner.means(scope, "crm", true);
    const { p } = partner({ planner }, [flaky]);
    const original = flaky.search.bind(flaky);
    // Serving answers; the shadow lookup that follows waits on the gate, then fails.
    flaky.search = async (q, sig) => {
      const r = original(q, sig);
      shadowPhase = true;
      return r;
    };
    const r = await ask(p);
    expect(r.injection?.citations.map((c) => c.itemId)).toContain("crm:1");
    p.forget(scope);
    release();
    await Bun.sleep(20);
    expect(planner.means(scope, "crm", true)).toEqual(prior);
  });
});

describe("what the agent has or does not need is not delivered", () => {
  const review = new StaticSource("calendar", "calendar", [
    { ref: "rev", title: "Design review with Hana", text: "Monday 11:00, room Orion, bring the mobile mocks" },
  ]);
  const delivered = async (p: ContextPartner, e: Record<string, unknown>) => {
    const r = await p.observe(ev(e), { waitMs: 1_000 });
    return [...(r.injection ? [r.injection] : []), ...p.takePending(scope)].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
  };

  test("an item the agent fetched with its own tool is not delivered again when the user asks about it", async () => {
    const { p } = partner({}, [review]);
    const output = "Design review with Hana, Monday 11:00, room Orion, bring the mobile mocks";
    await delivered(p, { kind: "tool_call", tool: "calendar.get", input: { q: "design review" } });
    expect(await delivered(p, { kind: "tool_result", tool: "calendar.get", output })).toEqual([]);
    expect(
      await delivered(p, { kind: "user_message", text: "What should I bring to the design review with Hana?" }),
    ).toEqual([]);
  });

  test("the user naming an item is no sign the agent has it: the item is still delivered", async () => {
    const { p } = partner({}, [review]);
    // The question holds most of the item's title words, but none of its content.
    expect(await delivered(p, { kind: "user_message", text: "When is the design review with Hana?" })).toContain(
      "calendar:rev",
    );
  });

  test("an update to what the agent fetched is still delivered: a stale copy is no reason to hold it back", async () => {
    const moved = new StaticSource("calendar", "calendar", [
      { ref: "rev", title: "Design review with Hana", text: "Monday 11:30, room Vega, bring the mobile mocks" },
    ]);
    const { p } = partner({}, [moved]);
    const stale = "Design review with Hana, Monday 11:00, room Orion, bring the mobile mocks";
    const got = [
      ...(await delivered(p, { kind: "tool_result", tool: "calendar.get", output: stale })),
      ...(await delivered(p, { kind: "user_message", text: "What should I bring to the design review with Hana?" })),
    ];
    expect(got).toContain("calendar:rev");
  });

  test("a moved time is still delivered when the agent's listing holds its words elsewhere", async () => {
    const moved = new StaticSource("calendar", "calendar", [
      { ref: "rev", title: "Design review with Hana", text: "Monday 11:30, room Orion, bring the mobile mocks" },
    ]);
    const { p } = partner({}, [moved]);
    // Every term of the moved item is in this listing ("30" from the standup), but not "11 30" side by side.
    const output =
      "Monday: standup 9:30; Design review with Hana 11:00, room Orion, bring the mobile mocks; lunch 12:00";
    const got = [
      ...(await delivered(p, { kind: "tool_result", tool: "calendar.list", output })),
      ...(await delivered(p, { kind: "user_message", text: "What should I bring to the design review with Hana?" })),
    ];
    expect(got).toContain("calendar:rev");
  });

  test("a user message holding all of an item's words is no sign the agent has it", async () => {
    const { p } = partner({}, [review]);
    const text = "Design review with Hana, Monday 11:00, room Orion, bring the mobile mocks: is that still right?";
    expect(await delivered(p, { kind: "user_message", text })).toContain("calendar:rev");
  });

  test("what one session's agent fetched does not hold the item back in another session", async () => {
    const { p } = partner({}, [review]);
    const output = "Design review with Hana, Monday 11:00, room Orion, bring the mobile mocks";
    await delivered(p, { kind: "tool_result", tool: "calendar.get", output, sessionId: "a" });
    // The same words in the same order: had the sessions shared what the agent holds, the term ids would match.
    expect(await delivered(p, { kind: "user_message", text: output, sessionId: "b" })).toContain("calendar:rev");
  });

  test.each([
    ["Webinar rehearsal with the Globex CFO", "Thursday 15:00, rehearse the Globex renewal pitch", undefined],
    ["Dana Lee promotion to VP at Globex", "Dana Lee now owns the Globex renewal budget", undefined],
    ["Globex renewal: Digest Pro seats", "Globex renewal adds 40 Digest Pro seats for Dana Lee", undefined],
    ["Globex invoice overdue", "Globex renewal invoice overdue, Dana Lee to approve", "updates"],
  ])("real mail is still delivered: %s", async (title, text, category) => {
    const mail = new StaticSource("mail", "mail", [
      { ref: "m", title, text, ...(category ? { meta: { category } } : {}) },
    ]);
    const { p } = partner({}, [mail]);
    expect(
      await delivered(p, { kind: "user_message", text: `${title}: what do I need to know for the Globex renewal?` }),
    ).toContain("mail:m");
  });

  test("bulk mail is not pushed without a model, by its wording or its mailbox category; an ask still finds it", async () => {
    const mail = new StaticSource("mail", "mail", [
      {
        ref: "nl",
        title: "Globex weekly newsletter",
        text: "Globex renewal news, Dana Lee interview and pricing tips",
      },
      {
        ref: "promo",
        title: "Globex renewal offer for Dana Lee",
        text: "Globex renewal pricing for Dana Lee this month",
        meta: { category: "promotions" },
      },
    ]);
    const { p } = partner({}, [mail]);
    expect(
      await delivered(p, { kind: "user_message", text: "What's new with the Globex renewal and Dana Lee?" }),
    ).toEqual([]);
    const answer = await p.ask({ ...scope, question: "Globex renewal newsletter Dana Lee" });
    expect(answer.citations.map((c) => c.itemId)).toContain("mail:nl");
  });
});

describe("no-model fallback (D36)", () => {
  const notes = new StaticSource("notes", "notes", [
    {
      ref: "qbr",
      title: "Quarterly budget review",
      text: "Marketing budget review outcome: approved with travel cuts",
    },
    { ref: "other", title: "Office plants", text: "Water the office plants on Fridays" },
  ]);
  const ask = "what was the outcome of the quarterly marketing budget review";
  const delivered = async (p: ContextPartner, text: string, sessionId = "fb") => {
    const r = await p.observe(ev({ kind: "user_message", text, sessionId }), { waitMs: 1_000 });
    return [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId })].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
  };

  test("without a model, the best candidate is delivered when it holds three or more query terms", async () => {
    const { p, traces } = partner({}, [notes]);
    expect(await delivered(p, ask)).toEqual(["notes:qbr"]);
    expect(traces.some((t) => t.decision === "sources" && t.reason.startsWith("fallback:"))).toBe(true);
  });

  test("two shared terms are not enough, and fallbackMatchedTerms 0 turns it off", async () => {
    expect(await delivered(partner({}, [notes]).p, "how did the budget review go")).toEqual([]);
    expect(await delivered(partner({ config: { fallbackMatchedTerms: 0 } }, [notes]).p, ask)).toEqual([]);
  });

  test("with a model, the model decides; over budget, the fallback applies", async () => {
    const model = new FakeModel(() => '{"pick": []}');
    expect(await delivered(partner({ model }, [notes]).p, ask)).toEqual([]);
    expect(model.calls.length).toBe(1);
    const broke = new Budget({ callsPerSession: 0, usdPerSession: 1, usdPerUserDay: 1 });
    expect(await delivered(partner({ model, budget: broke }, [notes]).p, ask)).toEqual(["notes:qbr"]);
  });

  test("a failing model is treated as none: the fallback applies (D41)", async () => {
    const broken = {
      id: "broken",
      chat: async () => {
        throw new Error("model 402: spend limit");
      },
    };
    const { p, traces } = partner({ model: broken }, [notes]);
    expect(await delivered(p, ask)).toEqual(["notes:qbr"]);
    // The trace keeps the cause: a broken key must not look like a keyless server.
    expect(traces.some((t) => t.decision === "sources" && t.reason.startsWith("fallback:model-error:"))).toBe(true);
    // Below the fallback's bar a failing model still means silence.
    expect(await delivered(partner({ model: broken }, [notes]).p, "how did the budget review go")).toEqual([]);
  });

  test("a verdict cut off at the token cap is no verdict: the no-model path decides (D45)", async () => {
    // A reasoning model that spent its cap thinking: "{\"pick" and finish_reason "length".
    const cut = new FakeModel(() => ({ text: '{"pick', truncated: true }));
    const { p, traces } = partner({ model: cut }, [notes]);
    expect(await delivered(p, ask)).toEqual(["notes:qbr"]);
    expect(traces.some((t) => t.reason.startsWith("fallback:model-truncated:"))).toBe(true);
    // The judge asks for low effort and leaves room for reasoning.
    expect(cut.calls[0]).toMatchObject({ reasoning: "low", maxTokens: 512 });
    // A complete "none" is still a none.
    const none = new FakeModel(() => ({ text: '{"pick": []}', truncated: false }));
    expect(await delivered(partner({ model: none }, [notes]).p, ask)).toEqual([]);
  });

  test("a model call aborted by session_end delivers nothing, not the fallback (D41)", async () => {
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const hanging = {
      id: "hanging",
      chat: (req: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          started();
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const budget = new Budget();
    const { p, traces } = partner({ model: hanging as never, budget }, [notes]);
    const sessionId = "gone";
    const pending = p.observe(ev({ kind: "user_message", text: ask, sessionId }), { waitMs: 1_000 });
    await inFlight;
    await p.observe(ev({ kind: "session_end", sessionId }));
    expect((await pending).injection).toBeNull();
    await Bun.sleep(10);
    expect(p.takePending({ ...scope, sessionId })).toEqual([]);
    expect(traces.some((t) => t.sessionId === sessionId && t.decision === "sources")).toBe(false);
    expect(budget.size.sessions).toBe(0);
  });

  test("bulk mail is never the fallback's pick", async () => {
    const mail = new StaticSource("mail", "mail", [
      { ref: "nl", title: "Quarterly budget review newsletter", text: "Marketing budget review outcome and tips" },
    ]);
    expect(await delivered(partner({}, [mail]).p, ask)).toEqual([]);
  });
});

describe("no-model fallback limits (D36)", () => {
  const ask = "what was the outcome of the quarterly marketing budget review";
  const qbr = { ref: "qbr", title: "Quarterly budget review", text: "Marketing budget review outcome: approved" };
  const run = async (docs: ConstructorParameters<typeof StaticSource>[2], text: string, extra = {}) => {
    const { p, traces } = partner(extra, [new StaticSource("notes", "notes", docs)]);
    const r = await p.observe(ev({ kind: "user_message", text, sessionId: "lim" }), { waitMs: 1_000 });
    const ids = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId: "lim" })].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
    return { ids, traces };
  };

  test("three or more terms but under fallbackScore: silent", async () => {
    // The cue also names seven terms other notes hold, so the top item covers well under 0.8 of it.
    const fillers = [
      { ref: "f1", title: "Northwind kickoff", text: "Northwind kickoff offsite planning" },
      { ref: "f2", title: "Catering vendor", text: "Catering vendor contract" },
      { ref: "f3", title: "Offsite planning", text: "Offsite catering and vendor contract planning" },
    ];
    const text = `${ask} northwind kickoff offsite catering vendor contract planning`;
    const { ids, traces } = await run([qbr, ...fillers], text);
    expect(ids).toEqual([]);
    expect(traces.some((t) => t.reason === "no model")).toBe(true);
  });

  test("exactly three terms is enough; fallbackMatchedTerms 4 is not met", async () => {
    const three = [{ ref: "br", title: "Budget review", text: "Budget review outcome: approved" }];
    expect((await run(three, "what was the budget review outcome")).ids).toEqual(["notes:br"]);
    expect(
      (await run(three, "what was the budget review outcome", { config: { fallbackMatchedTerms: 4 } })).ids,
    ).toEqual([]);
  });

  test("two qualifying items: only the best one is delivered", async () => {
    const two = [qbr, { ref: "qbr2", title: "Quarterly budget review notes", text: "Marketing budget review outcome" }];
    expect((await run(two, ask)).ids).toHaveLength(1);
  });

  test("only the top candidate: when it fails the gate, a weaker one is not delivered instead", async () => {
    // Both hold all three query terms; the newsletter ranks first (its title holds them too) and is bulk mail.
    const docs = [
      { ref: "nl", title: "Budget review outcome newsletter", text: "Budget review outcome news" },
      { ref: "br", title: "Notes", text: "The budget review outcome was approved" },
    ];
    const { ids, traces } = await run(docs, "what was the budget review outcome");
    expect(ids).toEqual([]);
    expect(traces.some((t) => t.reason === "no model")).toBe(true);
  });

  test("over budget with nothing strong enough: silent, traced as no model budget", async () => {
    const model = new FakeModel(() => '{"pick": [0]}');
    const budget = new Budget({ callsPerSession: 0, usdPerSession: 1, usdPerUserDay: 1 });
    const weak = [{ ref: "w", title: "Budget", text: "Budget notes for marketing" }];
    const { ids, traces } = await run(weak, "how did the budget go", { model, budget });
    expect(ids).toEqual([]);
    expect(traces.some((t) => t.reason === "no model budget")).toBe(true);
    expect(model.calls.length).toBe(0);
  });
});

describe("refreshing stale cached items (D40)", () => {
  const hour = 3_600_000;
  /** A calendar whose search finds the meeting only the first time; its fetch always reads the current copy. */
  function calendarWithMove(fetchable = true) {
    const doc = { title: "Design review with Hana", text: "Monday 11:00, room Orion, bring the mobile mocks" };
    const calls = { search: 0, fetch: 0 };
    const copy = () => ({ id: "calendar:rev", sourceId: "calendar", ref: "rev", ...doc });
    const src: Source = {
      id: "calendar",
      kind: "test",
      description: "calendar",
      search: async () => (++calls.search === 1 ? [copy()] : []),
      ...(fetchable
        ? {
            fetch: async () => {
              calls.fetch++;
              return copy();
            },
          }
        : {}),
    };
    return { src, doc, calls };
  }
  const ask = async (p: ContextPartner, sessionId: string, at: number) => {
    const text = "What should I bring to the design review with Hana?";
    const r = await p.observe({ ...scope, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 1_000 });
    return [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId })].map((i) => i.text).join();
  };

  test("a copy older than refreshAfterMs is re-read through fetch before it is delivered", async () => {
    let clock = 1_700_000_000_000;
    const { src, doc, calls } = calendarWithMove();
    const { p } = partner({ now: () => clock, config: { refreshAfterMs: hour, maxRefreshes: 3 } }, [src]);
    expect(await ask(p, "a", clock)).toContain("11:00");
    doc.text = "Monday 11:30, room Orion, bring the mobile mocks"; // Moved at the source.
    clock += 3 * hour;
    const got = await ask(p, "b", clock);
    expect(got).toContain("11:30");
    expect(got).not.toContain("11:00");
    expect(calls.fetch).toBe(1);
  });

  test("off, within the threshold, or past maxRefreshes: the cached copy, and no fetch", async () => {
    for (const [config, gap] of [
      [{ refreshAfterMs: 0 }, 3 * hour],
      [{ refreshAfterMs: hour, maxRefreshes: 3 }, hour / 2],
      [{ refreshAfterMs: hour, maxRefreshes: 0 }, 3 * hour],
    ] as const) {
      let clock = 1_700_000_000_000;
      const { src, doc, calls } = calendarWithMove();
      const { p } = partner({ now: () => clock, config }, [src]);
      await ask(p, "a", clock);
      doc.text = "Monday 11:30, room Orion, bring the mobile mocks";
      clock += gap;
      expect(await ask(p, "b", clock)).toContain("11:00");
      expect(calls.fetch).toBe(0);
    }
  });

  test("at most maxRefreshes fetches per lookup", async () => {
    let clock = 1_700_000_000_000;
    let searches = 0;
    let fetches = 0;
    const docs = [
      { ref: "rev", title: "Design review with Hana", text: "Monday 11:00, room Orion, bring the mobile mocks" },
      { ref: "rev2", title: "Design review prep with Hana", text: "Monday 10:00, room Orion, mobile mocks draft" },
    ];
    const copy = (d: (typeof docs)[number]) => ({ id: `calendar:${d.ref}`, sourceId: "calendar", ...d });
    const src: Source = {
      id: "calendar",
      kind: "test",
      description: "calendar",
      search: async () => (++searches === 1 ? docs.map(copy) : []),
      fetch: async (ref) => {
        fetches++;
        return copy(docs.find((d) => d.ref === ref)!);
      },
    };
    const { p } = partner({ now: () => clock, config: { refreshAfterMs: hour, maxRefreshes: 1 } }, [src]);
    await ask(p, "a", clock);
    clock += 3 * hour;
    await ask(p, "b", clock);
    expect(fetches).toBe(1);
  });

  test("by default a stale copy is not delivered from the fast path: a live search brings the current one", async () => {
    let clock = 1_700_000_000_000;
    const doc = { title: "Design review with Hana", text: "Monday 11:00, room Orion, bring the mobile mocks" };
    let fetches = 0;
    const src: Source = {
      id: "calendar",
      kind: "test",
      description: "calendar",
      search: async () => [{ id: "calendar:rev", sourceId: "calendar", ref: "rev", ...doc }],
      fetch: async () => {
        fetches++;
        return null;
      },
    };
    const { p, traces } = partner({ now: () => clock }, [src]);
    await ask(p, "a", clock);
    doc.text = "Monday 11:30, room Orion, bring the mobile mocks";
    clock += 3 * 3_600_000; // Past the default refreshAfterMs (2 h).
    expect(await ask(p, "b", clock)).toContain("11:30");
    expect(traces.filter((t) => t.sessionId === "b").map((t) => t.decision)).not.toContain("fast");
    expect(fetches).toBe(0); // maxRefreshes is 0 by default.
  });

  test("a session that closes while a refresh fetch runs stores nothing; fetches count as source calls", async () => {
    let clock = 1_700_000_000_000;
    const { src, doc } = calendarWithMove();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = src.fetch!;
    src.fetch = async (ref, sc, signal) => {
      await gate;
      return fetch(ref, sc, signal);
    };
    const cache = new ItemCache();
    const { p, traces } = partner({ now: () => clock, cache, config: { refreshAfterMs: hour, maxRefreshes: 3 } }, [
      src,
    ]);
    await ask(p, "a", clock);
    doc.text = "Monday 11:30, room Orion, bring the mobile mocks";
    clock += 3 * hour;
    const text = "What should I bring to the design review with Hana?";
    void p.observe({ ...scope, sessionId: "b", at: clock, kind: "user_message", text } as AgentEvent);
    await new Promise((r) => setTimeout(r, 20));
    await p.observe({ ...scope, sessionId: "b", at: clock, kind: "session_end" } as AgentEvent);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get(scope, "calendar:rev", clock)?.text).toContain("11:00"); // Not overwritten after the close.
    let clock2 = clock;
    const { p: q, traces: t2 } = partner({ now: () => clock2, config: { refreshAfterMs: hour, maxRefreshes: 3 } }, [
      calendarWithMove().src,
    ]);
    await ask(q, "a", clock2);
    clock2 += 3 * hour;
    await ask(q, "b", clock2);
    expect(t2.filter((t) => t.sessionId === "b").some((t) => t.sourceCalls >= 2)).toBe(true); // Search and fetch.
    expect(traces.length).toBeGreaterThan(0);
  });

  test("a fast set with one stale item takes the live lookup; redacted and content-hash refs are never fetched", async () => {
    let clock = 1_700_000_000_000;
    const fetched: string[] = [];
    const docs = [
      { ref: "fresh", title: "Design review with Hana", text: "Monday 11:00, room Orion, bring the mobile mocks" },
      { ref: "tok=[REDACTED]", title: "Design review notes with Hana", text: "room Orion, the mobile mocks, Monday" },
      { ref: "eden-h-0123456789abcdef", title: "Design review agenda with Hana", text: "Monday, room Orion, mocks" },
    ];
    let searches = 0;
    const src: Source = {
      id: "calendar",
      kind: "test",
      description: "calendar",
      search: async () => {
        searches++;
        return searches === 1 ? docs.map((d) => ({ id: `calendar:${d.ref}`, sourceId: "calendar", ...d })) : [];
      },
      fetch: async (ref) => {
        fetched.push(ref);
        return null;
      },
    };
    const { p, traces } = partner({ now: () => clock, config: { refreshAfterMs: hour, maxRefreshes: 3 } }, [src]);
    await ask(p, "a", clock);
    clock += 3 * hour;
    await ask(p, "b", clock);
    expect(traces.filter((t) => t.sessionId === "b").map((t) => t.decision)).not.toContain("fast");
    expect(fetched.every((r) => !r.includes("[REDACTED") && !r.startsWith("eden-h-"))).toBe(true);
    // One stale item is enough (`some`): a mix of a fresh and a stale copy is not delivered from the fast path.
    const cache = new ItemCache();
    const t0 = 1_700_000_000_000;
    const { p: q } = partner({ now: () => t0 + 3 * hour, cache, config: { refreshAfterMs: hour } }, [src]);
    cache.put(scope, [{ id: "calendar:old", sourceId: "calendar", ref: "old", title: "a", text: "a" }], t0);
    cache.put(scope, [{ id: "calendar:new", sourceId: "calendar", ref: "new", title: "b", text: "b" }], t0 + 3 * hour);
    const stale = (q as unknown as { stale(s: unknown, x: unknown[]): boolean }).stale.bind(q);
    const of = (id: string) => ({ item: { id } });
    expect(stale({ scope }, [of("calendar:new"), of("calendar:old")])).toBe(true);
    expect(stale({ scope }, [of("calendar:new")])).toBe(false);
  });

  test("a source without fetch still has its cached copy delivered", async () => {
    let clock = 1_700_000_000_000;
    const { src } = calendarWithMove(false);
    const { p } = partner({ now: () => clock, config: { refreshAfterMs: hour } }, [src]);
    await ask(p, "a", clock);
    clock += 3 * hour;
    expect(await ask(p, "b", clock)).toContain("11:00");
  });
});

describe("grounding: people, days and intent without a model (D44)", () => {
  // Thursday 29 October 2026, noon UTC.
  const at = Date.parse("2026-10-29T12:00:00Z");
  const calendar = new StaticSource("calendar", "Calendar", [
    {
      ref: "dana",
      title: "Robin / Dana",
      text: "Thursday 05 November 2026 16:00",
      meta: { people: "dana@danalee.example", start: "2026-11-05T16:00:00Z" },
    },
    {
      ref: "globex",
      title: "Globex <> Robin",
      text: "Thursday 12 November 2026 22:30",
      meta: { people: "sam@globex.example", start: "2026-11-12T22:30:00Z" },
    },
    { ref: "webinar", title: "Founders webinar", text: "Webinar", meta: { start: "2026-11-12T16:00:00Z" } },
    ...[25, 32, 39].map((d) => ({
      ref: `weekly-${d}`,
      title: "Weekly mentoring",
      text: "Weekly mentoring session with the advisers",
      meta: { start: new Date(Date.UTC(2026, 9, d, 17)).toISOString() },
    })),
  ]);
  const mail = new StaticSource("gmail", "Mail", [
    {
      ref: "intro",
      title: "Intro to Priya Raman?",
      text: "Hey Dana, would love to talk to Priya Raman given her work on the Initech rollout",
      meta: { people: "Dana Lee <dana@danalee.example>" },
    },
  ]);
  const run = async (text: string, kind = "user_message", extra: Partial<PartnerDeps> = {}) => {
    const { p, traces } = partner(extra, [calendar, mail]);
    const sessionId = `g${clock++}`;
    const event = { ...scope, sessionId, at, kind, text, ...(kind === "external" ? { source: "gmail" } : {}) };
    const r = await p.observe(event as AgentEvent, { waitMs: 1_000 });
    const ids = [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId })].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
    return { ids, reasons: traces.map((t) => t.reason) };
  };

  test("a meeting with a named person on a named day: that event, not their mail", async () => {
    const { ids, reasons } = await run("Book me a call with Dana Lee next week");
    expect(ids).toEqual(["calendar:dana"]);
    expect(reasons.some((r) => r.startsWith("grounded-person-day:"))).toBe(true);
  });

  test("an arriving email naming a day finds that day's event sharing its name, not the day's others", async () => {
    const { ids } = await run(
      "New email from Sam at Globex Ventures: looking forward to our call on 12 November",
      "external",
    );
    expect(ids).toEqual(["calendar:globex"]);
  });

  test("a question about the calendar lists the day, each occurrence of a recurring event its own item", async () => {
    expect((await run("What's on my calendar this Sunday?")).ids).toEqual(["calendar:weekly-32"]);
  });

  test("a named person is not enough: a request that is not about meeting needs a word of the topic too", async () => {
    expect((await run("Write to Dana Lee")).ids).toEqual([]);
    expect((await run("Chase Dana Lee about the intro to Priya Raman")).ids).toEqual(["gmail:intro"]);
  });

  test("silent when the day named has nothing to do with the request", async () => {
    expect((await run("What's the weather like next Thursday?")).ids).toEqual([]);
  });

  test("with a model, the judge decides: grounding is the no-model path only", async () => {
    const model = new FakeModel(() => '{"pick": []}');
    expect((await run("Book me a call with Dana Lee next week", "user_message", { model })).ids).toEqual([]);
    expect(model.calls.length).toBe(1);
  });

  test("review negatives: a past day, a common title word, a month-like word", async () => {
    const past = new StaticSource("calendar", "Calendar", [
      {
        ref: "lunch",
        title: "Lunch with Dana Lee",
        text: "Friday 23 October 2026 12:30",
        meta: { people: "dana.lee@globex.example", start: "2026-10-23T12:30:00Z" },
      },
      {
        ref: "board",
        title: "Board sync",
        text: "Friday 30 October 2026 10:00",
        meta: { people: "dana.lee@globex.example", start: "2026-10-30T10:00:00Z" },
      },
    ]);
    const { p } = partner({}, [past, calendar]);
    const say = async (text: string) => {
      const sessionId = `n${clock++}`;
      const r = await p.observe({ ...scope, sessionId, at, kind: "user_message", text } as AgentEvent, {
        waitMs: 1_000,
      });
      return [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId })].flatMap((i) =>
        i.citations.map((c) => c.itemId),
      );
    };
    // "Last Friday" is the lunch that happened, never the board sync coming up.
    expect(await say("I met Dana Lee last Friday, write her a thank you note about the lunch")).not.toContain(
      "calendar:board",
    );
    expect(await say("Please send the Weekly Report by Sunday")).toEqual([]);
  });

  test("a first name names an event only for a meeting; a name in lowercase is not the whole day", async () => {
    const week = new StaticSource("calendar", "Calendar", [
      {
        ref: "oneone",
        title: "Robin / Elena 1:1",
        text: "Friday 30 October 2026 10:00",
        meta: { start: "2026-10-30T10:00:00Z" },
      },
      {
        ref: "board",
        title: "Board sync",
        text: "Friday 30 October 2026 15:00",
        meta: { start: "2026-10-30T15:00:00Z" },
      },
    ]);
    const { p } = partner({}, [week]);
    const say = async (text: string) => {
      const sessionId = `f${clock++}`;
      const r = await p.observe({ ...scope, sessionId, at, kind: "user_message", text } as AgentEvent, {
        waitMs: 1_000,
      });
      return [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId })].flatMap((i) =>
        i.citations.map((c) => c.itemId),
      );
    };
    // "The agenda with Elena" asks for something other than the 1:1; "elena" in lowercase is no entity, and still
    // not a question about the whole calendar.
    expect(await say("What's on the agenda with Elena this week?")).toEqual([]);
    expect(await say("what's on the agenda with elena this week?")).toEqual([]);
    // Moving the meeting is about the 1:1 itself.
    expect(await say("Can we push the coffee with Elena this week?")).toEqual(["calendar:oneone"]);
  });

  test("a 'next' that names no event grounds nothing from an arriving message", async () => {
    for (const text of [
      "Invoice from Globex Ventures: your next payment is due",
      "Globex Ventures newsletter: what's next for our product",
    ]) {
      const { ids, reasons } = await run(text, "external");
      expect(ids).not.toContain("calendar:globex");
      expect(reasons.some((r) => r?.startsWith("grounded-"))).toBe(false);
    }
  });

  test("each user's days are at their own offset: the same moment is Thursday for one, Friday for another", async () => {
    const sent: { userId: string; window?: { start: string; offsetMinutes?: number } }[] = [];
    const spy: Source = {
      id: "calendar",
      kind: "test",
      description: "Calendar",
      listsByTime: true,
      search: async (q) => (sent.push({ userId: q.scope.userId, window: q.window }), []),
    };
    const cache = new ItemCache();
    // The engine on the same clock as the events: on the wall clock, the cached events would have expired since.
    const { p } = partner({ cache, now: () => Date.parse("2026-10-30T03:00:00Z") }, [spy]);
    const event = (ref: string, start: string) => ({
      id: `calendar:${ref}`,
      sourceId: "calendar",
      ref,
      title: ref,
      text: ref,
      meta: { start },
    });
    const evening = Date.parse("2026-10-30T03:00:00Z"); // Thursday 20:00 at UTC-7, Friday 04:00 at UTC+1
    cache.put({ tenantId: scope.tenantId, userId: "west" }, [event("w", "2026-11-02T09:00:00-07:00")], evening);
    cache.put({ tenantId: scope.tenantId, userId: "east" }, [event("e", "2026-11-02T09:00:00+01:00")], evening);
    for (const userId of ["west", "east"]) {
      await p.observe(
        {
          ...scope,
          userId,
          sessionId: userId,
          at: evening,
          kind: "user_message",
          text: "What's on my calendar today?",
        } as AgentEvent,
        { waitMs: 1_000 },
      );
    }
    expect(sent.find((q) => q.userId === "west")?.window).toMatchObject({ start: "2026-10-29", offsetMinutes: -420 });
    expect(sent.find((q) => q.userId === "east")?.window).toMatchObject({ start: "2026-10-30", offsetMinutes: 60 });
    // The offset follows the user's events: with theirs forgotten, days are UTC's again.
    cache.forget({ tenantId: scope.tenantId, userId: "west" }, "calendar");
    expect(cache.offsetOf({ tenantId: scope.tenantId, userId: "west" })).toBe(0);
    expect(cache.offsetOf({ tenantId: scope.tenantId, userId: "east" })).toBe(60);
  });

  test("a month-like word is not a time: the request keeps its words and the planner", async () => {
    const sent: { text: string; window?: unknown }[] = [];
    const spy: Source = {
      id: "calendar",
      kind: "test",
      description: "Calendar",
      listsByTime: true,
      search: async (q) => (sent.push({ text: q.text, window: q.window }), []),
    };
    const { p } = partner({}, [spy]);
    await p.observe(
      { ...scope, sessionId: "m1", at, kind: "user_message", text: "Marketing deck for tomorrow?" } as AgentEvent,
      {
        waitMs: 1_000,
      },
    );
    expect(sent.every((q) => q.text !== "" && q.window === undefined)).toBe(true);
    await p.observe(
      { ...scope, sessionId: "m2", at, kind: "user_message", text: "What's on my calendar this Sunday?" } as AgentEvent,
      {
        waitMs: 1_000,
      },
    );
    expect(sent.at(-1)).toEqual({ text: "", window: { start: "2026-11-01", end: "2026-11-02", offsetMinutes: 0 } });
  });

  test("ask grounds too: a question about a day's calendar answers with that day's events", async () => {
    const { p } = partner({}, [calendar, mail]);
    const res = await p.ask({ ...scope, sessionId: "a1", question: "What's on my calendar this Sunday?" });
    expect(res.citations.map((c) => c.itemId)).toEqual(["calendar:weekly-32"]);
  });

  test("a day's events are capped before scoring: a busy day costs the fast path little", () => {
    const cache = new ItemCache();
    const many = Array.from({ length: 500 }, (_, i) => ({
      id: `cal:e${i}`,
      sourceId: "cal",
      ref: `e${i}`,
      title: `Event ${i}`,
      text: "slot",
      meta: { start: new Date(Date.UTC(2026, 10, 2, 8) + i * 60_000).toISOString() },
    }));
    cache.put(scope, many, at);
    expect(cache.timed(scope, new Set(["2026-11-02"]), at)).toHaveLength(30);
  });
});
