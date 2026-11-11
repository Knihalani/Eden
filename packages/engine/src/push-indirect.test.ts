import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { indirectRest, isOpenRequest, pushStart } from "./probes";

// P2 (D820): `pushIndirect` reads a need, plan, wish or question about acting as its imperative, and the open shape
// refuses pasted log lines and chatter.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - 3_600_000,
});
const ITEMS = [
  item("hold", "Dean invoice", "Do not pay Dean's invoice DN-44 yet: it is on hold until the dispute ends."),
  item("plain", "Dean invoice", "Dean's invoice DN-44 for the kitchen is attached as a PDF."),
];

const start = (raw: string, indirect = true) => pushStart(raw, { open: true, indirect });

describe("indirectRest and pushStart (D820)", () => {
  test("indirect lead-ins become the imperative they wrap", () => {
    for (const [raw, rest] of [
      ["I need to pay Dean's invoice today", "pay Dean's invoice today"],
      ["Should I book the 7am flight to Leeds?", "book the 7am flight to Leeds"],
      ["We should move the offsite to Friday", "move the offsite to Friday"],
      ["I want you to book a table at Rosa's for 8", "book a table at Rosa's for 8"],
      ["ok so we really need to renew the domain this week", "renew the domain this week"],
      ["Is it OK to cancel the Vitalis membership now?", "cancel the Vitalis membership now"],
      ["Would it be fine to reschedule Dr. Patel's cleaning to Monday?", "reschedule Dr. Patel's cleaning to Monday"],
      ["I'd be grateful if you could cancel Tuesday's pottery class", "cancel Tuesday's pottery class"],
      ["Shall we ping the design agency about the banner?", "ping the design agency about the banner"],
      ["We should probably transfer £500 to savings", "transfer £500 to savings"],
    ] as const) {
      expect(indirectRest(raw)).toBe(rest);
      expect(start(raw)?.request).toBe(rest);
      // Without the switch the push never reads the imperative ("I'd …" may still open as itself).
      expect(start(raw, false)?.request).not.toBe(rest);
    }
  });

  test("a listed verb after the lead-in is an acting request; another verb opens the push", () => {
    expect(start("I need to pay Dean's invoice today")?.how).toBe("listed");
    expect(start("Let's cash in £3,000 of my Premium Bonds")?.how).toBe("opened");
  });

  test("a lead-in followed by thinking, waiting or saying starts nothing", () => {
    for (const raw of [
      "I need to think about the kitchen quote a bit longer",
      "Let's see how the week goes before deciding anything",
      "I'd like to know more about how the pension works first",
      "I have to admit the new dashboard is growing on me",
      "Should I be worried about the build failures?",
      "We should",
    ])
      expect(start(raw)).toBeNull();
  });

  test("strict open shape: log lines and chatter start nothing; the default still lets them through", () => {
    for (const raw of [
      "2026-11-10T09:14:02Z ERROR payment-worker: timeout after 30000ms (job 88213)",
      "Traceback (most recent call last): File app.py, line 42, in handler KeyError: 'user_id'",
      "build #4821 failed on main: 3 tests failed in packages/billing after 4m12s",
      "connection refused 10.0.4.17:5432 pg pool exhausted, 20 of 20 in use",
      "panic: runtime error: invalid memory address or nil pointer dereference",
      "ok so anyway the weather is nice today",
      "haha that meeting went on forever didn't it",
      "lmaooo the cat just knocked over my plant again",
    ]) {
      expect(isOpenRequest(raw, true)).toBe(false);
      expect(start(raw)).toBeNull();
    }
    expect(isOpenRequest("ok so anyway the weather is nice today")).toBe(true);
  });

  test("review of D820: times, dates and a greeting before a listed verb are a request's own", () => {
    for (const raw of [
      "Bump Thursday's 09:00 call to 10:30",
      "Shift the 14:00 dentist slot to 16:30 on 12/05",
      "Move the review to 2026-05-14 10:00 with Priya",
    ])
      expect(start(raw)).not.toBeNull();
    expect(start("Morning! Book a table at Rosa's for 8 tonight")?.how).toBe("opened");
    expect(start("Morning! Long weekend coming up finally")).toBeNull();
    for (const raw of ["Is it OK to eat the leftover pasta?", "We should stay home tonight and rest"])
      expect(start(raw)).toBeNull();
  });

  test("review of D820: the request handed on is the message itself after the lead-in, whole", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `- invoice INV-${1000 + i} for £${100 + i}`).join("\n");
    const raw = `I need to pay these invoices today:\n${lines}`;
    expect(start(raw)?.request).toBe(raw.slice("I need to ".length));
    expect(start(raw)!.request.length).toBeGreaterThan(1_000);
  });

  test("imperatives and other languages are unchanged", () => {
    for (const raw of [
      "Book the Golf in for its MOT at Kwik Lane Garage, Saturday morning.",
      "Cash in £3,000 of my Premium Bonds to pay for a new boiler.",
      "Je dois payer le loyer de 950 euros à M. Bernard avant le 5 du mois.",
      "Überweise 50 Euro an Maya heute",
    ])
      expect(start(raw)).toEqual(start(raw, false));
  });

  test("bounded: a long message is read only at its head", () => {
    const raw = `I need to pay ${"x".repeat(100_000)}`;
    const t0 = performance.now();
    expect(indirectRest(raw)).not.toBeNull();
    expect(isOpenRequest(`${"a1:".repeat(50_000)}`, true)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

function setup(config: Record<string, unknown>) {
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
      pushOpen: true,
      ...config,
    },
  });
}
async function packets(p: ContextPartner, text: string, user = "u1") {
  const at = { tenantId: "t", userId: user, sessionId: "s1" };
  await p.observe({ ...at, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return p.takePending(at).filter((x) => x.reason.startsWith("candidates:"));
}

describe("pushIndirect in the partner (D820)", () => {
  test("an indirect request starts the candidates' push only with the switch", async () => {
    const text = "I need to pay Dean's invoice DN-44 today";
    expect(await packets(setup({}), text)).toHaveLength(0);
    const on = await packets(setup({ pushIndirect: true }), text);
    expect(on).toHaveLength(1);
    expect(on[0]!.text).toContain("on hold");
  });

  test("a pasted log line that names the same things starts no push with the switch", async () => {
    const log = "ERROR billing: Dean invoice DN-44 pay failed 2026-10-27T08:59:00Z";
    expect(await packets(setup({ pushIndirect: true }), log)).toHaveLength(0);
  });
});

describe("pushIndirect and plan alerts (review of D820)", () => {
  test("an indirect start is not kept as an acting request; a listed one still is", async () => {
    const acted = (p: ContextPartner) =>
      (p as unknown as { sessions: Map<string, { acted?: unknown[] }> }).sessions.values().next().value?.acted
        ?.length ?? 0;
    const indirect = setup({ pushIndirect: true, planConflict: true });
    await packets(indirect, "I need to pay Dean's invoice DN-44 today");
    expect(acted(indirect)).toBe(0);
    const listed = setup({ pushIndirect: true, planConflict: true });
    await packets(listed, "Pay Dean's invoice DN-44 today");
    expect(acted(listed)).toBe(1);
  });
});

describe("pushIndirect v4 (P2): second clauses, hedges, passive needs, someday ideas", () => {
  test("a request after a first clause of context starts the push from where it begins", () => {
    const raw = "The boiler's making that noise again, can you book Ferguson's for Tuesday?";
    expect(start(raw)?.request).toBe("can you book Ferguson's for Tuesday?");
    expect(start("Mum's prescription runs out Sunday so please reorder it at Boots")).not.toBeNull();
    expect(start(raw, false)).toBeNull();
  });

  test("hedges and passive needs start it", () => {
    for (const raw of [
      "Might be worth chasing the Hendricks invoice before Friday",
      "Would be handy if you could cancel the Peloton before the 15th",
      "I'll need the Dublin hotel reservation changed to a king room",
      "It's probably time we moved the Redis cluster off t3.medium",
      "Should probably get the MOT booked at Kwik Fit Bolton",
    ])
      expect(start(raw)).not.toBeNull();
  });

  test("resolutions and someday ideas start nothing; a dated plan still does", () => {
    for (const raw of [
      "I need to stop eating biscuits at 11pm",
      "We should go to Iceland one day, the lights look unreal",
      "I want to get fitter by spring",
    ])
      expect(start(raw)).toBeNull();
    expect(start("Let's set up a postmortem with Łukasz sometime this week")).not.toBeNull();
  });
});

describe("pushIndirect v4, review: what a second clause or a participle must not start", () => {
  test("a second clause that asks for nothing, or holds an action back, starts nothing", () => {
    for (const raw of [
      "Wow, can you believe the price of eggs?",
      "The meeting went well, can you believe it?",
      "Ha, could you imagine Dave running a marathon?",
      "Long day, will you be home for dinner?",
      "Thanks so much, please ignore my last message",
      "Sorry, please disregard, wrong chat",
      "No worries, please don't book anything yet",
      "Not sure yet, can you hold off on booking anything until I confirm?",
      "Great news, I need to tell you something",
      "Honestly, should I even bother?",
    ])
      expect(start(raw)).toBeNull();
  });

  test("a noun ending like a participle is not a job done", () => {
    for (const raw of [
      "I need a new bed",
      "We need the big oven",
      "We need a bigger kitchen",
      "We'd like a quiet weekend in Sweden",
      "I could really do with a hot bath and an early bed",
    ])
      expect(start(raw)).toBeNull();
    expect(start("I'll need the Dublin hotel reservation changed to a king room")).not.toBeNull();
  });

  test("dated requests stay requests; a bare year does not make a someday idea a plan", () => {
    for (const raw of [
      "I need to read the contract and sign it by Friday",
      "I need to stop paying for Netflix",
      "We should stop using the old Redis cluster on Monday",
    ])
      expect(start(raw)).not.toBeNull();
    expect(start("We should go to Iceland one day, maybe in 2028")).toBeNull();
  });
});
