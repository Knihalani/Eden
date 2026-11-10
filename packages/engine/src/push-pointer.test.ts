import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { POINTER_LEAD } from "./render";

// O3 (D708): `pushPointer`. A candidate of this request that the agent was handed for an earlier request is kept out
// of the packet by the not-twice ledger; the packet's lead names it instead.

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
  item("hold", 'Harlow "venue" hold', "Payments to Harlow are on hold until the venue deposit dispute ends.", 2),
  item("plain", "Harlow invoice", "Harlow invoice for the venue deposit: the PDF is attached.", 3),
  item("menu", "Catering menu", "The catering menu for the Kestrel dinner must be confirmed with Harlow by Friday.", 4),
  item("seats", "Kestrel seating", "Kestrel dinner seating plan: no more than 40 guests in the Harlow room.", 5),
];
const FIRST = "Pay the Harlow venue deposit invoice.";
const SECOND = "Book the Kestrel dinner catering at the Harlow venue.";

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
      pushCandidates: 4,
      ...config,
    },
  });
}
const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
async function packet(p: ContextPartner, text: string, at = ref) {
  await p.observe({ ...at, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return p.takePending(at).find((x) => x.reason.startsWith("candidates:"));
}

describe("pushPointer (O3, D708): earlier-handed candidates are named, not sent again", () => {
  test("off in the default; off, a later packet says nothing of what was handed before", async () => {
    expect(DEFAULT_CONFIG.pushPointer).toBe(false);
    const partner = setup({ pushCandidates: 3 });
    expect((await packet(partner, FIRST))!.citations.length).toBe(3);
    const second = await packet(partner, SECOND);
    expect(second!.citations.map((c) => c.itemId)).toEqual(["mail:menu"]);
    expect(second!.text).not.toContain(POINTER_LEAD);
  });

  test("on: the second request's packet holds only the new item and names the two handed before", async () => {
    const partner = setup({ pushCandidates: 3, pushPointer: true });
    const first = await packet(partner, FIRST);
    expect(first!.text).not.toContain(POINTER_LEAD);
    expect(first!.citations.map((c) => c.itemId).sort()).toEqual(["mail:hold", "mail:plain", "mail:seats"]);
    const second = await packet(partner, SECOND);
    expect(second!.citations.map((c) => c.itemId)).toEqual(["mail:menu"]);
    // Titles and sources only, in the lead; a title's double quotes are made single (it is source text, quoted).
    expect(second!.text).toContain(`${POINTER_LEAD} "Kestrel seating" (mail); "Harlow 'venue' hold" (mail).`);
    expect(second!.text).not.toContain("no more than 40 guests");
    expect(second!.text).not.toContain("on hold until");
  });

  test("a request with no new item still gets the names, in a packet with no item of its own", async () => {
    const partner = setup({ pushCandidates: 3, pushPointer: true });
    await packet(partner, FIRST);
    // The same request again: all three candidates were handed before.
    const again = await packet(partner, FIRST);
    expect(again!.citations).toEqual([]);
    expect(again!.text).toContain(POINTER_LEAD);
    expect(again!.text).toContain('"Harlow invoice" (mail)');
    expect(again!.text).not.toContain("the PDF is attached");
    // Off, the same request again sends nothing.
    const off = setup({ pushCandidates: 3 });
    await packet(off, FIRST);
    expect(await packet(off, FIRST)).toBeUndefined();
  });

  test("isolation: what one user was handed is never named to another", async () => {
    const partner = setup({ pushCandidates: 3, pushPointer: true });
    await packet(partner, FIRST);
    const other = await packet(partner, SECOND, { ...ref, userId: "u2" });
    expect(other!.citations.length).toBe(3);
    expect(other!.text).not.toContain(POINTER_LEAD);
  });

  test("the switch is a push setting", () => {
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, pushPointer: true })).not.toThrow();
  });
});
