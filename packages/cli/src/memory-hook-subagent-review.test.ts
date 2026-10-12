/**
 * P2.5 code review, round 1 (the reviewer's probes): parallel launches never get each other's scope (A5 `subagent`); a
 * task path is read from the session's folder; a fork under a shadow point writes no live ledger (X7).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "./memory-hook";
import { spawnHookResponse } from "./memory-spawn-hook";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const PARENT = "s-main";
let dir = "";
let project = "";
let calls = 0;
const ENV_KEYS = [
  "EDEN_MEMORY_DIR",
  "EDEN_HOME",
  "EDEN_MEMORY",
  "EDEN_NOW",
  "EDEN_FLAG_DELIVER_SUBAGENT",
  "EDEN_FLAG_DELIVER_SUBMIT",
] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-p25-sub-probe-"));
  project = join(dir, "project");
  for (const folder of ["apps/web/app", "packages/cli/src"]) mkdirSync(join(project, folder), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  process.env.EDEN_FLAG_DELIVER_SUBAGENT = "on";
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_FLAG_DELIVER_SUBMIT;
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(transcript(), `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

const transcript = () => join(dir, "projects", `${PARENT}.jsonl`);
const tick = (ms = 1_000) => (process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + ms));
const contextOf = (out: Record<string, unknown> | null) =>
  (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
const base = () => ({ session_id: PARENT, cwd: project, transcript_path: transcript() });

function plant(lines: string[]): void {
  lines.forEach((prompt, at) => {
    memoryHookResponse({
      session_id: "s-facts",
      cwd: project,
      hook_event_name: "UserPromptSubmit",
      prompt,
      prompt_id: `f${at}`,
    });
    tick(60_000);
  });
}
function launch(task: string, type: string, cwd = project): void {
  spawnHookResponse({
    ...base(),
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: `toolu_${++calls}`,
    tool_input: { description: "task", prompt: task, subagent_type: type },
  });
}
function start(agent: string, type: string, cwd = project): string {
  const out = memoryHookResponse({
    ...base(),
    cwd,
    hook_event_name: "SubagentStart",
    agent_id: agent,
    agent_type: type,
  });
  tick();
  return contextOf(out);
}

describe("A5 subagent: parallel launches get their own scopes, or both the parent's", () => {
  test("two launches before either SubagentStart: no subagent gets the other's scope", () => {
    plant(["In apps/web the auth provider is Clerk.", "packages/cli has no auth."]);
    launch("look at apps/web/app/login.ts", "Explore");
    launch("look at packages/cli/src/index.ts", "Explore");
    expect(start("a1", "Explore")).not.toContain("packages/cli has no auth");
    expect(start("a2", "Explore")).not.toContain("Clerk");
  });
});

describe("a task path relative to the session's folder", () => {
  test("a session in apps/web whose task names app/login.ts gets apps/web's rows", () => {
    plant(["In apps/web the auth provider is Clerk."]);
    const web = join(project, "apps/web");
    launch("fix the redirect in app/login.ts", "general-purpose", web);
    expect(start("a1", "general-purpose", web)).toContain("Clerk");
  });
});

describe("X7: a fork under a shadow point", () => {
  test("a fork under deliver.subagent shadow writes no live ledger", () => {
    plant(["packages/cli has no auth."]);
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "on";
    memoryHookResponse({
      ...base(),
      hook_event_name: "UserPromptSubmit",
      prompt: "how does packages/cli authenticate?",
      prompt_id: "p1",
    });
    tick(60_000);
    process.env.EDEN_FLAG_DELIVER_SUBAGENT = "shadow";
    launch("carry on", "fork");
    start("a-fork", "fork");
    expect(existsSync(join(process.env.EDEN_MEMORY_DIR!, "windows", `${PARENT}--a-fork`, "delivery.log"))).toBe(false);
  });
});
