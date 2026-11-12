import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { PushChecker } from "./push-check";
import { CANDIDATES_LEAD, CHECKED_COVERAGE_LEAD } from "./render";

// F11's trials (D1250, D1251): Eden says what it searched, so an agent need not repeat the search. Both off by default.

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
  item("dated", "Harlow deposit", "The Harlow venue deposit is due on Friday 30 October.", 4),
];
const REQUEST = "Pay the Harlow venue deposit invoice today.";
const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };

/** A check that says yes to every item it is shown (the prompt's `<item n="…">` numbers). */
const yesToAll = () =>
  new FakeModel((req: ChatRequest) => {
    const user = req.messages.at(-1)!.content;
    const ns = [...user.matchAll(/<item n="(\d+)"/g)].map((m) => Number(m[1]));
    return `{"items":[${ns.map((n) => `{"i":${n},"on":"x","hits":"the Harlow deposit","act":true}`).join(",")}]}`;
  });

function partner(config: Record<string, unknown>, sources: Source[], checked = true) {
  return new ContextPartner({
    sources: async () => sources,
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
      ...config,
    },
    ...(checked ? { checker: new PushChecker({ model: yesToAll(), budget: new Budget() }) } : {}),
  });
}
const mail: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
const calendar: Source = { id: "calendar", kind: "test", description: "Calendar", search: async () => [] };

async function packet(p: ContextPartner): Promise<string> {
  await p.observe({ ...ref, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 2_000 });
  return p.takePending(ref).find((x) => x.reason.startsWith("candidates:"))?.text ?? "";
}

describe("pushCheckCoverage (D1251): a checked packet says it was searched and checked", () => {
  test("off in the default; a valid setting with the check on", () => {
    expect(DEFAULT_CONFIG.pushCheckCoverage).toBe(false);
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, pushCheckCoverage: true })).not.toThrow();
  });

  test("off: the candidates' lead; on, with the check called: the checked lead", async () => {
    const off = await packet(partner({ pushCheck: true }, [mail]));
    expect(off).toContain(CANDIDATES_LEAD);
    const on = await packet(partner({ pushCheck: true, pushCheckCoverage: true }, [mail]));
    expect(on).toContain(CHECKED_COVERAGE_LEAD);
    expect(on).not.toContain(CANDIDATES_LEAD);
    // The look-alike guard stays (D237).
    expect(CHECKED_COVERAGE_LEAD).toContain("same person, thing and date");
  });

  test("on, but no checker wired (no model key): the unchecked lead stays, never a claim of a check", async () => {
    const text = await packet(partner({ pushCheck: true, pushCheckCoverage: true }, [mail], false));
    expect(text).toContain(CANDIDATES_LEAD);
    expect(text).not.toContain(CHECKED_COVERAGE_LEAD);
  });
});

describe("askCoverage (D1250): an ask answer names the sources it searched when all answered", () => {
  const failing: Source = {
    id: "crm",
    kind: "test",
    description: "CRM",
    search: async () => {
      throw new Error("503 upstream down");
    },
  };
  const ask = (config: Record<string, unknown>, sources: Source[]) =>
    partner({ sourceTimeoutMs: 300, ...config }, sources, false).ask({ ...ref, question: "Harlow venue deposit" });

  test("off: no coverage line", async () => {
    expect(DEFAULT_CONFIG.askCoverage).toBe(false);
    const r = await ask({}, [mail, calendar]);
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.answer).not.toContain("every one answered");
  });

  test("on: every source answered, so the line names them all", async () => {
    const r = await ask({ askCoverage: true }, [mail, calendar]);
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.answer).toContain("Eden: searched ");
    expect(r.answer).toContain("mail");
    expect(r.answer).toContain("calendar");
    expect(r.answer).toContain("every one answered");
  });

  test("on, a source failed: no coverage line, the failure is named (D127)", async () => {
    const r = await ask({ askCoverage: true }, [mail, failing]);
    expect(r.answer).not.toContain("every one answered");
    expect(r.answer).toContain("crm");
  });
});
