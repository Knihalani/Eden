/**
 * P2.3 code review, round 1: the reviewer's probes, kept as regression tests. "That rule is gone" ends only a rule the
 * user was just asked about; a release names the intent's own verb; `EDEN_POLICY_GUARD=off` silences the guard; an
 * intent the agent broke without an ask still holds; a call no class is logs nothing.
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

describe("'that rule is gone' (A4 §5.4 note: after the guard showed it)", () => {
  test("a rule the guard never showed (default flags: shadow) is not dropped by 'remove this rule'", () => {
    submit("Don't merge PRs yourself.", "s-earlier");
    process.env.EDEN_NOW = String(NOW + 86_400_000);
    flags(undefined); // the shipped defaults: guard.context shadow, guard.ask off
    expect(guard("gh pr merge 42")).toBeNull(); // shown to nobody
    submit("Remove this rule from the eslint config, it fires on every file.");
    flags(ON);
    expect(guard("gh pr merge 43")?.permissionDecision).toBe("ask");
  });

  test("a rule shown hours earlier is not dropped by a later 'delete that rule' about something else", () => {
    submit("Don't merge PRs yourself.", "s-earlier");
    process.env.EDEN_NOW = String(NOW + 86_400_000);
    flags(ON);
    expect(guard("gh pr merge 42")?.permissionDecision).toBe("ask");
    batch("gh pr merge 42", "The user doesn't want to proceed with this tool use.", `toolu_probe_${calls}`);
    process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 3 * 3_600_000);
    submit("now look at biome.json: there is a no-console lint check there, delete that rule.");
    expect(guard("gh pr merge 43")?.permissionDecision).toBe("ask");
  });
});

describe("a release with no class word (A4 §5.4 note: its verb is the intent's own or its class's)", () => {
  test("'Do it now.' releases no intent: `do` is not the verb of \"Don't open the PR yet\"", () => {
    flags(ON);
    submit("Don't open the PR yet.");
    submit("Don't deploy yet.");
    submit("Do it now.");
    expect(guard("gh pr create --fill")?.permissionDecision).toBe("ask");
    expect(guard("npm run deploy")?.permissionDecision).toBe("ask");
  });
});

describe("EDEN_POLICY_GUARD=off disables the guard (D19, A4 §5.4, A6 §2.5)", () => {
  test("nothing is printed, whatever guard.context says", () => {
    submit("Don't merge PRs yourself.", "s-earlier");
    flags({ "guard.context": "on" });
    process.env.EDEN_POLICY_GUARD = "off";
    expect(guard("gh pr merge 42")).toBeNull();
  });
});

describe("an intent the agent broke without being asked (bypassPermissions) still holds", () => {
  test("'Don't push yet' survives a push the guard could only tell about", () => {
    flags(ON);
    submit("Don't push yet.");
    expect(guard("git push origin feature", "bypassPermissions")?.permissionDecision).toBeUndefined();
    batch("git push origin feature", "Everything up-to-date", `toolu_probe_${calls}`);
    expect(guard("git push origin feature")?.permissionDecision).toBe("ask");
  });
});

describe("a command the guard has nothing to say about logs nothing", () => {
  test("`echo $HOME` (every handler spawns: the if filter cannot read it) writes no wide event", () => {
    flags(undefined);
    for (let n = 0; n < 5; n++) guard("echo $HOME");
    const events = join(dir, "memory", "hook.log.d");
    const lines = existsSync(events)
      ? execFileSync("sh", ["-c", `cat ${events}/* 2>/dev/null || true`])
          .toString()
          .split("\n")
          .filter(Boolean)
      : [];
    expect(lines.filter((line) => line.includes('"PreToolUse"'))).toEqual([]);
  });
});

describe("release verbs, read directly", () => {
  test("intentsReleasedBy: 'Do it now.' names no intent's verb", async () => {
    const { intentsReleasedBy } = await import("../../../src/memory-guard");
    flags(ON);
    submit("Don't open the PR yet.");
    const store = execFileSync("sh", ["-c", `dirname $(find ${dir}/memory -name intents.jsonl | head -1)`])
      .toString()
      .trim();
    expect(readFileSync(join(store, "intents.jsonl"), "utf8")).toContain("open the PR");
    expect(intentsReleasedBy(store, "Do it now.")).toEqual([]);
  });
});

describe("control for the 'that rule is gone' probes", () => {
  test("without the sentence, the rule still asks after a shadow call", () => {
    submit("Don't merge PRs yourself.", "s-earlier");
    process.env.EDEN_NOW = String(NOW + 86_400_000);
    flags(undefined);
    expect(guard("gh pr merge 42")).toBeNull();
    submit("Look at the eslint config, it fires on every file.");
    flags(ON);
    expect(guard("gh pr merge 43")?.permissionDecision).toBe("ask");
    const validity = execFileSync("sh", ["-c", `cat $(find ${dir}/memory -name 'validity.jsonl') 2>/dev/null || true`]);
    expect(validity.toString()).not.toContain('"k":"end"');
  });
});
