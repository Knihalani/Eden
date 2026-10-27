/**
 * P0.5's review probes, kept as regression tests (round 2): a sealed store (format.json names an unknown major,
 * EXECUTION §9) is neither read nor written by any path that holds the AgentMemory, the wrap's tool-trace observer
 * included.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../../src/index";
import { storeFor } from "../../../src/memory-repo";
import { observeToolTraces } from "../../wrap/src/tool-observe";

let root = "";
const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eden-p05-r2-"));
  process.env.EDEN_MEMORY_DIR = root;
  delete process.env.EDEN_HOME;
  delete process.env.EDEN_MEMORY;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (prev.dir === undefined) delete process.env.EDEN_MEMORY_DIR;
  else process.env.EDEN_MEMORY_DIR = prev.dir;
  if (prev.home !== undefined) process.env.EDEN_HOME = prev.home;
});

function window(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_pytest",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: "pytest tests/auth/session.test.ts -q" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_pytest", content: "collected 1 item\nauth.ts touched\nexit 0" },
  ];
}

describe("EXECUTION §9: a sealed store is not written", () => {
  test("the wrap's tool-trace observer writes nothing into a store of an unknown major", () => {
    const store = storeFor(root);
    mkdirSync(store, { recursive: true });
    const mem = openMemory({ dir: store, perRepo: true });
    writeFileSync(join(store, "format.json"), JSON.stringify({ major: 3 }));
    const before = readdirSync(store).sort();
    observeToolTraces(mem, window());
    mem.close();
    expect(readdirSync(store).sort()).toEqual(before);
  });

  test("control: the same observer writes traces into a readable store", () => {
    const store = storeFor(root);
    mkdirSync(store, { recursive: true });
    const mem = openMemory({ dir: store, perRepo: true });
    observeToolTraces(mem, window());
    mem.close();
    expect(existsSync(join(store, "traces.jsonl"))).toBe(true);
  });
});
