import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";

/**
 * `askContext` (docs/research/smart-askctx.md): an ask is ranked for its question and for the session's latest user
 * request, fused question first, so an agent's narrow question still finds what the user's request needs.
 */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
});

const source = (items: ContextItem[]): Source => ({
  id: "mail",
  kind: "test",
  description: "Mail",
  search: async (q) => {
    const words = q.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return items.filter((i) => words.some((w) => w.length > 3 && `${i.title} ${i.text}`.toLowerCase().includes(w)));
  },
});

// Shares the request's words ("Hoppers", "table"), none of the agent's narrow question's.
const hoppers = item(
  "h1",
  "Hoppers booking",
  "Hoppers is closed on the 31st for a private event; table bookings resume 1 Nov.",
);
// Shares the narrow question's word ("restaurant") only; the question shares "six" with the request.
const guide = item("g1", "Restaurant guide", "Our favourite restaurant list for the team, updated monthly.");
const REQUEST = "Reserve a table for six at Hoppers on the 31st, around 7:30pm.";
const NARROW = "restaurant for six?";

async function run(config: Record<string, unknown>, question: string, sessions = ["s1"]) {
  const p = new ContextPartner({
    sources: async () => [source([hoppers, guide])],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config,
  });
  const scope = { tenantId: "t", userId: "u1" };
  // The request arrives in the first session; every session then asks.
  const ev = { ...scope, sessionId: sessions[0]!, at: NOW, kind: "user_message", text: REQUEST };
  await p.observe(ev as AgentEvent, { waitMs: 1_000 });
  const out: Record<string, { ids: string[]; answer: string }> = {};
  for (const sessionId of sessions) {
    const a = await p.ask({ ...scope, sessionId, question });
    out[sessionId] = { ids: a.citations.map((c) => c.itemId), answer: a.answer };
  }
  return out;
}

describe("askContext", () => {
  test("a narrow question also finds what the session's request needs; flag off, only the question's", async () => {
    const off = await run({}, NARROW);
    expect(off.s1!.ids).toEqual(["mail:g1"]);
    const on = await run({ askContext: true }, NARROW);
    expect(on.s1!.ids).toContain("mail:h1");
    // The question's own find stays in the answer.
    expect(on.s1!.ids).toContain("mail:g1");
  });

  test("an ask made with the request's own words is answered as without the flag", async () => {
    const off = await run({}, REQUEST);
    const on = await run({ askContext: true }, REQUEST);
    expect(on).toEqual(off);
  });

  test("per session: another session's request never shapes this session's answer", async () => {
    const out = await run({ askContext: true }, NARROW, ["s1", "s2"]);
    expect(out.s1!.ids).toContain("mail:h1");
    expect(out.s2!.ids).toEqual(["mail:g1"]);
  });

  test("a question about something else keeps its own answer; one that finds nothing reads the request", async () => {
    // Shares no word with the request, and finds the guide: answered as without the flag.
    const other = await run({ askContext: true }, "Which restaurant guide?");
    expect(other.s1!.ids).toEqual(["mail:g1"]);
    // Shares no word with the request, and finds nothing of its own: the request's find answers it.
    const empty = await run({ askContext: true }, "Anything I should know?");
    expect(empty.s1!.ids).toEqual(["mail:h1"]);
  });

  test("a fused answer holds at most askContextItems items", async () => {
    const out = await run({ askContext: true, askContextItems: 1 }, NARROW);
    expect(out.s1!.ids.length).toBe(1);
  });
});
