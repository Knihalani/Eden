import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { pushStart } from "./probes";
import { gateFeatures, loadTurnGate, turnGate } from "./turn-gate";

// M13 (D1010, D1011; docs/research/m13-gate.md): the turn gate decides whether a user turn starts the push.

describe("gate features (the Python twin is packages/sim/lab/m13/feats.py)", () => {
  // Counts, sums and first ids of feats.featurise(text) (16 bits), computed in Python: any drift in the
  // normalisation, the word split or the hashing between the two shows here.
  const cases: [string, number, number, number[]][] = [
    ["Book the Golf in for its MOT at Kwik Lane Garage, Saturday morning.", 322, 11220555, [539, 694, 764]],
    ["कृपया कल सुबह 10 बजे डॉक्टर का अपॉइंटमेंट बुक कर दो", 279, 9722294, [905, 1069, 1493]],
    ["İstanbul'a uçak bileti al lütfen", 209, 6314750, [190, 304, 1219]],
    ["明天下午三点帮我订餐厅 🍣", 121, 3823374, [677, 773, 1171]],
    ["", 5, 198565, [15637, 18697, 48931]],
  ];
  for (const [text, n, sum, head] of cases)
    test(JSON.stringify(text.slice(0, 24)), () => {
      const f = gateFeatures(text, 16);
      expect(f.length).toBe(n);
      expect(f.reduce((a, b) => a + b, 0)).toBe(sum);
      expect(f.slice(0, 3)).toEqual(head);
    });

  test("bounded: a 100,000-character turn is read on its head", () => {
    const t0 = performance.now();
    expect(gateFeatures(`book ${"x".repeat(100_000)}`, 16).length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("the shipped gate", () => {
  const gate = turnGate();
  const rule = (text: string) => {
    const s = pushStart(text, { open: true, indirect: true });
    return { how: s?.how ?? ("none" as const), rest: s !== null && s.request !== text };
  };

  test("loads once a process; a missing or broken file gives null (the rules stay)", () => {
    expect(gate).not.toBeNull();
    expect(turnGate()).toBe(gate);
    expect(loadTurnGate("/nonexistent/turn-gate.bin")).toBeNull();
    expect(loadTurnGate(new URL("./turn-gate.test.ts", import.meta.url))).toBeNull();
  });

  // The hard gates (packages/sim/lab/m13/fixtures.json holds the full list the bar reads).
  test.each([
    "cancel it",
    "book it",
    "Kannst du den Zahnarzttermin auf Freitag verschieben?",
    "Pode confirmar a reserva da sala de degustação de sábado?",
    "The boiler's making that noise again, can you book Ferguson's for Tuesday?",
    "I'll need the Dublin hotel reservation changed to a king room",
    "Should I book the 7am flight to Leeds?",
  ])("starts the push: %s", (text) => {
    expect(gate!.read(text, rule(text)).needs).toBe(true);
  });
  test.each([
    "thanks!",
    "Got it",
    "I need a new bed",
    "Ich brauche ein neues Bett",
    "We should go to Iceland one day, the lights look unreal",
    "Wow, can you believe the price of eggs?",
    "What time is my dentist appointment on Thursday?",
    "connection refused 10.0.4.17:5432 pg pool exhausted, 20 of 20 in use",
  ])("starts nothing: %s", (text) => {
    expect(gate!.read(text, rule(text)).needs).toBe(false);
  });

  test("a kind for every turn", () => {
    expect(gate!.read("Should I cancel the gym?", rule("Should I cancel the gym?")).kind).toBe("qact");
    expect(gate!.read("haha brilliant", rule("haha brilliant")).kind).toBe("chatter");
  });
});

const NOW = Date.parse("2026-10-27T09:00:00Z");
const ITEMS: ContextItem[] = [
  {
    id: "mail:hold",
    sourceId: "mail",
    ref: "hold",
    title: "Zahnarzt Termin",
    text: "Zahnarzttermin Freitag: do not book Freitag, the practice is closed on Fridays until March.",
    updatedAt: NOW - 3_600_000,
  },
];

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
      pushIndirect: true,
      ...config,
    },
  });
}
async function packets(p: ContextPartner, text: string, user = "u1") {
  const at = { tenantId: "t", userId: user, sessionId: "s1" };
  await p.observe({ ...at, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return p.takePending(at).filter((x) => x.reason.startsWith("candidates:"));
}

describe("pushGate in the partner (D1010)", () => {
  test("a polite German request the rule misses starts the push with the gate", async () => {
    const text = "Kannst du den Zahnarzttermin auf Freitag verschieben?";
    expect(pushStart(text, { open: true, indirect: true })).toBeNull();
    expect(await packets(setup({}), text)).toHaveLength(0);
    expect(await packets(setup({ pushGate: true }), text)).toHaveLength(1);
  });

  test("a personal intent the rule's open shape starts is silenced by the gate", async () => {
    const text = "Ich brauche ein neues Bett für das Gästezimmer am Freitag";
    expect(pushStart(text, { open: true, indirect: true })).not.toBeNull();
    expect(await packets(setup({ pushGate: true }), text)).toHaveLength(0);
  });
});
