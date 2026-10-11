/**
 * P2.3's pre-registered target 3 (A5 `guard_precision`, `guard_recall`): the fixture table
 * (`src/memory-guard-cases.json`), written before the guard, played through the hooks. The user's words go through
 * the Submit hook, as typed prompts in an earlier session; the call goes to every guard handler (one per class, as
 * `hooks.json` registers them), with `guard.context` and `guard.ask` on.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARDED_CLASSES } from "../../../src/memory-classes";
import table from "../../../src/memory-guard-cases.json";
import { guardHookResponse } from "./memory-guard-hook";
import { memoryHookResponse } from "./memory-hook";

type Expect = "ask" | "context" | "silent";
interface Case {
  id: string;
  said: [string, number][];
  command?: string;
  tool?: string;
  mode: string;
  expect: Expect;
}

const DAY_MS = 86_400_000;
const CALL_AT = Date.parse("2026-10-11T12:00:00Z");
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_POLICY_GUARD"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

type Answer = { got: Expect; outs: Record<string, unknown>[] };

/** Plays one case in a fresh home and repo; returns what the guard answered. */
function play(item: Case, n: number): Answer {
  const dir = mkdtempSync(join(tmpdir(), "eden-guard-case-"));
  dirs.push(dir);
  const project = join(dir, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q"], { cwd: project });
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_POLICY_GUARD;
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "home", "flags.json"), JSON.stringify({ "guard.context": "on", "guard.ask": "on" }));
  item.said.forEach(([prompt, daysAgo], at) => {
    process.env.EDEN_NOW = String(CALL_AT - daysAgo * DAY_MS);
    memoryHookResponse({
      session_id: "s-said",
      cwd: project,
      hook_event_name: "UserPromptSubmit",
      prompt,
      prompt_id: `p${at}`,
    });
  });
  process.env.EDEN_NOW = String(CALL_AT);
  const payload = {
    session_id: "s-call",
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: item.tool ?? "Bash",
    tool_input: item.command ? { command: item.command } : {},
    tool_use_id: `toolu_case_${n}`,
    permission_mode: item.mode,
  };
  const outs = GUARDED_CLASSES.flatMap(([cls]) => {
    const out = guardHookResponse(payload, cls);
    return out ? [out] : [];
  });
  const said = outs.map((out) => out.hookSpecificOutput as Record<string, unknown>);
  const got: Expect = said.some((out) => out.permissionDecision === "ask")
    ? "ask"
    : said.some((out) => out.additionalContext)
      ? "context"
      : "silent";
  return { got, outs };
}

const cases = table.cases as Case[];
const answers = cases.map((item, n) => ({ item, ...play(item, n) }));

describe("the guard fixtures (target 3)", () => {
  test("each case: the answer it was annotated with", () => {
    const wrong = answers.filter(({ item, got }) => got !== item.expect).map(({ item, got }) => `${item.id}: ${got}`);
    expect(wrong).toEqual([]);
  });

  test("recall 1.0, precision ≥ 0.9, one answer per call, never a deny", () => {
    const asked = answers.filter(({ got }) => got === "ask");
    const due = answers.filter(({ item }) => item.expect === "ask");
    const hits = asked.filter(({ item }) => item.expect === "ask").length;
    console.log(
      `guard fixtures: ${cases.length} cases; recall ${hits}/${due.length}; precision ${hits}/${asked.length}`,
    );
    expect(hits / due.length).toBe(1);
    expect(hits / asked.length).toBeGreaterThanOrEqual(0.9);
    expect(answers.filter(({ outs }) => outs.length > 1).map(({ item }) => item.id)).toEqual([]);
    const decisions = answers.flatMap(({ outs }) =>
      outs.map((out) => (out.hookSpecificOutput as Record<string, unknown>).permissionDecision),
    );
    expect(decisions.filter((decision) => decision !== undefined && decision !== "ask")).toEqual([]);
  });
});
