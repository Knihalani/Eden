import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderInput, type ReaderMaker } from "./reader";

// Repro: an ask drops a queued candidates packet whose every item it CITES, though the answer's 4,000-byte cut left
// the item's line out of the answer text. The agent then never sees the item: not in the answer, not in the packet.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const item = (id: string, title: string, text: string, ageH = 24): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
});

class Reader implements ReaderMaker {
  calls: ReaderInput[] = [];
  async read(input: ReaderInput) {
    this.calls.push(input);
    return { bears: [], costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
  }
}

const HOLD = item(
  "hold",
  "Harlow venue",
  "Payments to Harlow are on hold until the dispute over the venue deposit invoice and catering ends.",
  20,
);
// Many long items the ask's question matches better than HOLD, each in words of its own (compaction keeps them).
const word = (i: number, k: number) => `w${(i * 7919 + k * 104729).toString(36)}`;
const FILLER = Array.from({ length: 11 }, (_, i) =>
  item(
    `f${i}`,
    `Catering menu notes ${i} for the summer party planning thread with the venue team`,
    `Catering menu notes for the venue, course ${i}: ` +
      Array.from({ length: 60 }, (_, k) => word(i, k)).join(" ") +
      ". Catering menu tasting notes.",
    1 + i,
  ),
);

describe("audit A5: ask removes a pending packet whose item it cut", () => {
  test("a queued candidates packet survives an ask whose answer cut its item", async () => {
    const source: Source = {
      id: "mail",
      kind: "test",
      description: "Mail",
      search: async () => [HOLD, ...FILLER],
    };
    const pushed: string[] = [];
    const p = new ContextPartner({
      onTrace: (t) => {
        if (t.decision === "reader-push") pushed.push(...t.itemIds);
      },
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: {
        ...CORE_CONFIG,
        askReader: true,
        askReaderWaitMs: 2_000,
        readerPush: true,
        readerGate: true,
        pushCandidates: 1,
        compactAsk: true,
        askDedup: true,
        confidentScore: 99,
        fallbackMatchedTerms: 99,
        candidateScore: 0,
      },
      reader: new AskReader({ maker: new Reader(), budget: new Budget(), now: () => NOW }),
    });
    const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
    await p.observe(
      {
        ...ref,
        at: NOW,
        kind: "user_message",
        text: "Pay the Harlow invoice for the venue deposit today.",
      } as AgentEvent,
      { waitMs: 2_000 },
    );
    // The push queued a candidates packet with HOLD alone (untaken).
    expect(pushed).toEqual([HOLD.id]);
    // The ask's question names the catering menu notes and the venue: HOLD is cited, after the fillers.
    const answer = await p.ask({ ...ref, question: "catering menu notes for the venue", maxItems: 20 });
    const citedIds = answer.citations.map((c) => c.itemId);
    expect(citedIds).toContain(HOLD.id);
    // Precondition of the bug: the answer's text has no line for HOLD (cut by the 4,000-byte cap).
    expect(answer.answer).not.toContain("[mail] Harlow venue");
    const pending = p.takePending(ref).flatMap((x) => x.citations.map((c) => c.itemId));
    expect(pending).toContain(HOLD.id);
  });
});
