import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// F11's trial (D1250, off): an ask answer says what it searched, so an agent need not repeat the search.

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
const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };

function partner(config: Record<string, unknown>, sources: Source[]) {
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
  });
}
const mail: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
const calendar: Source = { id: "calendar", kind: "test", description: "Calendar", search: async () => [] };

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
    partner({ sourceTimeoutMs: 300, ...config }, sources).ask({ ...ref, question: "Harlow venue deposit" });

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
