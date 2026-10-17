/**
 * P4.3 at the hook: a human Submit's wide event carries A7 §4's gate trace (τ_repo, the candidates with evidence,
 * their top sum, the rows admitted by class), and a silence prompt (an `ack`, or one no row had evidence for) joins the
 * repo's silence set by its hash, never its text (`memory-tau.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SILENCE_FILE } from "../../../src/memory-tau";
import { promptHash } from "../../../src/memory-turn";
import { memoryHookResponse } from "./memory-hook";

const SESSION = "s-tau";
let dir = "";
const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME, memory: process.env.EDEN_MEMORY };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-tau-"));
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  delete process.env.EDEN_MEMORY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_MEMORY_DIR", prev.dir],
    ["EDEN_HOME", prev.home],
    ["EDEN_MEMORY", prev.memory],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function submit(prompt: string, extra: Record<string, unknown> = {}): string | undefined {
  const out = memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt, ...extra });
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
}

/** Every file under the memory root named `name`, read and joined. */
function filesNamed(name: string, under = join(dir, "memory")): string {
  if (!existsSync(under)) return "";
  return readdirSync(under, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("");
}

function humanSubmits(): Record<string, unknown>[] {
  const root = join(dir, "memory");
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.parentPath.includes("hook.log.d"))
    .flatMap((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.ev === "UserPromptSubmit" && event.submit === "human");
}

describe("A7 §4 at a human Submit", () => {
  test("the wide event carries the gate's trace", () => {
    submit("The billing service runs on port 8080 behind the gateway.", { prompt_id: "p1" });
    expect(submit("which port does the billing service use behind the gateway?", { prompt_id: "p2" })).toContain(
      "8080",
    );
    const gate = humanSubmits().at(-1)!.gate as Record<string, number>;
    expect(gate.ev).toBeGreaterThanOrEqual(1);
    expect(gate.m).toBe(1);
    expect(gate.s).toBe(0);
    expect(gate.top).toBeGreaterThanOrEqual(gate.tau!);
  });

  test("an ack and a prompt no row has evidence for join the silence set by hash; an answered one does not", () => {
    submit("The billing service runs on port 8080 behind the gateway.", { prompt_id: "p1" });
    submit("ok thanks", { prompt_id: "p2" });
    submit("write a haiku about autumn leaves", { prompt_id: "p3" });
    submit("which port does the billing service use behind the gateway?", { prompt_id: "p4" });
    const log = filesNamed(SILENCE_FILE);
    const lines = log
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { k: string; h?: string });
    expect(lines.map((line) => line.k)).toEqual(["empty", "ack", "empty"]);
    expect(lines[2]!.h).toBe(promptHash("write a haiku about autumn leaves"));
    expect(log).not.toContain("haiku");
    expect(humanSubmits().map((event) => event.silence)).toEqual(["empty", "ack", "empty", undefined]);
  });

  test("read-only memory logs nothing", () => {
    process.env.EDEN_MEMORY = "readonly";
    submit("write a haiku about autumn leaves", { prompt_id: "p1" });
    expect(filesNamed(SILENCE_FILE)).toBe("");
  });
});
