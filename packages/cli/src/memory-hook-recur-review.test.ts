/**
 * P2.4 code review, round 1, as regression tests (D9, D11): a confirmation is an answer to the proposal shown (an
 * affirmative, in the repo and session that showed it or that repo's next one, within 7 days); an opposite said in
 * one repo holds there unless said for all projects; D11's phrases; a repo row gives way to a rule kept globally.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saysAllProjects } from "../../../src/memory-policy";
import { storeFor } from "../../../src/memory-repo";
import { guardHookResponse } from "./memory-guard-hook";
import { memoryHookResponse } from "./memory-hook";
import { sleepStore } from "./memory-sleep";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const DAY = 86_400_000;
const PROPOSED = /Proposed for all projects/i;

let dir = "";
let sessions = 0;
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_POLICY_GUARD"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-recur-review-"));
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

function repo(name: string): string {
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

/** One session in `project`: its SessionStart packet, then each prompt typed, a minute apart; then a day passes. */
function session(project: string, prompts: string[] = []): string {
  const id = `s-${++sessions}`;
  const hook = (fields: Record<string, unknown>) => memoryHookResponse({ session_id: id, cwd: project, ...fields });
  const start = contextOf(hook({ hook_event_name: "SessionStart", source: "startup" }));
  prompts.forEach((prompt, at) => {
    advance(60_000);
    hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: `${id}-p${at}` });
  });
  advance(DAY);
  return start;
}

const sleep = (project: string) => sleepStore(storeFor(process.env.EDEN_MEMORY_DIR!, project), undefined);

function userPolicies(): string {
  const path = join(process.env.EDEN_MEMORY_DIR!, "_user", "policies.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function pinIn(name: string, text = "Don't merge PRs yourself."): string {
  const project = repo(name);
  session(project, [text]);
  session(project, [text]);
  sleep(project);
  return project;
}

function guardAsks(project: string, command: string): string | undefined {
  flags({ "guard.ask": "on", "guard.context": "on" });
  const out = guardHookResponse({
    session_id: `s-guard-${++sessions}`,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: `toolu_${sessions}`,
    permission_mode: "default",
  });
  flags({});
  return (out?.hookSpecificOutput as Record<string, string> | undefined)?.permissionDecision;
}

/** Repos a and b hold the merge rule as a pin; repo b's next SessionStart shows the proposal. */
function shownInB(): string {
  pinIn("a");
  const b = pinIn("b");
  expect(session(b)).toMatch(PROPOSED);
  return b;
}

describe("D11: a confirmation answers the proposal shown", () => {
  test("a bare 'everywhere', months later in another repo, keeps nothing", () => {
    shownInB();
    advance(90 * DAY);
    session(repo("d"), ["everywhere"]);
    expect(userPolicies()).toBe("");
  });

  test("'yes, everywhere' 90 days later keeps nothing, in another repo or in the repo that showed it", () => {
    const b = shownInB();
    advance(90 * DAY);
    session(repo("d"), ["yes, everywhere"]);
    session(b, ["yes, everywhere"]);
    expect(userPolicies()).toBe("");
  });

  test("'yes, everywhere' in another repo right after the showing keeps nothing", () => {
    shownInB();
    session(repo("d"), ["yes, everywhere"]);
    expect(userPolicies()).toBe("");
  });

  test("a bare 'everywhere' in the repo's next session keeps nothing; 'yes, everywhere' there keeps it", () => {
    const b = shownInB();
    const hook = (fields: Record<string, unknown>) => memoryHookResponse({ session_id: "s-next", cwd: b, ...fields });
    hook({ hook_event_name: "SessionStart", source: "startup" });
    hook({ hook_event_name: "UserPromptSubmit", prompt: "everywhere", prompt_id: "n1" });
    expect(userPolicies()).toBe("");
    hook({ hook_event_name: "UserPromptSubmit", prompt: "yes, everywhere", prompt_id: "n2" });
    expect(userPolicies()).toContain("merge PRs yourself");
  });

  test("the session after the next one is too late", () => {
    const b = shownInB();
    session(b);
    session(b, ["yes, everywhere"]);
    expect(userPolicies()).toBe("");
  });
});

describe("D11: an opposite said in one repo", () => {
  test("a narrowed permission ends nothing", () => {
    session(repo("a"), ["Never force-push, in all my projects."]);
    session(repo("c"), ["Always force-push to your own feature branch."]);
    expect(userPolicies()).toContain("force-push");
  });

  test("an outright opposite holds in its repo only; said for all projects, it ends the rule everywhere", () => {
    session(repo("a"), ["Never force-push, in all my projects."]);
    session(repo("c"), ["Always force-push."]);
    expect(userPolicies()).toContain("Never force-push");
    expect(guardAsks(repo("d"), "git push --force origin feat")).toBe("ask");
    expect(guardAsks(repo("c"), "git push --force origin feat")).toBeUndefined();
    expect(session(repo("c"))).not.toContain("Never force-push");
    session(repo("e"), ["Always force-push, in all my projects."]);
    expect(userPolicies()).not.toContain("Never force-push");
    expect(guardAsks(repo("d"), "git push --force origin feat")).toBeUndefined();
  });
});

describe("D11's phrases", () => {
  test("'everywhere' and 'globally' count only set off from the rule, as its last or first words", () => {
    const cases: [string, boolean][] = [
      ["Never force-push, everywhere.", true],
      ["Never force-push in all my projects.", true],
      ["Never force-push in any of my projects.", true],
      ["Never commit secrets — everywhere.", true],
      ["Globally, never force-push.", true],
      ["Never install packages globally.", false],
      ["Don't use var, globally scoped variables are banned.", false],
      ["Don't merge PRs yourself: globally, CI is flaky.", false],
      ["Don't push to main, anywhere.", false],
    ];
    for (const [sentence, says] of cases) expect([sentence, saysAllProjects(sentence)]).toEqual([sentence, says]);
  });
});

describe("pins and the rest", () => {
  test("an intent then the same policy in another session is a policy_recur but no pin (D9)", () => {
    const a = repo("a");
    session(a, ["Don't merge PRs yourself yet."]);
    session(a, ["Don't merge PRs yourself."]);
    sleep(a);
    expect(session(a)).not.toContain("merge PRs yourself");
  });

  test("a pin revoked after promotion is not proposed, and not briefed", () => {
    const a = pinIn("a");
    session(a, ["You can merge PRs yourself now."]);
    pinIn("b");
    expect(session(a)).not.toContain("merge PRs");
    const proposals = join(process.env.EDEN_MEMORY_DIR!, "_user", "proposals.jsonl");
    expect(existsSync(proposals) ? readFileSync(proposals, "utf8") : "").toBe("");
  });

  test("a hook fails open with a file where _user should be", () => {
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(join(dir, "memory", "_user"), "not a dir");
    const a = pinIn("a");
    expect(session(a, ["Never force-push, in all my projects.", "yes, everywhere"])).toContain("merge PRs yourself");
    expect(guardAsks(repo("c"), "gh pr merge 1")).toBeUndefined();
  });

  test("a repo row stating a rule kept for all projects and another rule briefs the global rule once", () => {
    session(repo("a"), ["Never force-push, in all my projects."]);
    const c = repo("c");
    session(c, ["Never force-push, and never delete the fixtures."]);
    const start = session(c);
    expect(start.match(/force-push/g)?.length).toBe(1);
    expect(start).toContain("Never force-push (all projects)");
    expect(start).toContain("never delete the fixtures");
  });

  test("a rule kept for all projects reaches the guard of a repo with no store yet", () => {
    session(repo("a"), ["Never force-push, in all my projects."]);
    expect(guardAsks(repo("fresh"), "git push --force")).toBe("ask");
  });
});
