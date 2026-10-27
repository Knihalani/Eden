/**
 * P3.4's code review, round 1: the reviewer's probes, kept as regression tests. A user's statement survives a
 * lockfile deleted mid-install and a stray second lockfile (A4 §3.1), whose file stays watched; an equal value at a
 * folder and its ancestor is one bullet; SessionStart's heavy launch mines while an idle sleeper is pending (D34); and
 * a FileChanged in a linked worktree does not flip the repo's facts against the heavy sleep (D1: one store). Round 2:
 * a lockfile deleted and re-added is cited again; a sure failure still ends a typed row; a folder deleted for good is
 * no longer watched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { storeRows, superseded } from "../../../src/index";
import { readCitations } from "../../../src/memory-citations";
import { storeFor } from "../../../src/memory-repo";
import { memoryHookResponse } from "./memory-hook";
import { sleepCli } from "./memory-sleep";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_SLEEP_IDLE"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let dir = "";
let top = "";

function git(...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: top,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function write(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-review-p34-")));
  top = join(dir, "repo");
  write({
    "package.json": JSON.stringify({ name: "demo", workspaces: ["apps/*", "packages/*"] }),
    "package-lock.json": "{}",
    ".nvmrc": "20\n",
    "apps/web/package.json": JSON.stringify({ name: "web", engines: { node: "20" }, dependencies: { next: "15" } }),
    "apps/web/app/login.ts": "export function login() {}\n",
    "packages/cli/package.json": JSON.stringify({ name: "cli" }),
    "packages/cli/src/index.ts": "export function main() {}\n",
  });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "c");
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  delete process.env.EDEN_MEMORY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const store = () => storeFor(process.env.EDEN_MEMORY_DIR!, top);
const live = () => storeRows(join(store(), "memories.jsonl")).filter((row) => !superseded(row));

function hook(event: string, session: string, fields: Record<string, unknown> = {}): Record<string, unknown> | null {
  const out = memoryHookResponse({ hook_event_name: event, session_id: session, cwd: top, ...fields });
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 1_000);
  return out;
}

const specific = (out: Record<string, unknown> | null) =>
  (out?.hookSpecificOutput ?? {}) as { watchPaths?: string[]; additionalContext?: string };

/** The user states the package manager in s1; the heavy sleep then reads the files, which agree. */
async function statedThenMined(): Promise<void> {
  hook("SessionStart", "s1", { source: "startup" });
  hook("UserPromptSubmit", "s1", { prompt: "We use npm as the package manager.", prompt_id: "p1" });
  hook("SessionEnd", "s1", { reason: "other" });
  await sleepCli(["--heavy", "--store", store()]);
}

describe("P3.4 review round 1", () => {
  test("probe 1: a lockfile deleted and regenerated (rm package-lock.json && npm install) keeps the user's statement", async () => {
    await statedThenMined();
    expect(live().some((row) => /We use npm/.test(row.text))).toBe(true);
    hook("SessionStart", "s2", { source: "startup" });
    // `rm package-lock.json && npm install`: the watcher reports the unlink while npm install is still running.
    rmSync(join(top, "package-lock.json"));
    const out = specific(hook("FileChanged", "s2", { file_path: join(top, "package-lock.json"), event: "unlink" }));
    write({ "package-lock.json": "{}" });
    // Expected: the user's own statement survives a transient deletion (A4 §3.1: a user statement beats a citation).
    expect(live().some((row) => /We use npm/.test(row.text))).toBe(true);
    // Expected: the regenerated lockfile is still watched, so its `add` re-cites it.
    expect(out.watchPaths ?? []).toContain(join(top, "package-lock.json"));
  });

  test("probe 2: a stray second lockfile (someone ran yarn once) does not end the user's statement", async () => {
    await statedThenMined();
    write({ "yarn.lock": "# yarn lockfile v1\n" });
    process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60 * 60_000);
    await sleepCli(["--heavy", "--store", store()]);
    expect(live().some((row) => /We use npm/.test(row.text))).toBe(true);
  });

  test("probe 3: an equal value at a folder and its ancestor is two cited rows, and one bullet", async () => {
    hook("SessionStart", "s0", { source: "startup" });
    hook("SessionEnd", "s0", { reason: "other" });
    await sleepCli(["--heavy", "--store", store()]);
    const node = live().filter((row) => row.slots?.some((slot) => slot.k === "node.version"));
    expect(node.map((row) => row.scope)).toEqual(["", "apps/web"]);
    hook("SessionStart", "s1", { source: "startup" });
    hook("UserPromptSubmit", "s1", { prompt: "open apps/web/app/login.ts", prompt_id: "p1" });
    const packet = specific(
      hook("UserPromptSubmit", "s1", { prompt: "which node version does apps/web use?", prompt_id: "p2" }),
    ).additionalContext;
    expect((packet ?? "").match(/node version is 20/gi) ?? []).toHaveLength(1);
  });

  test("probe 4: SessionStart's detached heavy launch mines even while an idle sleeper is pending (D34)", async () => {
    process.env.EDEN_SLEEP_IDLE = "off";
    process.env.EDEN_NOW = "";
    hook("SessionStart", "s0", { source: "startup" });
    hook("SessionEnd", "s0", { reason: "other" });
    expect(existsSync(join(store(), "citations.json"))).toBe(false);
    process.env.EDEN_SLEEP_IDLE = "300000";
    // An idle sleeper spawned by the last session's stop-sleep, still waiting for quiet (any live pid).
    const sleeper = Bun.spawn(["sleep", "30"]);
    writeFileSync(join(store(), "sleep.pending"), JSON.stringify({ pid: sleeper.pid, t: Date.now() }));
    hook("SessionStart", "s1", { source: "startup" });
    const until = Date.now() + 8_000;
    while (!existsSync(join(store(), "citations.json")) && Date.now() < until) await Bun.sleep(200);
    sleeper.kill();
    expect(readCitations(store()).length).toBeGreaterThan(0);
  }, 20_000);
  test("probe 4 control: with no sleeper pending, SessionStart's heavy launch mines", async () => {
    process.env.EDEN_SLEEP_IDLE = "off";
    process.env.EDEN_NOW = "";
    hook("SessionStart", "s0", { source: "startup" });
    hook("SessionEnd", "s0", { reason: "other" });
    expect(existsSync(join(store(), "citations.json"))).toBe(false);
    process.env.EDEN_SLEEP_IDLE = "300000";
    hook("SessionStart", "s1", { source: "startup" });
    const until = Date.now() + 8_000;
    while (!existsSync(join(store(), "citations.json")) && Date.now() < until) await Bun.sleep(200);
    expect(readCitations(store()).length).toBeGreaterThan(0);
  }, 20_000);

  test("probe 5: a FileChanged in a linked worktree on another branch rewrites the repo's facts, and sleep flips them back", async () => {
    hook("SessionStart", "s0", { source: "startup" });
    hook("SessionEnd", "s0", { reason: "other" });
    await sleepCli(["--heavy", "--store", store()]);
    const wt = join(dir, "wt");
    git("worktree", "add", "-q", "-b", "pnpm", wt);
    rmSync(join(wt, "package-lock.json"));
    writeFileSync(join(wt, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "demo", packageManager: "pnpm@9.0.0" }));
    const at = (event: string, fields: Record<string, unknown>) =>
      memoryHookResponse({ hook_event_name: event, session_id: "w1", cwd: wt, ...fields });
    at("SessionStart", { source: "startup" });
    at("FileChanged", { file_path: join(wt, "package-lock.json"), event: "unlink" });
    const manager = () =>
      live()
        .filter((row) => row.slots?.some((slot) => slot.k === "pkg.manager"))
        .map((row) => row.text);
    const afterWorktree = manager();
    process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60 * 60_000);
    await sleepCli(["--heavy", "--store", store()]);
    const afterSleep = manager();
    // Expected: one repo store keeps one stable value; a branch's lockfile does not flip it back and forth.
    expect(afterWorktree).toEqual(afterSleep);
  });
});

async function mined(): Promise<void> {
  hook("SessionStart", "s0", { source: "startup" });
  hook("SessionEnd", "s0", { reason: "other" });
  await sleepCli(["--heavy", "--store", store()]);
}

const manager = () =>
  live()
    .filter((row) => row.slots?.some((slot) => slot.k === "pkg.manager"))
    .map((row) => row.text);

describe("P3.4 review round 2", () => {
  test("probe 6: a mined lockfile deleted then regenerated is cited again by its add, and reaches the next install", async () => {
    await mined();
    expect(manager()).toEqual(["The package manager is npm"]);
    hook("SessionStart", "s2", { source: "startup" });
    rmSync(join(top, "package-lock.json"));
    hook("FileChanged", "s2", { file_path: join(top, "package-lock.json"), event: "unlink" });
    expect(manager()).toEqual([]);
    write({ "package-lock.json": "{}" });
    const out = specific(hook("FileChanged", "s2", { file_path: join(top, "package-lock.json"), event: "add" }));
    expect(manager()).toEqual(["The package manager is npm"]);
    expect(out.watchPaths ?? []).toContain(join(top, "package-lock.json"));
    const packet = specific(hook("UserPromptSubmit", "s2", { prompt: "install the dependencies", prompt_id: "p1" }));
    expect(packet.additionalContext ?? "").toContain("The package manager is npm");
  });

  test("probe 7: an unsure failure records no stale_for; a sure one (dependency removed) still ends a typed row", async () => {
    write({
      "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { next: "15", "@clerk/nextjs": "5" } }),
    });
    hook("SessionStart", "s1", { source: "startup" });
    hook("UserPromptSubmit", "s1", { prompt: "open apps/web/app/login.ts", prompt_id: "p0" });
    hook("UserPromptSubmit", "s1", { prompt: "In apps/web the auth provider is Clerk.", prompt_id: "p1" });
    hook("SessionEnd", "s1", { reason: "other" });
    await sleepCli(["--heavy", "--store", store()]);
    const clerk = () => live().filter((row) => /clerk/i.test(row.text) && row.slots?.length);
    expect(clerk().length).toBeGreaterThan(0);
    write({ "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { next: "15" } }) });
    hook("SessionStart", "s2", { source: "startup" });
    hook("FileChanged", "s2", { file_path: join(top, "apps/web/package.json"), event: "change" });
    expect(clerk()).toEqual([]);
  });

  test("probe 8: a folder deleted for good stops being watched eventually (failed citations do not pile up)", async () => {
    await mined();
    rmSync(join(top, "apps"), { recursive: true, force: true });
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "drop apps");
    for (let i = 0; i < 3; i++) {
      process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60 * 60_000);
      hook("SessionStart", `s${i + 2}`, { source: "startup" });
      hook("SessionEnd", `s${i + 2}`, { reason: "other" });
      await sleepCli(["--heavy", "--store", store()]);
    }
    const out = specific(hook("SessionStart", "s9", { source: "startup" }));
    expect(readCitations(store()).some((citation) => citation.scope === "apps/web")).toBe(false);
    expect(out.watchPaths ?? []).not.toContain(join(top, "apps/web/package.json"));
  });
});
