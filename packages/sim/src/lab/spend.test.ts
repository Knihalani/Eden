import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendCapReached, SpendLedger, summarizeLedger, type LedgerLine } from "./spend";

const record = (costUsd: number) => ({
  model: "claude-haiku-5-5",
  usage: { inputTokens: 1000, cachedInputTokens: 800, cacheWriteTokens: 0, outputTokens: 10 },
  costUsd,
  latencyMs: 100,
  ttftMs: 50,
  stopReason: "end_turn",
});

describe("SpendLedger", () => {
  test("refuses a call that would pass the cap, counting other processes' lines", () => {
    const path = join(mkdtempSync(join(tmpdir(), "spend-")), "ledger.jsonl");
    const a = new SpendLedger(path, 1, "a", 0.1);
    const b = new SpendLedger(path, 1, "b", 0.1);
    const ma = a.meter("agent");
    ma.reserve(0.5);
    ma.book(record(0.6));
    const mb = b.meter("grader");
    // b sees a's $0.60 in the file: $0.60 + $0.35 + $0.10 headroom passes $1.
    expect(() => mb.reserve(0.35)).toThrow(SpendCapReached);
    mb.reserve(0.2);
    // In flight in b: another $0.2 would pass the cap.
    expect(() => mb.reserve(0.2)).toThrow(SpendCapReached);
    mb.book(record(0.01));
    expect(b.committedUsd).toBeCloseTo(0.61, 9);
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as LedgerLine);
    const summary = summarizeLedger(lines);
    expect(summary.map((s) => [s.run, s.role, s.calls])).toEqual([
      ["a", "agent", 1],
      ["b", "grader", 1],
    ]);
    expect(summary[0]!.cacheReadShare).toBeCloseTo(0.8, 9);
  });
});
