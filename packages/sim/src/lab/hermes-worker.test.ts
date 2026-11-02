import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "./hermes-worker";

// A stub worker speaking worker.py's protocol: "crash" exits mid-task, "hang" never answers, anything else answers.
const STUB = `
const rl = require("node:readline").createInterface({ input: process.stdin });
console.log(JSON.stringify({ op: "ready", mcpTools: ["mcp__sources__search_gmail", "mcp__eden__ask_context"] }));
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.task === "crash") process.exit(3);
  if (req.task === "hang") return;
  console.log(JSON.stringify({ task: req.task, answer: "ok " + req.task, apiCalls: 2 }));
});
`;

function stub(): { worker: Worker; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "hermes-worker-"));
  writeFileSync(join(dir, "stub.js"), STUB);
  return { worker: new Worker([process.execPath, join(dir, "stub.js")], {}, join(dir, "log")), dir };
}

describe("a hermes-ab worker", () => {
  test("is ready with its MCP tools, and answers tasks in order", async () => {
    const { worker } = stub();
    expect(await worker.started()).toEqual({
      ok: true,
      mcpTools: ["mcp__sources__search_gmail", "mcp__eden__ask_context"],
    });
    expect(await worker.run({ task: "a" }, 5_000)).toEqual({
      ran: true,
      msg: { task: "a", answer: "ok a", apiCalls: 2 },
    });
    expect((await worker.run({ task: "b" }, 5_000)).msg.answer).toBe("ok b");
    worker.close();
  });

  test("a crash mid-task fails that task; the next is never sent and says so", async () => {
    const { worker } = stub();
    const crashed = await worker.run({ task: "crash" }, 5_000);
    expect(crashed.ran).toBe(true);
    expect(String(crashed.msg.error)).toMatch(/worker exited/);
    expect(worker.alive).toBe(false);
    const after = await worker.run({ task: "next" }, 5_000);
    expect(after.ran).toBe(false);
    worker.close();
  });

  test("a timeout fails the task and kills the worker, so its late reply cannot reach the next task", async () => {
    const { worker } = stub();
    const hung = await worker.run({ task: "hang" }, 200);
    expect(hung).toEqual({ ran: true, msg: { error: "task timed out after 200 ms" } });
    await Bun.sleep(100);
    expect(worker.alive).toBe(false);
    expect((await worker.run({ task: "x" }, 1_000)).ran).toBe(false);
  });

  test("a worker that cannot start is not ready, and runs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-worker-"));
    const worker = new Worker([join(dir, "no-such-python")], {}, join(dir, "log"));
    const ready = await worker.started();
    expect(ready.ok).toBe(false);
    expect((await worker.run({ task: "a" }, 1_000)).ran).toBe(false);
    worker.close();
  });
});
