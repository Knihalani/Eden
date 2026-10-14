/**
 * P3.4 at the hook (D8, D31, R0 F29, D5): SessionStart names the cited files Claude Code should watch (only when its
 * point is on), FileChanged re-reads the folders citing a changed file and names the list again, CwdChanged names it
 * too, a mined fact reaches the prompt that needs it ("install the dependencies"), and a mined fact a folder in the
 * read set overrides is not delivered there.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { storeRows, superseded } from "../../../src/index";
import { readCitations } from "../../../src/memory-citations";
import { storeFor } from "../../../src/memory-repo";
import { memoryHookResponse } from "./memory-hook";
import { sleepCli } from "./memory-sleep";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SESSION_START"] as const;
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

const web = (dependencies: Record<string, string>) => JSON.stringify({ name: "web", dependencies });

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-hook-citations-")));
  top = join(dir, "repo");
  write({
    "package.json": JSON.stringify({ name: "demo", workspaces: ["apps/*", "packages/*"] }),
    "package-lock.json": "{}",
    ".nvmrc": "20\n",
    "apps/web/package.json": web({ "@clerk/nextjs": "5" }),
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
  delete process.env.EDEN_FLAG_DELIVER_SESSION_START;
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
  (out?.hookSpecificOutput ?? {}) as { hookEventName?: string; watchPaths?: string[]; additionalContext?: string };

/** A repo its first session met, whose files the heavy sleep then read (D34). */
async function mined(): Promise<void> {
  hook("SessionStart", "s0", { source: "startup" });
  hook("SessionEnd", "s0", { reason: "other" });
  await sleepCli(["--heavy", "--store", store()]);
}

describe("watchPaths (D31, R0 F29)", () => {
  test("SessionStart names every cited file, absolute; a repo with none names nothing", async () => {
    expect(specific(hook("SessionStart", "s1", { source: "startup" })).watchPaths).toBeUndefined();
    await mined();
    const out = specific(hook("SessionStart", "s2", { source: "startup" }));
    expect(out.hookEventName).toBe("SessionStart");
    expect([...out.watchPaths!].sort()).toEqual(
      [join(top, "package-lock.json"), join(top, ".nvmrc"), join(top, "apps/web/package.json")].sort(),
    );
  });

  test("a resumed process watches nothing yet, so its SessionStart names the files too", async () => {
    await mined();
    expect(specific(hook("SessionStart", "s2", { source: "resume" })).watchPaths).toHaveLength(3);
  });

  test("SessionStart names none when its point is shadow or off (X7)", async () => {
    await mined();
    for (const mode of ["shadow", "off"]) {
      process.env.EDEN_FLAG_DELIVER_SESSION_START = mode;
      expect(hook("SessionStart", `s-${mode}`, { source: "startup" })).toBeNull();
      expect(hook("CwdChanged", `s-${mode}`, { old_cwd: top, new_cwd: top })).toBeNull();
    }
  });

  test("CwdChanged names the list again", async () => {
    await mined();
    const out = specific(hook("CwdChanged", "s2", { old_cwd: top, new_cwd: join(top, "apps/web") }));
    expect(out.hookEventName).toBe("CwdChanged");
    expect(out.watchPaths).toHaveLength(3);
  });
});

describe("FileChanged's re-check (D31)", () => {
  test("a dependency removed fails its citation: the fact goes to history, and the list loses the file", async () => {
    await mined();
    expect(live().map((row) => row.text)).toContain("In apps/web the auth provider is clerk");
    write({ "apps/web/package.json": web({}) });
    const out = specific(hook("FileChanged", "s2", { file_path: join(top, "apps/web/package.json"), event: "change" }));
    expect(live().map((row) => row.text)).not.toContain("In apps/web the auth provider is clerk");
    expect([...out.watchPaths!].sort()).toEqual([join(top, ".nvmrc"), join(top, "package-lock.json")]);
    const packet = specific(hook("UserPromptSubmit", "s2", { prompt: "which auth provider does apps/web use?" }));
    expect(packet.additionalContext ?? "").not.toMatch(/clerk/i);
  });

  test("a lockfile swapped mid-session: its unlink cites the new manager at once", async () => {
    await mined();
    rmSync(join(top, "package-lock.json"));
    write({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    const out = specific(hook("FileChanged", "s2", { file_path: join(top, "package-lock.json"), event: "unlink" }));
    expect(out.watchPaths).toContain(join(top, "pnpm-lock.yaml"));
    const packet = specific(hook("UserPromptSubmit", "s2", { prompt: "install the dependencies" }));
    expect(packet.additionalContext).toContain("The package manager is pnpm (from pnpm-lock.yaml");
    expect(packet.additionalContext).not.toContain("is npm");
  });

  test("a file no citation names changes nothing; read-only consent only names the list", async () => {
    await mined();
    const before = readCitations(store());
    hook("FileChanged", "s2", { file_path: join(top, "apps/web/app/login.ts"), event: "change" });
    expect(readCitations(store())).toEqual(before);
    write({ "apps/web/package.json": web({}) });
    process.env.EDEN_MEMORY = "readonly";
    const out = specific(hook("FileChanged", "s2", { file_path: join(top, "apps/web/package.json"), event: "change" }));
    expect(out.watchPaths).toHaveLength(3);
    expect(readCitations(store())).toEqual(before);
  });

  test("a payload with no file, or a file outside the repo, still answers with the list (fail open)", async () => {
    await mined();
    expect(specific(hook("FileChanged", "s2", {})).watchPaths).toHaveLength(3);
    expect(specific(hook("FileChanged", "s2", { file_path: "/etc/hosts", event: "change" })).watchPaths).toHaveLength(3);
  });
});

describe("delivery of mined facts", () => {
  test("the slot detector's seed brings the package manager to 'install the dependencies'", async () => {
    await mined();
    const packet = specific(hook("UserPromptSubmit", "s2", { prompt: "install the dependencies" })).additionalContext;
    expect(packet).toContain("The package manager is npm (from package-lock.json");
  });

  test("D5 for mined facts: the root's .nvmrc is not delivered where the prompt gives the folder its own value", async () => {
    await mined();
    hook("UserPromptSubmit", "s2", { prompt: "open apps/web/app/login.ts", prompt_id: "p1" });
    const said = hook("UserPromptSubmit", "s2", { prompt: "apps/web runs node 22.", prompt_id: "p2" });
    expect(specific(said).additionalContext ?? "").not.toContain("node version is 20");
    const cli = hook("UserPromptSubmit", "s3", { prompt: "which node version does packages/cli use?", prompt_id: "p3" });
    expect(specific(cli).additionalContext).toContain("The node version is 20 (from .nvmrc");
  });
});

describe("Updated: items outside a human Submit (A4 §5.2, D24)", () => {
  const swapLockfile = () => {
    rmSync(join(top, "package-lock.json"));
    write({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
  };

  test("SessionStart briefs a value that changed since the repo's last session, naming the old one", async () => {
    await mined();
    expect(specific(hook("UserPromptSubmit", "s1", { prompt: "install the dependencies" })).additionalContext).toContain(
      "The package manager is npm",
    );
    hook("SessionEnd", "s1", { reason: "other" });
    swapLockfile();
    await sleepCli(["--heavy", "--store", store()]);
    const brief = specific(hook("SessionStart", "s2", { source: "startup" })).additionalContext;
    expect(brief).toContain("Updated: The package manager is pnpm (was npm; from pnpm-lock.yaml");
    expect(specific(hook("UserPromptSubmit", "s2", { prompt: "install the dependencies" })).additionalContext ?? "").not.toContain(
      "pnpm",
    );
  });

  test("a value the last session was never given, or did not change, is no item", async () => {
    await mined();
    hook("UserPromptSubmit", "s1", { prompt: "install the dependencies" });
    hook("SessionEnd", "s1", { reason: "other" });
    expect(specific(hook("SessionStart", "s2", { source: "startup" })).additionalContext ?? "").not.toContain("Updated:");
  });

  test("a non-human Submit gets only the Updated: items of its own window", async () => {
    await mined();
    hook("UserPromptSubmit", "s1", { prompt: "install the dependencies" });
    expect(hook("UserPromptSubmit", "s1", { prompt: "<task-notification>done</task-notification>" })).toBeNull();
    swapLockfile();
    hook("FileChanged", "s1", { file_path: join(top, "package-lock.json"), event: "unlink" });
    const notice = specific(hook("UserPromptSubmit", "s1", { prompt: "<task-notification>tests passed</task-notification>" }));
    expect(notice.additionalContext).toContain("Updated: The package manager is pnpm (was npm;");
    expect(notice.additionalContext?.split("\n- ")).toHaveLength(2);
    expect(hook("UserPromptSubmit", "s1", { prompt: "<task-notification>again</task-notification>" })).toBeNull();
  });
});
