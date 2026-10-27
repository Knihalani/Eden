/**
 * P2.4 at the hook (D9, D11, A4 §5.2, §6, §7): a policy said unqualified in 2 sessions becomes a pin at sleep, and
 * only pins are briefed at SessionStart; a pin held in 2 repos is proposed for all projects once, at a SessionStart
 * of a repo holding it; "yes, everywhere" keeps it, and from then on every repo is briefed it `(all projects)`, its
 * guard and its Submit trigger read it, under one `_user/` cid.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../../src/index";
import { storeFor } from "../../../src/memory-repo";
import { guardHookResponse } from "./memory-guard-hook";
import { memoryHookResponse } from "./memory-hook";
import { memoryPurgeCli } from "./memory-purge";
import { sleepStore } from "./memory-sleep";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const DAY = 86_400_000;
const PROPOSED = /Proposed for all projects: .*merge.*\(say "yes, everywhere" to keep\)/i;

let dir = "";
let sessions = 0;
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_POLICY_GUARD"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-recur-"));
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

/** A git repo of its own under the test directory. */
function repo(name: string): string {
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

/** One session in `project`: its SessionStart packet, then each prompt typed, a minute apart. */
function session(project: string, prompts: string[] = []): { start: string; packets: string[]; id: string } {
  const id = `s-${++sessions}`;
  const hook = (fields: Record<string, unknown>) => memoryHookResponse({ session_id: id, cwd: project, ...fields });
  const start = contextOf(hook({ hook_event_name: "SessionStart", source: "startup" }));
  const packets = prompts.map((prompt, at) => {
    advance(60_000);
    return contextOf(hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: `${id}-p${at}` }));
  });
  advance(DAY);
  return { start, packets, id };
}

/** The idle sleeper's full sleep of `project`'s store. */
function sleep(project: string): void {
  sleepStore(storeFor(process.env.EDEN_MEMORY_DIR!, project), undefined);
}

const rows = (project: string) =>
  openMemory({ dir: storeFor(process.env.EDEN_MEMORY_DIR!, project), perRepo: true }).memories();

function wideEvents(): { ev: string; prompt_id?: string; policy_recur?: string[]; cids?: string[] }[] {
  const events = join(process.env.EDEN_MEMORY_DIR!, "hook.log.d");
  return readdirSync(events)
    .flatMap((file) => readFileSync(join(events, file), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line));
}

describe("P2.4: a policy said in 2 sessions is a pin (D9)", () => {
  test("said in one session it is not briefed; said in a second, after sleep, it is", () => {
    const a = repo("a");
    session(a, ["Don't merge PRs yourself."]);
    sleep(a);
    expect(session(a).start).not.toContain("merge PRs yourself");
    session(a, ["Push the fix, but don't merge PRs yourself."]);
    sleep(a);
    expect(session(a).start).toContain("Rule you set: Don't merge PRs yourself");
  });

  test("promotion marks the recurring rule's refs, not the other rules of a row", () => {
    const a = repo("a");
    session(a, ["Don't merge PRs yourself, and don't delete the fixtures."]);
    session(a, ["Don't merge PRs yourself."]);
    sleep(a);
    const both = rows(a).find((row) => row.text.includes("fixtures"));
    expect(both?.rules).toEqual([{ k: "integrate|neg|*", p: true }, { k: "delete|neg|fixture" }]);
    const start = session(a).start;
    expect(start).toContain("merge PRs yourself");
    expect(start).not.toContain("fixtures");
  });

  test("twice in one session is not a recurrence", () => {
    const a = repo("a");
    session(a, ["Don't merge PRs yourself.", "Again: don't merge PRs yourself."]);
    sleep(a);
    expect(session(a).start).not.toContain("merge PRs yourself");
  });

  test("an intent said in 3 sessions is never a pin", () => {
    const a = repo("a");
    for (let n = 0; n < 3; n++) session(a, ["Don't open the PR yet."]);
    sleep(a);
    expect(
      rows(a)
        .flatMap((row) => row.rules ?? [])
        .some((rule) => "p" in rule),
    ).toBe(false);
    expect(session(a).start).not.toContain("open the PR");
  });

  test('"never squash" and "never force-push" are not one recurrence; each is a pin of its own', () => {
    const a = repo("a");
    session(a, ["Don't squash when merging."]);
    session(a, ["Don't force-push to the branch."]);
    sleep(a);
    const start = session(a).start;
    expect(start).not.toContain("squash");
    expect(start).not.toContain("force-push");
  });

  test("a rule overturned before it was said again does not recur", () => {
    const a = repo("a");
    session(a, ["Don't merge PRs yourself."]);
    session(a, ["You can merge PRs yourself now."]);
    session(a, ["Don't merge PRs yourself."]);
    sleep(a);
    expect(session(a).start).not.toContain("merge PRs yourself");
  });

  test("an explicit rule is a pin from its first session, as before", () => {
    const a = repo("a");
    session(a, ["Never merge PRs yourself."]);
    expect(session(a).start).toContain("Rule you set: Never merge PRs yourself");
  });

  test("a session gist carries no rule clause: rules reach SessionStart only as pins", () => {
    const a = repo("a");
    session(a, ["We use pnpm in this repo.", "Don't delete the fixtures."]);
    sleep(a);
    const start = session(a).start;
    expect(start).not.toContain("fixtures");
  });

  test("a Submit that says a rule of an earlier session logs policy_recur, pin or not (A4 §7)", () => {
    const a = repo("a");
    session(a, ["Don't open the PR yet."]);
    const later = session(a, ["Don't open the PR.", "Don't open the PR."]);
    const submits = wideEvents().filter((event) => event.ev === "UserPromptSubmit");
    expect(submits.find((event) => event.prompt_id === `${later.id}-p0`)?.policy_recur).toEqual(["review|neg|*"]);
    expect(submits.filter((event) => event.policy_recur).length).toBe(2);
  });
});

/** Repo `name` holds the merge rule as a pin: said in 2 of its sessions, then slept. */
function pinIn(name: string): string {
  const project = repo(name);
  session(project, ["Don't merge PRs yourself."]);
  session(project, ["Don't merge PRs yourself."]);
  sleep(project);
  return project;
}

describe("P2.4: a pin in 2 repos is proposed for all projects (D11)", () => {
  test("shown once, at a SessionStart of a repo holding the pin, in place of its pin bullet", () => {
    const a = pinIn("a");
    const b = pinIn("b");
    const shown = session(b).start;
    expect(shown).toMatch(PROPOSED);
    expect(shown).not.toContain("Rule you set: Don't merge");
    const next = session(a).start;
    expect(next).not.toMatch(PROPOSED);
    expect(next).toContain("Rule you set: Don't merge PRs yourself");
  });

  test("a repo that does not hold the pin is not shown the proposal, and is not briefed the rule", () => {
    pinIn("a");
    pinIn("b");
    expect(session(repo("c")).start).toBe("");
  });

  test('"yes, everywhere" keeps it: a third repo is briefed it (all projects), unprompted', () => {
    pinIn("a");
    const b = pinIn("b");
    session(b);
    session(b, ["yes, everywhere"]);
    const third = session(repo("c")).start;
    expect(third).toContain("Rule you set: Don't merge PRs yourself (all projects)");
    const here = session(b).start;
    expect(here.match(/merge PRs yourself/g)?.length).toBe(1);
    expect(here).toContain("(all projects)");
  });

  test('"yes, everywhere" before any proposal was shown keeps nothing', () => {
    pinIn("a");
    pinIn("b");
    // Repo C holds no pin, so its SessionStart shows no proposal before the answer.
    session(repo("c"), ["yes, everywhere"]);
    expect(existsSync(join(process.env.EDEN_MEMORY_DIR!, "_user", "policies.jsonl"))).toBe(false);
  });

  test("in shadow, SessionStart shows nothing, so the proposal is still unshown", () => {
    pinIn("a");
    const b = pinIn("b");
    flags({ "deliver.session_start": "shadow" });
    expect(session(b).start).toBe("");
    flags({});
    expect(session(b).start).toMatch(PROPOSED);
  });

  test("other objects of one class in 2 repos make no proposal", () => {
    for (const [name, rule] of [
      ["a", "Don't delete the fixtures."],
      ["b", "Don't remove the old API."],
    ] as const) {
      const project = repo(name);
      session(project, [rule]);
      session(project, [rule]);
      sleep(project);
      expect(session(project).start).not.toMatch(/Proposed for all projects/);
    }
  });

  test("the guard in a third repo asks on the user-global rule, under its _user cid", () => {
    pinIn("a");
    const b = pinIn("b");
    session(b);
    session(b, ["yes, everywhere"]);
    flags({ "guard.ask": "on", "guard.context": "on" });
    const out = guardHookResponse({
      session_id: "s-guard",
      cwd: repo("c"),
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 42 --squash" },
      tool_use_id: "toolu_1",
      permission_mode: "default",
    });
    const said = out?.hookSpecificOutput as Record<string, string> | undefined;
    expect(said?.permissionDecision).toBe("ask");
    expect(said?.additionalContext).toContain("pull requests are merged by you");
    const guarded = wideEvents().find((event) => event.ev === "PreToolUse");
    expect(guarded?.cids?.every((cid) => cid.startsWith("_user/P:"))).toBe(true);
  });

  test("the Submit trigger in a third repo delivers the user-global rule", () => {
    pinIn("a");
    const b = pinIn("b");
    session(b);
    session(b, ["yes, everywhere"]);
    const c = repo("c");
    const hook = (fields: Record<string, unknown>) => memoryHookResponse({ session_id: "s-c", cwd: c, ...fields });
    const packet = contextOf(
      hook({ hook_event_name: "UserPromptSubmit", prompt: "the PR is approved, land it", prompt_id: "c1" }),
    );
    expect(packet).toContain("Rule you set: Don't merge PRs yourself (all projects)");
  });

  test("a typed revocation holds in its repo; said for all projects, it ends the user-global rule", () => {
    pinIn("a");
    const b = pinIn("b");
    session(b);
    session(b, ["yes, everywhere"]);
    session(repo("c"), ["You can merge PRs yourself now."]);
    expect(session(repo("c")).start).not.toContain("merge PRs yourself");
    expect(session(repo("d")).start).toContain("merge PRs yourself");
    session(repo("c"), ["You can merge PRs yourself now, in all my projects."]);
    expect(session(repo("d")).start).not.toContain("merge PRs yourself");
  });
});

describe("P2.4: a rule stated for all projects (D11's phrases)", () => {
  test('"in all my projects" keeps a policy for every repo, without the phrase in its object', () => {
    session(repo("a"), ["Never force-push, in all my projects."]);
    expect(session(repo("b")).start).toContain("(all projects)");
    const rule = rows(repo("a")).find((row) => row.text.includes("force-push"))?.rules?.[0];
    expect(rule?.k).toBe("history-rewrite|neg|*");
  });

  test("purge rewrites the user-global store too (A6 §2.2)", () => {
    session(repo("a"), ["Never force-push, in all my projects."]);
    const kept = join(process.env.EDEN_MEMORY_DIR!, "_user", "policies.jsonl");
    expect(readFileSync(kept, "utf8")).toContain("force-push");
    memoryPurgeCli(["purge", "force-push"]);
    expect(readFileSync(kept, "utf8")).not.toContain("force-push");
  });

  test("an intent or a fact with the phrase stays in its repo, and so does npm's 'globally'", () => {
    session(repo("a"), ["Don't open the PR yet, everywhere.", "We use pnpm everywhere."]);
    session(repo("a"), ["Never install packages globally."]);
    expect(session(repo("b")).start).toBe("");
  });
});
