import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";

// What an open session costs in memory once its agent has fetched large tool results: each tool result and agent
// message keeps what it holds (`Held`, for `alreadyHas`), up to `windowEvents` of them. Held as JS Sets of numbers,
// this test's sessions took 2,096 KB each; as sorted typed arrays, 311 KB (audit 2026-11-03b, scale-session-held-sets).

const WORDS = (() => {
  // A fixed vocabulary of a few hundred made-up words, as a mailbox's would be: mail repeats its words.
  let x = 12_345;
  const rnd = () => (x = (x * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32;
  const letters = "abcdefghijklmnopqrstuvwxyz";
  return Array.from({ length: 400 }, () =>
    Array.from({ length: 3 + Math.floor(rnd() * 7) }, () => letters[Math.floor(rnd() * 26)]).join(""),
  );
})();

/** An 8 KB mail listing: from, subject, date and body words drawn from the vocabulary, seeded per message. */
function mailListing(seed: number): string {
  let x = seed * 2_654_435_761;
  const rnd = () => (x = (x * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32;
  const word = () => WORDS[Math.floor(rnd() * rnd() * WORDS.length)]!; // Skewed: common words recur.
  const parts: string[] = [];
  let len = 0;
  for (let m = 0; len < 8_192; m++) {
    const body = Array.from({ length: 40 }, word).join(" ");
    const line = `From: ${word()} ${word()} <${word()}@${word()}.com> Subject: ${word()} ${word()} ${word()} `;
    const msg = `${line}Date: 2026-10-${10 + (m % 20)} ${body}\n`;
    parts.push(msg);
    len += msg.length;
  }
  return parts.join("").slice(0, 8_192);
}

function openSessions(p: ContextPartner, n: number, tenantId: string): Promise<unknown> {
  let at = 1_700_000_000_000;
  const all: Promise<unknown>[] = [];
  for (let k = 0; k < n; k++) {
    const scope = { tenantId, userId: `u${k}`, sessionId: "s" };
    for (let i = 0; i < 12; i++) {
      const user = { ...scope, at: at++, kind: "user_message", text: `what did ${WORDS[i * 7 + k]} say about it?` };
      all.push(p.observe(user as AgentEvent));
      const output = mailListing(k * 100 + i);
      all.push(p.observe({ ...scope, at: at++, kind: "tool_result", tool: "gmail.search", output } as AgentEvent));
    }
  }
  return Promise.all(all);
}

const partner = () =>
  new ContextPartner({
    sources: async () => [],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
  });

type Held = { terms: Uint32Array | Set<number>; pairs: Float64Array | Set<number> };
const sessionsOf = (p: ContextPartner) => (p as unknown as { sessions: Map<string, { agentHas: Held[] }> }).sessions;

describe("an open session's held events", () => {
  test("are sorted unique typed arrays, bounded by the window", async () => {
    const p = partner();
    await openSessions(p, 2, "t");
    for (const s of sessionsOf(p).values()) {
      expect(s.agentHas.length).toBe(12);
      for (const held of s.agentHas) {
        expect(held.terms).toBeInstanceOf(Uint32Array);
        expect(held.pairs).toBeInstanceOf(Float64Array);
        for (const xs of [held.terms, held.pairs] as (Uint32Array | Float64Array)[]) {
          for (let i = 1; i < xs.length; i++) expect(xs[i]! > xs[i - 1]!).toBe(true);
        }
        expect((held.terms as Uint32Array).length).toBeLessThanOrEqual(512); // MAX_HELD_TERMS
      }
    }
  });

  test("12 user messages and 12 tool results of 8 KB cost at most 0.45 MB a session", async () => {
    const n = 40;
    Bun.gc(true);
    const before = heapStats().heapSize;
    const p = partner();
    await openSessions(p, n, "mem");
    Bun.gc(true);
    const kb = (heapStats().heapSize - before) / 1024 / n;
    let terms = 0;
    let pairs = 0;
    for (const s of sessionsOf(p).values()) {
      for (const h of s.agentHas) {
        terms += h.terms instanceof Set ? h.terms.size : h.terms.length;
        pairs += h.pairs instanceof Set ? h.pairs.size : h.pairs.length;
      }
    }
    console.log(
      `held.test: ${kb.toFixed(1)} KB/session over ${n} sessions; held ${(terms / n).toFixed(0)} terms, ` +
        `${(pairs / n).toFixed(0)} pairs a session`,
    );
    expect(sessionsOf(p).size).toBe(n);
    expect(kb).toBeLessThanOrEqual(450);
  });
});
