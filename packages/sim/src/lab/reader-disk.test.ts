import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskReader, type ReaderInput, type ReaderMaker } from "@eden/engine";
import { Budget, type ChatRequest, type Model } from "@eden/llm";
import { MISS_EXIT, missGate, overBudget, overBudgetLine, ReplayModel, SubsetReplay, systemHash } from "./reader-disk";
import { readerItem, readerMessages } from "@eden/engine";

const request = (n: number): ChatRequest => ({
  messages: [
    { role: "system", content: "read" },
    { role: "user", content: `request ${n}` },
  ],
  maxTokens: 100,
  json: true,
});

describe("ReplayModel misses (--reader replay)", () => {
  test("an empty cache file: every call is a miss, counted, and throws (the ask fails open)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "reader-")), "empty.jsonl");
    writeFileSync(file, "");
    const m = new ReplayModel(file, null, "m");
    for (const n of [1, 2, 3]) await expect(m.chat(request(n))).rejects.toThrow("no cached call");
    expect(m.missed).toBe(3);
    expect(m.replayed).toBe(0);
    expect(m.calls.length).toBe(0);
  });
});

describe("ReplayModel per-call timings (reader-latency-fit.ts)", () => {
  const usage = { inputTokens: 3_900, outputTokens: 190, cachedInputTokens: 1_200 };
  const timed = (ttftMs?: number): Model => ({
    id: "m",
    async chat() {
      const res = { text: '{"bears":[]}', usage, costUsd: 0.0004, model: "m", latencyMs: 1_190 };
      return ttftMs === undefined ? res : { ...res, ttftMs };
    },
  });

  test("a live call's line keeps usage, latency and TTFT (counts and timings), and its replay reports them", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "reader-")), "timed.jsonl");
    const live = new ReplayModel(file, timed(420), "m");
    await live.chat(request(1));
    const line = JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ usage, latencyMs: 1_190, ttftMs: 420 });
    expect(Object.keys(line).sort()).toEqual(["costUsd", "k", "latencyMs", "model", "text", "ttftMs", "usage"]);
    expect(live.calls[0]).toMatchObject({ ttftMs: 420, live: true });
    const again = new ReplayModel(file, null, "m");
    const res = await again.chat(request(1));
    expect(res.ttftMs).toBe(420);
    expect(again.calls[0]).toMatchObject({
      inputTokens: 3_900,
      cachedInputTokens: 1_200,
      outputTokens: 190,
      latencyMs: 1_190,
      ttftMs: 420,
      live: false,
    });
  });

  test("a call that was not streamed has no ttftMs in its line, and null in calls", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "reader-")), "plain.jsonl");
    const m = new ReplayModel(file, timed(), "m");
    await m.chat(request(2));
    expect(readFileSync(file, "utf8")).not.toContain("ttftMs");
    expect(m.calls[0]!.ttftMs).toBeNull();
  });
});

describe("missGate", () => {
  test("no misses: exit 0 and nothing to print", () => {
    expect(missGate(0, false)).toEqual({ code: 0, message: null });
  });
  test("misses fail the run unless --allow-misses, and say how many either way", () => {
    const failed = missGate(3, false);
    expect(failed.code).toBe(MISS_EXIT);
    expect(failed.code).not.toBe(0);
    expect(failed.message).toContain("READER MISSES: 3");
    const allowed = missGate(3, true);
    expect(allowed.code).toBe(0);
    expect(allowed.message).toContain("READER MISSES: 3");
  });
});

describe("overBudget line", () => {
  const input = (n: number): ReaderInput => ({
    request: `pay invoice ${n}`,
    items: [{ id: "mail:m", source: "mail", title: "t", date: "2026-10-26", from: "", text: "x", hash: "h" }],
    today: "2026-10-27",
  });
  const maker: ReaderMaker = {
    async read() {
      return { bears: [], costUsd: 0.0004, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
    },
  };

  test("a reader on the default Budget is refused after 20 calls a session, and the line shows it", async () => {
    const reader = new AskReader({ maker, budget: new Budget(), now: () => 0 });
    const scope = { tenantId: "t", userId: "u" };
    const signal = new AbortController().signal;
    for (let n = 0; n < 25; n++) await reader.verdictFor(scope, "s", input(n), signal);
    expect(reader.stats.calls).toBe(20);
    expect(overBudget({ reader: [reader], cards: [] })).toEqual({ reader: 5, cards: 0 });
    const line = overBudgetLine({ reader: [reader], cards: [] });
    expect(line).toContain("overBudget: reader 5 (1 lanes)");
    expect(line).toContain("REFUSED");
  });

  test("nothing refused: counts only, no warning; components absent are left out", () => {
    const line = overBudgetLine({ reader: [{ stats: { overBudget: 0 } }], cards: [] });
    expect(line).toBe("overBudget: reader 0 (1 lanes)");
    expect(overBudgetLine({ reader: [], cards: [] })).toBe("overBudget: no budgeted reader or cards");
  });
});

describe("SubsetReplay (--reader-subset)", () => {
  const item = (n: number) =>
    readerItem({ id: `m${n}`, sourceId: "mail", ref: `m${n}`, title: `Item ${n}`, text: `Text ${n}.` }, new Set());
  const req = (ns: number[], request = "Pay the Harlow invoice") =>
    ({
      messages: readerMessages({ request, items: ns.map(item), today: "2026-10-27" }),
      maxTokens: 100,
    }) as ChatRequest;
  const user = (r: ChatRequest) => r.messages[1]!.content;
  const write = (lines: object[]) => {
    const file = join(mkdtempSync(join(tmpdir(), "subset-")), "log.jsonl");
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    return file;
  };
  const sys = systemHash(req([0]));
  // A recorded reading of items 0-4 that flagged items 1 and 3.
  const reply = JSON.stringify({
    bears: [
      { i: 1, why: "a", same: true, binds: true, k: "blocks" },
      { i: 3, why: "b", same: true, binds: true, k: "limits" },
    ],
  });
  const log = write([{ task: "t", prompt: user(req([0, 1, 2, 3, 4])), reply, model: "m", sys }]);

  test("a pool inside a recorded one, in its order, takes that reading's verdict, renumbered", () => {
    const s = new SubsetReplay([log], "m", sys);
    const got = JSON.parse(s.answer(user(req([0, 3, 4])))!) as { bears: { i: number; k: string }[] };
    expect(got.bears).toEqual([expect.objectContaining({ i: 1, k: "limits" })]);
    expect(s.answered).toBe(1);
  });

  test("no answer for another order, an item never read, another request or day, model or instructions", () => {
    const s = new SubsetReplay([log], "m", sys);
    expect(s.answer(user(req([3, 1])))).toBeNull();
    expect(s.answer(user(req([0, 5])))).toBeNull();
    expect(s.answer(user(req([0, 1], "Pay the Kestrel invoice")))).toBeNull();
    expect(new SubsetReplay([log], "other", sys).answer(user(req([0, 1])))).toBeNull();
    expect(new SubsetReplay([log], "m", "x").answer(user(req([0, 1])))).toBeNull();
    expect(s.answered).toBe(0);
  });

  test("ReplayModel answers a cache miss from it, counted apart from misses and replays", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "reader-")), "empty.jsonl");
    writeFileSync(file, "");
    const m = new ReplayModel(file, null, "m", { subset: new SubsetReplay([log], "m", sys) });
    const res = await m.chat(req([1, 2]));
    expect(JSON.parse(res.text).bears).toEqual([expect.objectContaining({ i: 0 })]);
    expect(res.costUsd).toBe(0);
    expect([m.subsetReplayed, m.missed, m.replayed]).toEqual([1, 0, 0]);
    await expect(m.chat(req([7]))).rejects.toThrow("no cached call");
    expect(m.missed).toBe(1);
  });
});
