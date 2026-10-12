/**
 * P2.5 at SessionStart (A4 §5.2, D23, D27, A6 §2.5, D11): ≤ 3 pins and no gists; what the project's CLAUDE.md states
 * is not briefed even before InstructionsLoaded reports it; a row whose only rule the user keeps for all projects is
 * no pin; a rule the user declined 3 times in 14 days is proposed for revocation, and "that rule is gone" ends it; a
 * proposal kept in the session after the one that showed it is acknowledged at the Submit.
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
const REVOKE = /Rule you set: Don't merge PRs yourself \(you declined it 3× — say "that rule is gone" to remove it\)/;

let dir = "";
let sessions = 0;
let calls = 0;
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_POLICY_GUARD"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-start-"));
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

function repo(name = "project"): string {
  const path = join(dir, name);
  if (!existsSync(path)) {
    mkdirSync(path);
    execFileSync("git", ["init", "-q"], { cwd: path });
  }
  return path;
}

function advance(ms: number): void {
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + ms);
}

function flags(values: Record<string, string>): void {
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "home", "flags.json"), JSON.stringify(values));
}

function contextOf(out: Record<string, unknown> | null): string {
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
}

const bullets = (packet: string) => packet.split("\n").filter((line) => line.startsWith("- "));

/** One session in `project`: its SessionStart packet, then each prompt typed, a minute apart, and its stop-sleep. */
function session(project: string, prompts: string[] = []): { start: string; packets: string[]; id: string } {
  const id = `s-${++sessions}`;
  const hook = (fields: Record<string, unknown>, stage?: "stop-sleep") =>
    memoryHookResponse({ session_id: id, cwd: project, ...fields }, stage);
  const start = contextOf(hook({ hook_event_name: "SessionStart", source: "startup" }));
  const packets = prompts.map((prompt, at) => {
    advance(60_000);
    return contextOf(hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: `${id}-p${at}` }));
  });
  hook({ hook_event_name: "Stop", last_assistant_message: "Done: the port is 4000 now." }, "stop-sleep");
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

/** A guarded `gh pr merge` the user declines, in session `id`. */
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

describe("SessionStart briefs ≤ 3 pins and no gists (D23)", () => {
  test("of five pins, the three newest", () => {
    const project = repo();
    const pins = [
      "Never force-push.",
      "Always run the tests before you commit.",
      "Never deploy on Fridays.",
      "Never merge PRs yourself.",
      "Always squash when merging.",
    ];
    session(project, pins);
    const start = session(project).start;
    expect(bullets(start)).toEqual([
      "- Rule you set: Always squash when merging",
      "- Rule you set: Never merge PRs yourself",
      "- Rule you set: Never deploy on Fridays",
    ]);
  });

  test("a session's gist is not briefed: the next session gets nothing from it", () => {
    const project = repo();
    session(project, ["The dev server port is 4000."]);
    expect(session(project).start).toBe("");
  });

  test("after a compaction, nothing", () => {
    const project = repo();
    session(project, ["Never force-push."]);
    const out = memoryHookResponse({
      session_id: "s-c",
      cwd: project,
      hook_event_name: "SessionStart",
      source: "compact",
    });
    expect(contextOf(out)).toBe("");
  });
});

describe("D27 at startup: the project's CLAUDE.md before InstructionsLoaded reports it", () => {
  test("a pin the project's CLAUDE.md states is not briefed", () => {
    const project = repo();
    session(project, ["Never force-push.", "Never merge PRs yourself."]);
    writeFileSync(join(project, "CLAUDE.md"), "# Rules\n\nNever merge PRs yourself.\n");
    const start = session(project).start;
    expect(start).toContain("Never force-push");
    expect(start).not.toContain("merge");
  });
});

describe("D11: a row whose only rule the user keeps for all projects", () => {
  test("is no pin, so its other words are not briefed as a rule", () => {
    pinIn("a", "Don't merge PRs yourself, the staging server is called orbit.");
    const b = pinIn("b");
    session(b);
    session(b, ["yes, everywhere"]);
    const start = session(repo("a")).start;
    expect(start).toContain("Rule you set: Don't merge PRs yourself (all projects)");
    expect(start).not.toContain("Rule you set: the staging server");
    expect(start).not.toContain("orbit");
  });
});

describe("A6 §2.5: 3 declines in 14 days propose revoking the rule", () => {
  test("shown at the next SessionStart with the rule; not after 2 declines", () => {
    const project = repo();
    session(project, ["Don't merge PRs yourself."]);
    flags({ "guard.context": "on", "guard.ask": "on" });
    declinedMerge(project, "s-a");
    declinedMerge(project, "s-a");
    expect(session(project).start).not.toMatch(REVOKE);
    advance(3 * DAY);
    declinedMerge(project, "s-b");
    expect(session(project).start).toMatch(REVOKE);
  });

  test("declines older than 14 days do not count", () => {
    const project = repo();
    session(project, ["Don't merge PRs yourself."]);
    flags({ "guard.context": "on", "guard.ask": "on" });
    declinedMerge(project, "s-a");
    advance(15 * DAY);
    declinedMerge(project, "s-b");
    declinedMerge(project, "s-b");
    expect(session(project).start).not.toMatch(REVOKE);
  });

  test('"that rule is gone" in the session that showed it ends the rule', () => {
    const project = repo();
    session(project, ["Don't merge PRs yourself."]);
    flags({ "guard.context": "on", "guard.ask": "on" });
    for (let n = 0; n < 3; n++) declinedMerge(project, "s-a");
    const shown = session(project, ["ok, that rule is gone."]);
    expect(shown.start).toMatch(REVOKE);
    expect(session(project).start).not.toContain("merge");
    const asked = guardHookResponse({
      session_id: "s-after",
      cwd: project,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 99" },
      tool_use_id: "toolu_after",
      permission_mode: "default",
    });
    expect(asked).toBeNull();
  });

  test("approved asks do not count", () => {
    const project = repo();
    session(project, ["Don't merge PRs yourself."]);
    flags({ "guard.context": "on", "guard.ask": "on" });
    for (let n = 0; n < 3; n++) {
      const command = `gh pr merge ${n}`;
      const base = { session_id: "s-a", cwd: project, tool_use_id: `toolu_ok${n}` };
      guardHookResponse({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      const call = {
        tool_name: "Bash",
        tool_input: { command },
        tool_use_id: base.tool_use_id,
        tool_response: "Merged",
      };
      memoryHookResponse({ ...base, hook_event_name: "PostToolBatch", tool_calls: [call] });
    }
    expect(session(project).start).not.toMatch(REVOKE);
  });
});

describe("D11: a proposal kept in the session after the one that showed it", () => {
  test('the Submit says "Kept for all projects: …"; kept where it was shown, it does not', () => {
    pinIn("a");
    const b = pinIn("b");
    session(b);
    const later = session(b, ["yes, everywhere"]);
    expect(later.packets[0]).toContain("Kept for all projects: Don't merge PRs yourself");
    pinIn("c", "Never force-push.");
    const d = pinIn("d", "Never force-push.");
    const shown = session(d, ["yes, everywhere"]);
    expect(shown.start).toMatch(/Proposed for all projects: Never force-push/);
    expect(shown.packets[0] ?? "").not.toContain("Kept for all projects");
  });
});
