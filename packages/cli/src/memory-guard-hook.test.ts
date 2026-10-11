/**
 * P2.3 at the hook (D19, A4 §5.4–5.5, A6 §2.5, X7): what each flag state prints and records, one answer per call
 * across parallel handlers, the class re-check, consent, the labels a later PostToolBatch reads, and the rules the
 * user's words or a completed action end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardHookResponse } from "./memory-guard-hook";
import { memoryHookResponse } from "./memory-hook";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const DECLINED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, " +
  "the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how " +
  "to proceed.";

let dir = "";
let project = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_POLICY_GUARD"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-guard-hook-"));
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

function flags(values: Record<string, string>): void {
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "home", "flags.json"), JSON.stringify(values));
}

function tick(): void {
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60_000);
}

function submit(prompt: string, session = "s-earlier"): void {
  memoryHookResponse({ session_id: session, cwd: project, hook_event_name: "UserPromptSubmit", prompt });
  tick();
}

let calls = 0;
type Said = { context?: string; decision?: string; reason?: string } | null;

/** One PreToolUse handler of `cls` for `command`; `id` names the call, a fresh one by default. */
function guard(cls: string, command: string, extra: Record<string, unknown> = {}): Said {
  const out = guardHookResponse(
    {
      session_id: "s-now",
      cwd: project,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: `toolu_${++calls}`,
      permission_mode: "default",
      ...extra,
    },
    cls,
  );
  const said = out?.hookSpecificOutput as Record<string, string> | undefined;
  return said
    ? { context: said.additionalContext, decision: said.permissionDecision, reason: said.permissionDecisionReason }
    : null;
}

function batch(id: string, command: string, response: string): void {
  memoryHookResponse({
    session_id: "s-now",
    cwd: project,
    hook_event_name: "PostToolBatch",
    tool_calls: [{ tool_name: "Bash", tool_input: { command }, tool_use_id: id, tool_response: response }],
  });
  tick();
}

function events(): Record<string, unknown>[] {
  const root = join(dir, "memory", "hook.log.d");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) => readFileSync(join(root, file), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const guardEvents = () => events().filter((event) => event.ev === "PreToolUse");
const windowFile = (name: string) => join(dir, "memory", "windows", "s-now", name);

describe("flags (X7)", () => {
  test("default: guard.context shadow and guard.ask off print nothing, and record what was due", () => {
    submit("Don't merge PRs yourself.");
    expect(guard("integrate", "gh pr merge 1")).toBeNull();
    expect(guardEvents().at(-1)).toMatchObject({ guard_class: "integrate", would_ask: true, mode: "shadow" });
    expect(readFileSync(windowFile("delivery.shadow.log"), "utf8")).toContain('"k":"deliver"');
    expect(existsSync(windowFile("delivery.log"))).toBe(false);
  });

  test("guard.context on tells only; guard.ask on asks with the context; context off asks alone", () => {
    submit("Don't merge PRs yourself.");
    flags({ "guard.context": "on" });
    const told = guard("integrate", "gh pr merge 1");
    expect(told?.decision).toBeUndefined();
    expect(told?.context).toContain("pull requests are merged by you, not by the agent");
    expect(readFileSync(windowFile("delivery.log"), "utf8")).toContain('"k":"deliver"');
    flags({ "guard.context": "shadow", "guard.ask": "on" });
    expect(guard("integrate", "gh pr merge 1")).toMatchObject({ decision: "ask", context: expect.any(String) });
    flags({ "guard.context": "off", "guard.ask": "on" });
    expect(guard("integrate", "gh pr merge 1")).toEqual({
      decision: "ask",
      context: undefined,
      reason: expect.any(String),
    });
  });

  test("both off: nothing printed, no guard.log, no ledger", () => {
    submit("Don't merge PRs yourself.");
    flags({ "guard.context": "off", "guard.ask": "off" });
    expect(guard("integrate", "gh pr merge 1")).toBeNull();
    expect(existsSync(windowFile("guard.log"))).toBe(false);
    expect(existsSync(windowFile("delivery.shadow.log"))).toBe(false);
  });

  test("EDEN_POLICY_GUARD=off is the kill switch for the ask", () => {
    submit("Don't merge PRs yourself.");
    flags({ "guard.context": "on", "guard.ask": "on" });
    process.env.EDEN_POLICY_GUARD = "off";
    expect(guard("integrate", "gh pr merge 1")?.decision).toBeUndefined();
  });
});

describe("one answer per call", () => {
  test("parallel handlers of one call: the first answers for the most severe class, the rest stay silent", () => {
    submit("Never force-push.");
    submit("Don't push without asking me.");
    flags({ "guard.context": "on", "guard.ask": "on" });
    const call = { tool_use_id: "toolu_same" };
    const answers = ["push-upstream", "history-rewrite", "history-rewrite"].map((cls) =>
      guard(cls, "git push --force origin feature", call),
    );
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(answers[0]?.reason).toBe("Eden: rule you set (2 minutes ago): Never force-push");
    expect(guardEvents().filter((event) => event.guard_dup)).toHaveLength(2);
  });

  test("a handler whose class the call is not answers nothing (the re-check)", () => {
    submit("Don't merge PRs yourself.");
    flags({ "guard.context": "on", "guard.ask": "on" });
    expect(guard("delete", "gh pr merge 1")).toBeNull();
  });
});

describe("consent", () => {
  test("read-only and off say nothing and write nothing", () => {
    submit("Don't merge PRs yourself.");
    flags({ "guard.context": "on", "guard.ask": "on" });
    for (const consent of ["readonly", "off"]) {
      process.env.EDEN_MEMORY = consent;
      expect(guard("integrate", "gh pr merge 1")).toBeNull();
    }
    expect(existsSync(windowFile("guard.log"))).toBe(false);
  });

  test("a store that cannot be read fails open: nothing printed", () => {
    rmSync(join(dir, "memory"), { recursive: true, force: true });
    writeFileSync(join(dir, "memory"), "not a directory\n");
    flags({ "guard.context": "on", "guard.ask": "on" });
    expect(guard("integrate", "gh pr merge 1")).toBeNull();
  });
});

describe("after the call (A4 §5.5, A6 §2.5)", () => {
  test("the next PostToolBatch labels an ask declined or approved, once", () => {
    submit("Don't merge PRs yourself.");
    flags({ "guard.context": "on", "guard.ask": "on" });
    guard("integrate", "gh pr merge 1", { tool_use_id: "toolu_no" });
    guard("integrate", "gh pr merge 2", { tool_use_id: "toolu_yes" });
    batch("toolu_no", "gh pr merge 1", DECLINED);
    batch("toolu_yes", "gh pr merge 2", "Merged pull request #2");
    batch("toolu_yes", "gh pr merge 2", "Merged pull request #2");
    const labels = events().flatMap((event) => (event.guard_labels as unknown[]) ?? []);
    expect(labels).toEqual([
      { id: "toolu_no", label: "declined" },
      { id: "toolu_yes", label: "approved" },
    ]);
  });

  test("an intent ends once the call carrying out its action has run", () => {
    submit("Don't open the PR yet.");
    flags({ "guard.context": "on", "guard.ask": "on" });
    expect(guard("review", "gh pr create --fill", { tool_use_id: "toolu_pr" })?.decision).toBe("ask");
    batch("toolu_pr", "gh pr create --fill", "https://github.com/o/r/pull/7");
    expect(guard("review", "gh pr create --fill")).toBeNull();
  });

  test("a declined call carries nothing out: the intent stays", () => {
    submit("Don't open the PR yet.");
    flags({ "guard.context": "on", "guard.ask": "on" });
    guard("review", "gh pr create --fill", { tool_use_id: "toolu_pr" });
    batch("toolu_pr", "gh pr create --fill", DECLINED);
    expect(guard("review", "gh pr create --fill")?.decision).toBe("ask");
  });
});

describe("what the user's words end", () => {
  test('a release with no class word ends the intent it names ("Open it now.")', () => {
    submit("Don't open the PR yet.");
    flags({ "guard.context": "on", "guard.ask": "on" });
    submit("Open it now.");
    expect(guard("review", "gh pr create --fill")).toBeNull();
  });

  test('"that rule is gone" ends the rules the guard last showed in the window, a narrowed one included', () => {
    submit("Don't push without asking me.");
    submit("Never merge PRs yourself.");
    flags({ "guard.context": "on", "guard.ask": "on" });
    expect(guard("push-upstream", "git push origin feature")?.decision).toBe("ask");
    submit("ok, that rule is gone", "s-now");
    expect(guard("push-upstream", "git push origin feature")).toBeNull();
    expect(guard("integrate", "gh pr merge 1")?.decision).toBe("ask");
  });
});
