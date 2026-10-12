/**
 * P3.1 code review round 1's probes at the hook process and the CLI, kept as regression tests: a manifest linked to a
 * device does not hang a turn's end; writes a deeper scope owns do not rebuild for a waiting folder; a scope rows
 * still carry can be forgotten after its folder is gone. Plus the round's other findings: a PostToolUse write
 * rebuilds as a batch's does, SessionEnd builds no catalog, and a batch writing no manifest runs no git.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HOOK = join(import.meta.dir, "../../../plugins/eden-memory/scripts/hook.ts");
const CLI = join(import.meta.dir, "cli.ts");
let dir = "";
let top = "";

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function put(base: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
}

const env = (more: Record<string, string> = {}) => ({
  ...process.env,
  EDEN_MEMORY_DIR: join(dir, "memory"),
  EDEN_HOME: join(dir, "home"),
  ...more,
});

function hook(payload: Record<string, unknown>, stage?: string, more: Record<string, string> = {}, timeoutMs = 10_000) {
  const started = performance.now();
  const run = spawnSync("bun", [HOOK, ...(stage ? [stage] : [])], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: env(more),
    timeout: timeoutMs,
  });
  return { status: run.status, signal: run.signal, out: run.stdout, err: run.stderr, ms: performance.now() - started };
}

function wideEvents(): Record<string, unknown>[] {
  const logs = join(dir, "memory", "hook.log.d");
  return readdirSync(logs)
    .sort()
    .flatMap((name) => readFileSync(join(logs, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-p31-probe-")));
  top = join(dir, "repo");
  put(top, { "package.json": JSON.stringify({ name: "r", workspaces: ["packages/*", "tools", "tools/*"] }) });
  put(top, { "packages/a/package.json": JSON.stringify({ name: "a" }), "packages/a/i.js": "" });
  git(top, "init", "-q", "-b", "main");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a hostile or odd tree fails open in time", () => {
  test("a manifest that is a link to /dev/zero does not hang the turn's end", () => {
    put(top, { "packages/b/i.js": "" });
    symlinkSync("/dev/zero", join(top, "packages/b/package.json"));
    const run = hook({ hook_event_name: "Stop", session_id: "p1", cwd: top }, "stop-sleep");
    expect(run.signal).toBeNull();
    expect([run.status, run.out, run.err]).toEqual([0, "", ""]);
    expect(run.ms).toBeLessThan(5_000);
  });
});

describe("waiting folders", () => {
  test("writes under a waiting folder that a deeper scope owns rebuild once at most", () => {
    put(top, {
      "tools/package.json": JSON.stringify({ name: "tools" }),
      "tools/a/package.json": JSON.stringify({ name: "ta" }),
      "tools/a/x.js": "",
    });
    hook({ hook_event_name: "Stop", session_id: "p2", cwd: top }, "stop-sleep");
    for (let i = 0; i < 3; i++) {
      put(top, { [`tools/a/f${i}.js`]: "" });
      hook({
        hook_event_name: "PostToolBatch",
        session_id: "p2",
        cwd: top,
        tool_calls: [
          { tool_name: "Write", tool_input: { file_path: join(top, `tools/a/f${i}.js`) }, tool_response: "ok" },
        ],
      });
    }
    const rebuilt = wideEvents().filter((event) => event.ev === "PostToolBatch" && event.catalog !== undefined);
    expect(rebuilt.length).toBe(0);
  });
});

describe("eden memory forget --all-in", () => {
  test("a scope rows still carry can be forgotten after its folder is gone", () => {
    const remember = spawnSync("bun", [CLI, "memory", "remember", "--jsonl", "-"], {
      cwd: top,
      input: JSON.stringify({ text: "Never merge pull requests yourself.", cwd: top, scope: "packages/a" }),
      encoding: "utf8",
      env: env(),
    });
    expect(JSON.parse(remember.stdout)).toEqual({ remembered: 1 });
    rmSync(join(top, "packages/a"), { recursive: true, force: true });
    const forget = spawnSync("bun", [CLI, "memory", "forget", "--all-in", "packages/a"], {
      cwd: top,
      encoding: "utf8",
      env: env(),
    });
    expect([forget.status, forget.stdout.trim()]).toEqual([0, "forgot 1 keyed row in packages/a"]);
  });
});

describe("the round's other findings", () => {
  const scopesJson = () =>
    readdirSync(join(dir, "memory", "repos")).map((key) => join(dir, "memory", "repos", key, "scopes.json"));
  const write = (path: string) => ({
    tool_name: "Write",
    tool_input: { file_path: join(top, path) },
    tool_response: "ok",
  });

  test("a PostToolUse write of a manifest rebuilds the catalog, as a batch's does", () => {
    hook({ hook_event_name: "Stop", session_id: "p4", cwd: top }, "stop-sleep");
    put(top, { "packages/b/package.json": JSON.stringify({ name: "b" }), "packages/b/i.js": "" });
    hook({ hook_event_name: "PostToolUse", session_id: "p4", cwd: top, ...write("packages/b/package.json") });
    expect(JSON.parse(readFileSync(scopesJson()[0]!, "utf8")).scopes).toEqual(["", "packages/a", "packages/b"]);
  });

  test("SessionEnd builds no catalog; a Stop does", () => {
    hook({ hook_event_name: "SessionEnd", session_id: "p5", cwd: top });
    expect(scopesJson().some((path) => existsSync(path))).toBe(false);
    hook({ hook_event_name: "Stop", session_id: "p5", cwd: top }, "stop-sleep");
    expect(scopesJson().some((path) => existsSync(path))).toBe(true);
  });

  test("a batch writing no manifest runs no git; one writing a manifest does", () => {
    hook({ hook_event_name: "Stop", session_id: "p6", cwd: top }, "stop-sleep");
    const bin = join(dir, "bin");
    const calls = join(dir, "git-calls");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> "${calls}"\nexec "${Bun.which("git")}" "$@"\n`, {
      mode: 0o755,
    });
    const path = { PATH: `${bin}:${process.env.PATH}` };
    hook(
      { hook_event_name: "PostToolBatch", session_id: "p6", cwd: top, tool_calls: [write("packages/a/i.js")] },
      undefined,
      path,
    );
    expect(existsSync(calls)).toBe(false);
    hook(
      { hook_event_name: "PostToolBatch", session_id: "p6", cwd: top, tool_calls: [write("package.json")] },
      undefined,
      path,
    );
    expect(readFileSync(calls, "utf8")).toContain("ls-files");
  });
});
