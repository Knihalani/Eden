import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner, StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner, type PartnerDeps } from "./partner";
import type { Trace } from "./trace";

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

  test("uses the model to answer when one is configured", async () => {
    const model = new FakeModel(() => "Thursday 3pm [0]");
    const { p } = partner({ model });
    const res = await p.ask({ ...scope, question: "When is the call with Dana Lee?" });
    expect(res.usedModel).toBe(true);
    expect(res.answer).toContain("Thursday 3pm [0]");
    expect(res.answer).toStartWith("<context"); // Model text derived from sources is wrapped as data, too.
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
  // the planner.
  let n = 0;
  const ask = (p: ContextPartner) =>
    p.observe(
      ev({ kind: "user_message", sessionId: `s-${clock}`, text: `Globex renewal status for Dana Lee, item ${++n}?` }),
      { waitMs: 1_000 },
    );

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
});
