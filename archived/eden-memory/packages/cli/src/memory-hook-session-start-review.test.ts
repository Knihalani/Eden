/**
 * P2.5 code review, round 1 (the reviewer's probes): with deliver.submit off a kept proposal is not acknowledged (X7);
 * a rule kept for all projects and declined 3 times is proposed for revocation (A6 §2.5).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeFor } from "../../../src/memory-repo";
import { guardHookResponse } from "./memory-guard-hook";
import { memoryHookResponse } from "./memory-hook";
import { sleepStore } from "./memory-sleep";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const DAY = 86_400_000;
const DECLINED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, " +
  "the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how " +
  "to proceed.";

let dir = "";
let sessions = 0;
let calls = 0;
const ENV_KEYS = [
  "EDEN_MEMORY_DIR",
  "EDEN_HOME",
  "EDEN_MEMORY",
  "EDEN_NOW",
  "EDEN_POLICY_GUARD",
  "EDEN_FLAG_DELIVER_SUBMIT",
] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-p25-probe-"));
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_POLICY_GUARD;
  delete process.env.EDEN_FLAG_DELIVER_SUBMIT;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

function repo(name = "project"): string {
  const path = join(dir, name);
  if (!existsSync(path)) {
    mkdirSync(path);
    execFileSync("git", ["init", "-q"], { cwd: path });
  }
  return path;
}

const advance = (ms: number) => (process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + ms));

function flags(values: Record<string, string>): void {
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "home", "flags.json"), JSON.stringify(values));
}

const contextOf = (out: Record<string, unknown> | null) =>
  (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";

function session(project: string, prompts: string[] = []): { start: string; packets: string[]; id: string } {
  const id = `s-${++sessions}`;
  const hook = (fields: Record<string, unknown>, stage?: "stop-sleep") =>
    memoryHookResponse({ session_id: id, cwd: project, ...fields }, stage);
  const start = contextOf(hook({ hook_event_name: "SessionStart", source: "startup" }));
  const packets = prompts.map((prompt, at) => {
    advance(60_000);
    return contextOf(hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: `${id}-p${at}` }));
  });
  hook({ hook_event_name: "Stop", last_assistant_message: "Done." }, "stop-sleep");
  advance(DAY);
  return { start, packets, id };
}

function pinIn(name: string, rule = "Don't merge PRs yourself."): string {
  const project = repo(name);
  session(project, [rule]);
  session(project, [rule]);
  sleepStore(storeFor(process.env.EDEN_MEMORY_DIR!, project), undefined);
  return project;
}

function declinedMerge(project: string, id: string): void {
  const toolUseId = `toolu_${++calls}`;
  const command = `gh pr merge ${calls}`;
  guardHookResponse({
    session_id: id,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: toolUseId,
    permission_mode: "default",
  });
  memoryHookResponse({
    session_id: id,
    cwd: project,
    hook_event_name: "PostToolBatch",
    tool_calls: [{ tool_name: "Bash", tool_input: { command }, tool_use_id: toolUseId, tool_response: DECLINED }],
  });
  advance(60_000);
}

describe("X7: deliver.submit off answers nothing", () => {
  test("a kept proposal's acknowledgement is not printed with deliver.submit off", () => {
    pinIn("a");
    const b = pinIn("b");
    session(b);
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "off";
    const later = session(b, ["yes, everywhere"]);
    expect(later.packets[0]).toBe("");
  });
});

describe("A6 §2.5: a rule kept for all projects, declined 3 times", () => {
  test("is proposed for revocation at the next SessionStart", () => {
    const a = pinIn("a");
    const b = pinIn("b");
    session(b);
    session(b, ["yes, everywhere"]);
    flags({ "guard.context": "on", "guard.ask": "on" });
    for (let n = 0; n < 3; n++) declinedMerge(a, "s-decl");
    expect(session(a).start).toMatch(/you declined it 3×/);
  });
});
