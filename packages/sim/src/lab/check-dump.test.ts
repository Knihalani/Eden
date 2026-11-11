/** `--check-dump` (M7, D932): one row a check call, with the pool as read, the answer, the reply and the task. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, type Model } from "@eden/llm";
import { DumpingChecker, replyKeeping } from "./check-dump";

const REPLY = '{"items":[{"i":2,"on":"Ashby room, Thursday","hits":"the lunch booking","act":true}]}';
const model: Model = {
  id: "fake",
  chat: async () => ({
    text: REPLY,
    model: "fake",
    latencyMs: 1,
    costUsd: 0.0002,
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
  }),
};

test("a check call becomes one row with its items, answer, reply and task", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "check-dump-")), "rows.jsonl");
  const kept = replyKeeping(model);
  const checker = new DumpingChecker(
    { model: kept.model, budget: new Budget() },
    kept.replies,
    file,
    (session) =>
      session.endsWith("#t1")
        ? { suite: "train1", seed: 41, variant: "hidden", template: "room", planted: "b" }
        : undefined,
    (id) => `full text of ${id}`,
  );
  const item = (id: string, title: string) => ({
    id,
    source: "gmail",
    title,
    date: "",
    from: "",
    text: title,
    hash: id,
  });
  const read = await checker.check(
    { tenantId: "t", userId: "u" },
    "t/u#t1",
    {
      request: "Book the Ashby room for Thursday's lunch.",
      today: "2026-10-27",
      items: [item("a", "x"), item("b", "y")],
    },
    new AbortController().signal,
  );
  expect([...read.yes!]).toEqual(["b"]);
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ suite: "train1", template: "room", planted: "b", yes: ["b"], reply: REPLY });
  expect(rows[0].items.map((it: { id: string; full: string }) => [it.id, it.full])).toEqual([
    ["a", "full text of a"],
    ["b", "full text of b"],
  ]);
});
