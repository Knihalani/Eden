/**
 * P0.5 at the hook: one store per repo (D1), one window per context window (D2). Sessions, worktrees and subagents
 * of a repo remember together; another repo, or a session outside git, remembers apart; a store in a format this code
 * does not know, or a migration between its renames, is left alone (EXECUTION §9).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationStage, repoIdentity, storeFor } from "../../../src/memory-repo";
import { memoryHookResponse } from "./memory-hook";
import { cuesBelowTau } from "../../../scripts/test-below-tau";

cuesBelowTau();

let dir = "";
let root = "";
const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME, memory: process.env.EDEN_MEMORY };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-repo-"));
  root = join(dir, "memory");
  process.env.EDEN_MEMORY_DIR = root;
  process.env.EDEN_HOME = join(dir, "home");
  delete process.env.EDEN_MEMORY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_MEMORY_DIR", prev.dir],
    ["EDEN_HOME", prev.home],
    ["EDEN_MEMORY", prev.memory],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

/** A git repo with one commit under the test directory. */
function repo(name: string): string {
  const top = join(dir, name);
  mkdirSync(join(top, "src"), { recursive: true });
  writeFileSync(join(top, "src", "index.ts"), "export {};\n");
  git(top, "init", "-q", "-b", "main");
  git(top, "add", "-A");
  git(top, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  return top;
}

function submit(session: string, cwd: string, prompt: string): string | undefined {
  const out = memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: session, cwd, prompt });
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
}

function storeOf(cwd: string): string {
  return storeFor(root, cwd);
}

function rows(store: string): string {
  const path = join(store, "memories.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The wide events every invocation appended (`memory-events.ts`). */
function wideEvents(): Record<string, unknown>[] {
  const logs = join(root, "hook.log.d");
  return readdirSync(logs).flatMap((name) =>
    readFileSync(join(logs, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

describe("one store per repo (D1)", () => {
  test("a later session of the repo is given what an earlier one was told; no session has a store of its own", () => {
    const top = repo("app");
    submit("s-one", top, "The database is postgres.");
    expect(submit("s-two", join(top, "src"), "what database do we use?")).toContain("postgres");
    expect(rows(storeOf(top))).toContain("The database is postgres");
    expect(readdirSync(root).sort()).toEqual(["hook.log.d", "repos", "windows"]);
  });

  test("a linked worktree's session writes to its main checkout's store", () => {
    const top = repo("app");
    const linked = join(top, ".claude", "worktrees", "agent-x");
    git(top, "worktree", "add", "-q", "-b", "agent-x", linked);
    submit("s-worktree", linked, "The auth provider is Clerk.");
    expect(storeOf(linked)).toBe(storeOf(top));
    expect(submit("s-main", top, "which auth provider do we use?")).toContain("Clerk");
  });

  test("another repo's session is given nothing from the first", () => {
    const first = repo("first");
    const second = repo("second");
    submit("s-first", first, "The database is postgres.");
    expect(submit("s-second", second, "what database do we use?") ?? "").not.toContain("postgres");
    expect(storeOf(first)).not.toBe(storeOf(second));
    expect(rows(storeOf(second))).not.toContain("postgres");
  });

  test("outside git, a session keeps the store of the directory it started in", () => {
    const home = join(dir, "notes");
    mkdirSync(join(home, "drafts"), { recursive: true });
    memoryHookResponse({ hook_event_name: "SessionStart", session_id: "s-notes", cwd: home, source: "startup" });
    submit("s-notes", join(home, "drafts"), "The deadline is friday.");
    expect(rows(storeOf(home))).toContain("The deadline is friday");
    expect(existsSync(storeOf(join(home, "drafts")))).toBe(false);
  });

  test("the wide event names the repo by its key", () => {
    const top = repo("app");
    submit("s-key", top, "hello there");
    expect(wideEvents().map((event) => event.repo)).toEqual([repoIdentity(top)!.key]);
  });
});

describe("one window per context window (D2)", () => {
  test("a subagent's results go to the repo store, logged under the window session--agent", () => {
    const top = repo("app");
    memoryHookResponse({
      hook_event_name: "PostToolUse",
      session_id: "s-parent",
      agent_id: "agent-7",
      cwd: top,
      tool_name: "Read",
      tool_response: "The cache layer wraps redis behind src/cache.ts.",
    });
    expect(rows(storeOf(top))).toContain("src/cache.ts");
    expect(readdirSync(root)).not.toContain("s-parent--agent-7");
    expect(wideEvents().map((event) => event.win)).toEqual(["s-parent--agent-7"]);
  });
});

describe("stores the hook leaves alone (EXECUTION §9)", () => {
  test("a store whose format.json names a newer major version is neither read nor written", () => {
    const top = repo("app");
    submit("s-one", top, "The database is postgres.");
    const store = storeOf(top);
    writeFileSync(join(store, "format.json"), JSON.stringify({ major: 3 }));
    const before = rows(store);
    expect(submit("s-two", top, "what database do we use? The cache is redis.")).toBeUndefined();
    expect(rows(store)).toBe(before);
  });

  test("between a migration's two renames (no root, a staged tree) nothing is written", () => {
    const top = repo("app");
    mkdirSync(migrationStage(root), { recursive: true });
    expect(submit("s-one", top, "The database is postgres.")).toBeUndefined();
    expect(existsSync(root)).toBe(false);
  });

  test("a store the hook creates says its format", () => {
    const top = repo("app");
    submit("s-one", top, "The database is postgres.");
    expect(JSON.parse(readFileSync(join(storeOf(top), "format.json"), "utf8"))).toEqual({ major: 2 });
  });
});
