/**
 * P2.3 code review, round 2: the reviewer's probes, kept as regression tests. "That rule is gone" in the real turn
 * order ends the rule asked about in the turn before, never one two turns back; a merge whose subject mentions
 * `--dry-run` is still a merge; an approved ask whose call ran ends its intent, a declined one does not.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardHookResponse } from "./memory-guard-hook";
import { memoryHookResponse } from "./memory-hook";

const NOW = Date.parse("2026-10-11T12:00:00Z");
let dir = "";
let project = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_POLICY_GUARD"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-guard-probe-"));
  project = join(dir, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q"], { cwd: project });
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_POLICY_GUARD;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

function flags(values: Record<string, string> | undefined): void {
  mkdirSync(join(dir, "home"), { recursive: true });
  const path = join(dir, "home", "flags.json");
  if (values) writeFileSync(path, JSON.stringify(values));
  else rmSync(path, { force: true });
}

function tick(): void {
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60_000);
}

function submit(prompt: string, session = "s-now"): void {
  memoryHookResponse({ session_id: session, cwd: project, hook_event_name: "UserPromptSubmit", prompt });
  tick();
}

let calls = 0;
function guard(command: string, mode = "default"): Record<string, string> | null {
  const out = guardHookResponse({
    session_id: "s-now",
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: `toolu_probe_${++calls}`,
    permission_mode: mode,
  });
  tick();
  return (out?.hookSpecificOutput as Record<string, string> | undefined) ?? null;
}

function batch(command: string, response: string, id = `toolu_probe_${++calls}`): void {
  memoryHookResponse({
    session_id: "s-now",
    cwd: project,
    hook_event_name: "PostToolBatch",
    tool_calls: [{ tool_name: "Bash", tool_input: { command }, tool_use_id: id, tool_response: response }],
  });
  tick();
}

const ON = { "guard.context": "on", "guard.ask": "on" };

describe("round 2 probes", () => {
  test("typed turn, ask in it, 'that rule is gone' in the next turn ends the rule", () => {
    submit("Don't merge PRs yourself.", "s-earlier");
    process.env.EDEN_NOW = String(NOW + 86_400_000);
    flags(ON);
    submit("the PR is approved, wrap it up");
    expect(guard("gh pr merge 42")?.permissionDecision).toBe("ask");
    batch("gh pr merge 42", "The user doesn't want to proceed with this tool use.", `toolu_probe_${calls}`);
    submit("ok, that rule is gone");
    expect(guard("gh pr merge 43")).toBeNull();
  });

  test("an ask two turns back is not what 'that rule' names", () => {
    submit("Don't merge PRs yourself.", "s-earlier");
    process.env.EDEN_NOW = String(NOW + 86_400_000);
    flags(ON);
    submit("the PR is approved, wrap it up");
    expect(guard("gh pr merge 42")?.permissionDecision).toBe("ask");
    submit("run the tests");
    submit("that rule is gone");
    expect(guard("gh pr merge 43")?.permissionDecision).toBe("ask");
  });

  test("a merge whose subject mentions --dry-run is still a merge", () => {
    submit("Don't merge PRs yourself.", "s-earlier");
    process.env.EDEN_NOW = String(NOW + 86_400_000);
    flags(ON);
    const merge = 'gh pr merge 42 --squash --subject "Add --dry-run to the deploy script"';
    expect(guard(merge)?.permissionDecision).toBe("ask");
  });

  test("a merge with --help is not one", () => {
    submit("Don't merge PRs yourself.", "s-earlier");
    process.env.EDEN_NOW = String(NOW + 86_400_000);
    flags(ON);
    expect(guard("gh pr merge --help")).toBeNull();
  });

  test("an approved ask whose call ran ends the intent; a declined one does not", () => {
    flags(ON);
    submit("Don't open the PR yet.");
    expect(guard("gh pr create --fill")?.permissionDecision).toBe("ask");
    batch("gh pr create --fill", "The user doesn't want to proceed with this tool use.", `toolu_probe_${calls}`);
    expect(guard("gh pr create --fill")?.permissionDecision).toBe("ask");
    batch("gh pr create --fill", "https://github.com/o/r/pull/7", `toolu_probe_${calls}`);
    expect(guard("gh pr create --fill")).toBeNull();
  });
});
