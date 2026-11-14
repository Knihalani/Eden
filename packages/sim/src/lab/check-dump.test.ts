/** `--check-dump` (M7, D932): one row a check call, with the pool as read, the answer, the reply and the task. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMessages, type PushCheckInput } from "@eden/engine";
import { Budget, type Model } from "@eden/llm";
import { checkLogging, DumpingChecker, replyKeeping } from "./check-dump";
import { promptKey } from "./reader-disk";

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

test("--check-log: with a rule sheet, the logged prompt holds the sheet, the request and the pool", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "check-log-")), "log.jsonl");
  const failing: Model = { id: "fake", chat: async () => Promise.reject(new Error("replay miss")) };
  const input: PushCheckInput = {
    request: "Book the Ashby room for Thursday's lunch.",
    today: "2026-10-27",
    items: [
      { id: "b", source: "gmail", title: "Ashby room closed", date: "", from: "", text: "Shut Thursday", hash: "b" },
    ],
    sheet: [{ id: "c", kind: "deadline", statement: "Pay the deposit by Friday", title: "Deposit", source: "gmail" }],
  };
  const request = { messages: checkMessages(input), maxTokens: 400 };
  // The sheet is the first user message: the request and the pool are in the last.
  expect(request.messages.filter((m) => m.role === "user")).toHaveLength(2);
  await checkLogging(model, file, { suite: "train1" }).chat(request);
  await expect(checkLogging(failing, file, { suite: "train1" }).chat(request)).rejects.toThrow("replay miss");
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.suite).toBe("train1");
    expect(row.prompt).toContain("Pay the deposit by Friday");
    expect(row.prompt).toContain("<request>Book the Ashby room");
    expect(row.prompt).toContain("Ashby room closed");
    // The sheet first, as the model read it.
    expect(row.prompt.indexOf("Pay the deposit")).toBeLessThan(row.prompt.indexOf("<request>"));
    expect(row.sheetHash).toMatch(/^[0-9a-f]{12}$/);
  }
  expect(rows[0].reply).toBe(REPLY);
  // A replay miss keeps its key, so the prompt can be answered elsewhere and cached under it (F6).
  expect(rows[1].reply).toBeNull();
  expect(rows[1].k).toBe(promptKey("fake", request));
  // Without a sheet the prompt is the one user message, and no sheet hash.
  const plain = { messages: checkMessages({ ...input, sheet: undefined }), maxTokens: 400 };
  await checkLogging(model, file, {}).chat(plain);
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
  expect(last.prompt).toBe(plain.messages.find((m) => m.role === "user")!.content);
  expect(last.sheetHash).toBeUndefined();
});
