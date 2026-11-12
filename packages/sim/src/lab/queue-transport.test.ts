import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AnthropicModel } from "@eden/llm";
import { installQueue, keyOf, messageEvents, outputSpecOf, uninstallQueue, withRole } from "./queue-transport";

const BATCH = join(import.meta.dir, "../../lab/subagent/batch.ts");
const batch = (dir: string, ...args: string[]) => {
  const env: Record<string, string | undefined> = { ...process.env, EDEN_LAB_QUEUE: dir };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync("bun", [BATCH, ...args, "--dir", dir], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

afterEach(() => uninstallQueue());

describe("queue transport (F9)", () => {
  test("a miss is queued, answered through the batcher, and replayed at $0 on the next call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-"));
    installQueue(dir, { pollMs: 10, timeoutS: 20 });
    const model = new AnthropicModel({ apiKey: "x", model: "claude-haiku-5-5", fetch: withRole(fetch, "eden.check") });
    const req = {
      messages: [
        { role: "system" as const, content: "Say whether it clashes." },
        { role: "user" as const, content: "book the lake house" },
      ],
      maxTokens: 50,
      json: true,
    };
    const first = model.chat(req);
    await until(() => readdirSync(join(dir, "pending")).length === 1);
    const out = join(dir, "B.json");
    expect(batch(dir, "take", "--n", "5", "--out", out).taken).toBe(1);
    const [q] = JSON.parse(readFileSync(out, "utf8")) as { id: string; role: string; outputSpec: { kind: string } }[];
    expect(q!.role).toBe("eden.check");
    expect(q!.outputSpec.kind).toBe("json");
    // An answer that is not JSON goes back to pending; a valid one lands in done.
    Bun.write(join(dir, "bad.json"), JSON.stringify([{ id: q!.id, text: "yes it clashes" }]));
    expect(batch(dir, "put", join(dir, "bad.json")).invalid).toBe(1);
    expect(readdirSync(join(dir, "pending"))).toEqual([`${q!.id}.json`]);
    batch(dir, "take", "--n", "5", "--out", out);
    Bun.write(join(dir, "good.json"), JSON.stringify([{ id: q!.id, text: '{"act":[1]}' }]));
    expect(batch(dir, "put", join(dir, "good.json")).done).toBe(1);
    const r = await first;
    expect(r.text).toBe('{"act":[1]}');
    expect(r.costUsd).toBe(0);
    // The same prompt again is a hit: no new pending file.
    expect((await model.chat(req)).text).toBe('{"act":[1]}');
    expect(readdirSync(join(dir, "pending"))).toEqual([]);
    const calls = readFileSync(join(dir, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(calls.map((c) => [c.hit, c.transport])).toEqual([
      [false, "subagent-sim"],
      [true, "subagent-sim"],
    ]);
  });

  test("keys depend on role and prompt, not on cache markers", () => {
    const body = (cache: boolean) => ({
      model: "claude-haiku-5-5",
      system: [{ type: "text", text: "s", ...(cache ? { cache_control: { type: "ephemeral" } } : {}) }],
      messages: [{ role: "user", content: "u" }],
    });
    expect(keyOf("a", body(true))).toBe(keyOf("a", body(false)));
    expect(keyOf("a", body(true))).not.toBe(keyOf("b", body(true)));
  });

  test("tool calls stream as tool_use blocks; a stop sequence cuts the text", () => {
    const tools = messageEvents("m", { toolCalls: [{ name: "search", input: { q: "x" } }] });
    expect(tools.some((e) => (e.content_block as { type?: string })?.type === "tool_use")).toBe(true);
    expect((tools.at(-2)!.delta as { stop_reason: string }).stop_reason).toBe("tool_use");
    const cut = messageEvents("m", { text: "a</r> b" }, ["</r>"]);
    expect(cut.find((e) => e.type === "content_block_delta")!.delta).toEqual({ type: "text_delta", text: "a" });
    expect(outputSpecOf({ tools: [{ name: "search", input_schema: { required: ["q"] } }] }).kind).toBe("tools");
  });
});
