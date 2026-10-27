/**
 * P0.6 review round 1's probes, kept as regression tests: a rewound statement said again is stored again, stop-fast
 * keeps no secret, a compaction is not a rewind, and a restatement keeps its row.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeRows, superseded, type MemoryRecord } from "../../../src/index";
import { storeFor } from "../../../src/memory-repo";
import { memoryHookResponse, type HookStage } from "./memory-hook";

const SESSION = "s-probe";
const T0 = Date.parse("2026-09-01T09:00:00.000Z");
let dir = "";
let transcript = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-probe-"));
  transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "");
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(T0 + 3_600_000);
});
const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME, now: process.env.EDEN_NOW };
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_MEMORY_DIR", prev.dir],
    ["EDEN_HOME", prev.home],
    ["EDEN_NOW", prev.now],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
type Line = Record<string, unknown>;
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const typed = (uuid: string, parentUuid: string | null, promptId: string, text: string): Line => ({
  parentUuid,
  promptId,
  type: "user",
  message: { role: "user", content: text },
  uuid,
  timestamp: at(1),
  origin: { kind: "human" },
});
const said = (uuid: string, parentUuid: string, text: string): Line => ({
  parentUuid,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
  uuid,
  timestamp: at(2),
});
const write = (...lines: Line[]) => appendFileSync(transcript, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
const hook = (event: string, fields: Record<string, unknown> = {}, stage?: HookStage) =>
  memoryHookResponse({ hook_event_name: event, session_id: SESSION, transcript_path: transcript, ...fields }, stage);
const rows = (): MemoryRecord[] => storeRows(join(storeFor(join(dir, "memory")), "memories.jsonl"));
const live = (text: string) => rows().filter((r) => r.text.includes(text) && !superseded(r));

test("probe 1: a statement abandoned by a rewind and said again on the new branch, later, is stored again", () => {
  write(typed("u1", null, "p1", "start"), said("a1", "u1", "Ready."));
  hook("UserPromptSubmit", { prompt: "start", prompt_id: "p1" });
  hook("UserPromptSubmit", { prompt: "The test runner is jest.", prompt_id: "p2" });
  write(typed("u2", "a1", "p2", "The test runner is jest."), said("a2", "u2", "Noted."));
  hook("Stop", { last_assistant_message: "Noted.", prompt_id: "p2" });
  // rewind to p2's slot, say something else
  hook("UserPromptSubmit", { prompt: "The cache is redis.", prompt_id: "p3" });
  write(typed("u3", "a1", "p3", "The cache is redis."), said("a3", "u3", "Ok."));
  hook("Stop", { last_assistant_message: "Ok.", prompt_id: "p3" });
  expect(live("The test runner is jest")).toHaveLength(0);
  // a later prompt on the new branch states it again
  hook("UserPromptSubmit", { prompt: "The test runner is jest.", prompt_id: "p4" });
  write(typed("u4", "a3", "p4", "The test runner is jest."));
  hook("Stop", { last_assistant_message: "Ok again.", prompt_id: "p4" });
  expect(live("The test runner is jest")).toHaveLength(1);
});

test("probe 2: stop-fast stores no secret in plain text in the window directory", () => {
  const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  hook("UserPromptSubmit", { prompt: "show me the token", prompt_id: "p1" });
  hook("Stop", { last_assistant_message: `Your token is ${token}` }, "stop-fast");
  const win = join(dir, "memory", "windows", SESSION);
  const all = readdirSync(win)
    .map((f) => readFileSync(join(win, f), "utf8"))
    .join("\n");
  expect(all.includes(token)).toBe(false);
});

test("probe 3: a rewind to the session's first prompt after a compaction keeps the pre-compaction rows", () => {
  write(typed("u1", null, "p1", "start"), said("a1", "u1", "Ready."));
  hook("UserPromptSubmit", { prompt: "The cache is redis.", prompt_id: "p2" });
  write(typed("u2", "a1", "p2", "The cache is redis."), said("a2", "u2", "Ok."));
  hook("Stop", { last_assistant_message: "Ok.", prompt_id: "p2" });
  write(
    { parentUuid: null, logicalParentUuid: "a2", type: "system", subtype: "compact_boundary", uuid: "b1" },
    { parentUuid: "b1", type: "user", isCompactSummary: true, message: { role: "user", content: "S" }, uuid: "s1" },
  );
  hook("UserPromptSubmit", { prompt: "go on", prompt_id: "p3" });
  write(typed("u3", "s1", "p3", "go on"));
  hook("Stop", { last_assistant_message: "Going.", prompt_id: "p3" });
  expect(live("The cache is redis")).toHaveLength(1);
});

test("probe 4: a rewind's restatement without the final period keeps the fact live", () => {
  write(typed("u1", null, "p1", "start"), said("a1", "u1", "Ready."));
  hook("UserPromptSubmit", { prompt: "start", prompt_id: "p1" });
  hook("UserPromptSubmit", { prompt: "The cache is redis.", prompt_id: "p2" });
  write(typed("u2", "a1", "p2", "The cache is redis."), said("a2", "u2", "Noted."));
  hook("Stop", { last_assistant_message: "Noted.", prompt_id: "p2" });
  hook("UserPromptSubmit", { prompt: "The cache is redis", prompt_id: "p3" });
  write(typed("u3", "a1", "p3", "The cache is redis"));
  hook("PostToolBatch", { prompt_id: "p3", tool_calls: [] });
  expect(live("The cache is redis")).toHaveLength(1);
});

test("probe 5: a rewind's restatement inside a longer sentence of the new prompt keeps the fact live", () => {
  write(typed("u1", null, "p1", "start"), said("a1", "u1", "Ready."));
  hook("UserPromptSubmit", { prompt: "start", prompt_id: "p1" });
  hook("UserPromptSubmit", { prompt: "We deploy with fly.", prompt_id: "p2" });
  write(typed("u2", "a1", "p2", "We deploy with fly."), said("a2", "u2", "Noted."));
  hook("Stop", { last_assistant_message: "Noted.", prompt_id: "p2" });
  const prompt = "Actually, as I said, we deploy with fly. Please check the config.";
  hook("UserPromptSubmit", { prompt, prompt_id: "p3" });
  write(typed("u3", "a1", "p3", prompt));
  hook("PostToolBatch", { prompt_id: "p3", tool_calls: [] });
  expect(rows().filter((r) => /deploy with fly/i.test(r.text) && !superseded(r)).length).toBeGreaterThan(0);
});
