import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicModel } from "@eden/llm";
import { checkRequest, halfOf, seedApiReplay, type DumpRow } from "./check-api-replay";
import { installQueue, uninstallQueue, withRole } from "./queue-transport";

afterEach(() => uninstallQueue());

const row = (request: string): DumpRow => ({
  suite: "train1",
  seed: 41,
  variant: "hidden",
  template: "t",
  planted: "gmail:1",
  key: "k",
  request,
  today: "2026-10-27",
  items: [
    {
      id: "gmail:1",
      source: "gmail",
      title: "Card blocked",
      date: "2026-10-20T09:00",
      from: "",
      text: "Your card is blocked.",
    },
  ],
  yes: ["gmail:1"],
  reply: '{"items":[{"i":1,"on":"card blocked","hits":"the payment","act":true}]}',
});

// D1104: a recorded API reply is served for the check call the shipped wiring makes on the same prompt, at once.
test("a seeded API reply answers the shipped check's call on the same prompt, and only that prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "check-replay-"));
  expect(seedApiReplay([row("pay the invoice on my card"), { ...row("x"), reply: null, yes: null }], dir)).toBe(1);
  installQueue(dir, { pollMs: 10, timeoutS: 1 });
  const model = new AnthropicModel({ apiKey: "x", model: "claude-haiku-5-5", fetch: withRole(fetch, "eden.check") });
  const got = await model.chat(checkRequest(row("pay the invoice on my card")));
  expect(got.text).toBe(row("").reply!);
  expect(readdirSync(join(dir, "pending"))).toEqual([]);
  // Another request text is another prompt: it misses and is queued for a subagent.
  await expect(model.chat(checkRequest(row("pay the invoice by transfer")))).rejects.toThrow(/no answer/);
  expect(readdirSync(join(dir, "pending")).length).toBe(1);
});

test("the tune/test split is fixed and covers both halves", () => {
  const halves = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((r) => halfOf(row(r))));
  expect(halves).toEqual(new Set(["tune", "test"]));
  expect(halfOf(row("a"))).toBe(halfOf(row("a")));
});
