/**
 * P1.2 review round 1's probes at the hook, kept as regression tests: a rule with no class verb that the summary
 * repeats stays habituated, and one whose class verb ends its clause is not held by any mention of its class.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "./memory-hook";

const SESSION = "s-probe";
let dir = "";
const KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SUBMIT"] as const;
const prev = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-p12-hook-probe-"));
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(Date.parse("2026-10-10T12:00:00Z"));
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_FLAG_DELIVER_SUBMIT;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});
const hook = (fields: Record<string, unknown>) => memoryHookResponse({ session_id: SESSION, ...fields });
const submit = (prompt: string, id: string) =>
  (
    hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: id })?.hookSpecificOutput as
      { additionalContext?: string } | undefined
  )?.additionalContext ?? "";
const compact = (summary: string) => {
  hook({ hook_event_name: "SessionStart", source: "compact" });
  hook({ hook_event_name: "PostCompact", trigger: "auto", compact_summary: summary });
};

test("a rule without a class verb, kept word for word by the summary, stays habituated", () => {
  submit("Always run the tests with vitest.", "p1");
  const first = submit("run the tests for the parser", "p2");
  expect(first).toContain("vitest");
  compact("The user said to always run the tests with vitest. The parser was refactored.");
  expect(submit("run the tests for the parser", "p3")).not.toContain("vitest");
});

test("a commit-time rule the summary dropped comes back after a summary that merely mentions a commit", () => {
  submit("Always run the tests before you commit.", "p1");
  expect(submit("commit the parser change", "p2")).toContain("before you commit");
  compact("Claude committed the README typo fix and pushed it to the branch.");
  expect(submit("commit the lexer change", "p3")).toContain("before you commit");
});
