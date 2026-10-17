/**
 * P1.3 review round 1's probe at the hook, kept as a regression test.
 * A note the shadow set trims (`unsaidText`) must not come back as a new bullet when the window already got the whole
 * note: the trimmed text is the same item, already delivered (A4 §4's refractory rule).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryHookResponse } from "./memory-hook";

const SESSION = "s-shadow-review";
let dir = "";
let project = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SUBMIT"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-shadow-review-"));
  project = join(dir, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q"], { cwd: project });
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(Date.parse("2026-10-11T12:00:00Z"));
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_FLAG_DELIVER_SUBMIT;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function hook(fields: Record<string, unknown>): Record<string, unknown> | null {
  return memoryHookResponse({ session_id: SESSION, cwd: project, ...fields });
}

function submit(prompt: string, promptId: string): string {
  const out = hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: promptId });
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
}

describe("D27 with A4 §4: a trimmed note is the note the window already got", () => {
  test("after a lazy load trims a delivered note, its other sentences are not delivered again", () => {
    submit("The database is postgres. The cache is ZebraCache.", "p1");
    const first = submit("what database and cache do we use?", "p2");
    expect(first).toContain("ZebraCache");
    const nested = write(join(project, "apps", "web", "CLAUDE.md"), "The database is postgres.\n");
    hook({
      hook_event_name: "InstructionsLoaded",
      file_path: nested,
      memory_type: "Project",
      load_reason: "nested_traversal",
      prompt_id: "p2",
    });
    const second = submit("what database and cache do we use?", "p3");
    expect(second).not.toContain("ZebraCache");
  });
});
