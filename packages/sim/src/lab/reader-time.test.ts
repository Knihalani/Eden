import { describe, expect, test } from "bun:test";
import { readerMessages, type ReaderInput } from "@eden/engine";
import { parsePrompt, pct, summarize, type TimedCall } from "./reader-time";

const item = (i: number, extra: Partial<ReaderInput["items"][number]> = {}) => ({
  id: `x${i}`,
  source: "gmail",
  title: `Title ${i}: with a colon`,
  date: "2026-10-20T09:00",
  from: i % 2 ? "Northgate <bank@x>" : "",
  text: `Body ${i} a < b, "quoted" — ünïcode`,
  hash: `h${i}`,
  ...extra,
});

describe("reader-time pools", () => {
  test("a logged prompt parses back to an input that rebuilds it byte for byte (cards, question, unicode, <)", () => {
    const input: ReaderInput = {
      request: "Move £5,000 into my ISA",
      question: "Is anything in the way?",
      today: "2026-10-27",
      items: [item(0), item(1, { card: "kind=limit; says=over £1,000 | needs approval" }), item(2)],
    };
    const prompt = readerMessages(input)[1]!.content;
    const parsed = parsePrompt(prompt);
    expect(parsed).not.toBeNull();
    expect(readerMessages(parsed!)[1]!.content).toBe(prompt);
    expect(parsed!.items.length).toBe(3);
    expect(parsed!.question).toBe("Is anything in the way?");
  });

  test("what is not a reader prompt is refused, not guessed", () => {
    expect(parsePrompt("")).toBeNull();
    expect(parsePrompt("<today>x</today>\n<request>y</request>\n<items>\n<item>broken</item>\n</items>")).toBeNull();
  });
});

describe("reader-time summary", () => {
  test("nearest-rank percentiles", () => {
    expect(pct([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(pct([], 0.5)).toBeNaN();
  });

  test("failed calls are counted but left out of timings and the over-wait share", () => {
    const call = (latencyMs: number, error?: string): TimedCall => ({
      arm: "off",
      pool: 0,
      latencyMs,
      ttftMs: latencyMs / 2,
      inputTokens: 3_000,
      cachedInputTokens: 1_000,
      outputTokens: 200,
      costUsd: 0.0003,
      thought: latencyMs > 3_000,
      parsed: !error,
      flagged: [],
      ...(error ? { error } : {}),
    });
    const s = summarize([call(1_000), call(4_000), call(0, "HTTP 400")], 2_500);
    expect(s).toMatchObject({ calls: 3, failed: 1, overWait: 1, thought: 1, p50Ms: 1_000, p90Ms: 4_000 });
    expect(s.totalCostUsd).toBeCloseTo(0.0006, 10);
  });
});
