import { expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderInput, type ReaderKind, type ReaderMaker } from "./reader";

// Audit A5 (long-running leak, fixed): an ask waiting on the push's verdict (`reusePush`) when its session closes goes
// on to `reader.read` for the closed session, which reserves on the reader's Budget under the closed session key. The
// partner's `close` already called `reader.endSession`, so that tally is never deleted.

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
const ITEMS = [
  item("n0", "Harlow invoice one", "Harlow invoice for the venue deposit: the PDF is attached, reference HV-1042.", 2),
  item("hold", "Harlow venue", "Payments to Harlow are on hold until the dispute over their numbers ends.", 200),
];
const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A maker that, like a real fetch, rejects once its signal aborts; held until then. */
class SignalReader implements ReaderMaker {
  calls = 0;
  async read(input: ReaderInput, signal: AbortSignal) {
    this.calls++;
    if (signal.aborted) throw new Error("aborted");
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const bears: { i: number; kind: ReaderKind; why: string }[] = [];
    return { bears, rejected: input.items.map((_, k) => k), costUsd: 0.0002 };
  }
}

test("a closed session leaves no tally on the reader's Budget", async () => {
  const maker = new SignalReader();
  const readerBudget = new Budget();
  const reader = new AskReader({ maker, budget: readerBudget, now: () => NOW });
  const p = new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { ...CORE_CONFIG, askReader: true, askReaderWaitMs: 2_000, readerPush: true, readerReuse: true },
    reader,
  });
  const who = { tenantId: "t", userId: "u1", sessionId: "s1" };
  const request = "Pay the Harlow invoice for the venue deposit today.";
  await p.observe({ ...who, at: NOW, kind: "user_message", text: request } as AgentEvent, { waitMs: 0 });
  for (let i = 0; i < 50 && maker.calls < 1; i++) await tick();
  expect(maker.calls).toBe(1); // the push's reading is in flight
  const asking = p.ask({ ...who, question: "Anything about Harlow I should know before paying?", maxItems: 3 });
  for (let i = 0; i < 50; i++) await tick(); // the ask now waits on the push's verdict
  await p.observe({ ...who, at: NOW, kind: "session_end", text: "" } as AgentEvent);
  await asking;
  for (let i = 0; i < 20; i++) await tick();
  expect(p.sessionCount).toBe(0);
  // Was { sessions: 1 } before the fix: a tally for the closed key that nothing ever ends.
  expect(readerBudget.size.sessions).toBe(0);
  // And no second provider call was started for a session already closed.
  expect(maker.calls).toBe(1);
});
