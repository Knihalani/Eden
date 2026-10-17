/**
 * P3.5 at the hook (D5, D23, A4 §2, §5.5): a Submit at a folder with its own value of a slot is not given the root's
 * (cascade with override), and a PostToolBatch's first touch of a scope in this epoch delivers that scope's slot
 * facts, at most 2, once, as `deliver.batch` allows (X7: shadow writes the shadow ledger and prints nothing; off
 * records nothing).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GistStore } from "../../../src/gist-store";
import { recordSlotChanges } from "../../../src/memory-validity";
import { memoryHookResponse } from "./memory-hook";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const DAY = 86_400_000;
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_BATCH"] as const;
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

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-hook-cascade-")));
  top = join(dir, "repo");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "demo", workspaces: ["apps/*", "packages/*"] }),
    "README.md": "# demo\n",
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "apps/web/app/login.ts": "export function login() {}\n",
    "packages/cli/package.json": JSON.stringify({ name: "cli" }),
    "packages/cli/src/index.ts": "export function main() {}\n",
    "packages/cli/src/login.ts": "export function login() {}\n",
    "apps/api/package.json": JSON.stringify({ name: "api" }),
    "apps/api/src/index.ts": "export function api() {}\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "c");
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  process.env.EDEN_FLAG_DELIVER_BATCH = "on";
  delete process.env.EDEN_MEMORY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const win = (session: string) => join(process.env.EDEN_MEMORY_DIR!, "windows", session);

function tick(ms = 60_000): void {
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + ms);
}

function hook(event: string, session: string, fields: Record<string, unknown> = {}): Record<string, unknown> | null {
  const out = memoryHookResponse({ hook_event_name: event, session_id: session, cwd: top, ...fields });
  tick(1_000);
  return out;
}

const context = (out: Record<string, unknown> | null) =>
  (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";

function submit(session: string, prompt: string, id: string): string {
  return context(hook("UserPromptSubmit", session, { prompt, prompt_id: id }));
}

let calls = 0;
function read(session: string, ...files: string[]): Record<string, unknown> | null {
  calls++;
  return hook("PostToolBatch", session, {
    prompt_id: `p-${session}`,
    tool_calls: files.map((file, n) => ({
      tool_name: "Read",
      tool_use_id: `t${calls}-${n}`,
      tool_input: { file_path: join(top, file) },
      tool_response: "1\t//",
    })),
  });
}

/** An earlier session states facts, then a day passes. */
function plant(...facts: string[]): void {
  hook("SessionStart", "s-facts", { source: "startup" });
  facts.forEach((fact, n) => {
    submit("s-facts", fact, `f${n}`);
    tick();
  });
  hook("SessionEnd", "s-facts", { reason: "other" });
  tick(DAY);
}

/** The wide events of an event, from the day files (`hook.log.d`). */
function events(name: string): Record<string, unknown>[] {
  const days = join(process.env.EDEN_MEMORY_DIR!, "hook.log.d");
  return readdirSync(days)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .flatMap((file) => readFileSync(join(days, file), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.ev === name);
}

const records = (session: string, file: string) =>
  existsSync(join(win(session), file))
    ? readFileSync(join(win(session), file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

describe("D5 at a Submit: cascade with override (A5 `cascade`)", () => {
  beforeEach(() => {
    process.env.EDEN_FLAG_DELIVER_BATCH = "off";
    plant("We use node 20 across the repo.", "apps/web runs node 22.");
    hook("SessionStart", "s1", { source: "startup" });
  });

  test("apps/web, which has its own value, is not given the root's; packages/cli and the root are", () => {
    read("s1", "apps/web/app/login.ts");
    const web = submit("s1", "which node version should apps/web use?", "q1");
    expect(web).not.toContain("node 20");
    read("s1", "packages/cli/src/index.ts");
    expect(submit("s1", "which node version should packages/cli use?", "q2")).toContain("node 20");
  });

  test("a turn reading both folders is not given it: a bullet naming no folder would be read as both", () => {
    read("s1", "apps/web/app/login.ts", "packages/cli/src/index.ts");
    expect(submit("s1", "which node version do these use?", "q1")).not.toContain("node 20");
  });
});

describe("A4 §5.5: a PostToolBatch's first touch of a scope", () => {
  test("delivers that scope's slot facts once, at the batch that first reads it", () => {
    plant("packages/cli has no auth, and its database is sqlite.");
    hook("SessionStart", "s1", { source: "startup" });
    const first = read("s1", "packages/cli/src/index.ts");
    expect(first?.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolBatch" });
    expect(context(first)).toContain("packages/cli has no auth, and its database is sqlite");
    expect(read("s1", "packages/cli/src/login.ts")).toBeNull();
    expect(events("PostToolBatch").map((event) => event.touch)).toEqual([1, undefined]);
  });

  test("the root is no new scope; a folder with no fact of its own delivers nothing, not its ancestor's", () => {
    plant("We use node 20 across the repo.");
    hook("SessionStart", "s1", { source: "startup" });
    expect(read("s1", "README.md", "package.json")).toBeNull();
    expect(read("s1", "apps/web/app/login.ts")).toBeNull();
    expect(events("PostToolBatch").map((event) => event.touch)).toEqual([undefined, 1]);
  });

  test("at most 2 items, newest first", () => {
    plant(
      "packages/cli has no auth.",
      "packages/cli's database is sqlite.",
      "packages/cli uses vitest as its test runner.",
    );
    hook("SessionStart", "s1", { source: "startup" });
    const packet = context(read("s1", "packages/cli/src/index.ts"));
    expect(packet).toContain("vitest");
    expect(packet).toContain("sqlite");
    expect(packet).not.toContain("no auth");
  });

  test("what the window was already given is not given again; a compaction makes every scope new again", () => {
    plant("packages/cli has no auth, and its database is sqlite.");
    hook("SessionStart", "s1", { source: "startup" });
    expect(submit("s1", "which database does packages/cli use?", "q1")).toContain("sqlite");
    expect(read("s1", "packages/cli/src/index.ts")).toBeNull();
    hook("SessionStart", "s1", { source: "compact" });
    expect(context(read("s1", "packages/cli/src/index.ts"))).toContain("sqlite");
  });

  test("the scope's own value is delivered, never the root's value it overrides", () => {
    plant("packages/cli runs node 22.", "We use node 20 across the repo.");
    hook("SessionStart", "s1", { source: "startup" });
    const packet = context(read("s1", "packages/cli/src/index.ts"));
    expect(packet).toContain("node 22");
    expect(packet).not.toContain("node 20");
  });

  test("each window has its own first touches: a subagent's batch, then the main thread's (D2)", () => {
    plant("packages/cli has no auth, and its database is sqlite.");
    hook("SessionStart", "s1", { source: "startup" });
    const child = hook("PostToolBatch", "s1", {
      agent_id: "a1",
      agent_type: "general-purpose",
      tool_calls: [
        {
          tool_name: "Read",
          tool_use_id: "c1",
          tool_input: { file_path: join(top, "packages/cli/src/index.ts") },
          tool_response: "1\t//",
        },
      ],
    });
    expect(context(child)).toContain("sqlite");
    expect(existsSync(join(process.env.EDEN_MEMORY_DIR!, "windows", "s1--a1", "delivery.log"))).toBe(true);
    expect(context(read("s1", "packages/cli/src/index.ts"))).toContain("sqlite");
  });

  test("X7: shadow writes the shadow ledger and prints nothing; off records nothing", () => {
    plant("packages/cli has no auth, and its database is sqlite.");
    process.env.EDEN_FLAG_DELIVER_BATCH = "shadow";
    hook("SessionStart", "s1", { source: "startup" });
    expect(read("s1", "packages/cli/src/index.ts")).toBeNull();
    expect(records("s1", "delivery.shadow.log").some((record) => record.k === "deliver")).toBe(true);
    expect(records("s1", "delivery.log").some((record) => record.k === "deliver")).toBe(false);
    process.env.EDEN_FLAG_DELIVER_BATCH = "off";
    hook("SessionStart", "s2", { source: "startup" });
    expect(read("s2", "packages/cli/src/index.ts")).toBeNull();
    expect(records("s2", "delivery.log")).toEqual([]);
    expect(records("s2", "delivery.shadow.log")).toEqual([]);
  });

  test("read-only consent delivers and records nothing", () => {
    plant("packages/cli has no auth, and its database is sqlite.");
    process.env.EDEN_MEMORY = "read-only";
    expect(read("s1", "packages/cli/src/index.ts")).toBeNull();
    expect(records("s1", "delivery.log")).toEqual([]);
  });
});

describe("SessionStart(compact)'s gists (P3.3's follow-up)", () => {
  /** A session's gist naming no folder, then the package manager ended in packages/cli only. */
  function gistThenEnded(): void {
    process.env.EDEN_FLAG_DELIVER_BATCH = "off";
    hook("SessionStart", "s1", { source: "startup" });
    const repos = join(process.env.EDEN_MEMORY_DIR!, "repos");
    const store = join(repos, readdirSync(repos)[0]!);
    new GistStore(store).put("The package manager is pnpm.", "s1", Number(process.env.EDEN_NOW));
    tick();
    recordSlotChanges(store, [{ slot: "pkg.manager", value: "pnpm", typed: "pnpm", scope: "packages/cli" }]);
    tick();
  }

  test("a line naming no folder does not yield to a value ended only in a folder the window is not in", () => {
    gistThenEnded();
    read("s1", "apps/web/app/login.ts");
    expect(context(hook("SessionStart", "s1", { source: "compact" }))).toContain("The package manager is pnpm");
  });

  test("it yields where the window reads that folder", () => {
    gistThenEnded();
    read("s1", "packages/cli/src/index.ts");
    expect(context(hook("SessionStart", "s1", { source: "compact" }))).not.toContain("pnpm");
  });
});

describe("SessionStart's pins for the likely scope (A4 §5.2; P3.2's follow-up)", () => {
  test("a pin at a folder is briefed only when the repo's last session worked there; the root's always", () => {
    process.env.EDEN_FLAG_DELIVER_BATCH = "off";
    plant("Never force-push.", "Never edit packages/cli/migrations by hand.");
    const first = context(hook("SessionStart", "s2", { source: "startup" }));
    expect(first).toContain("force-push");
    expect(first).not.toContain("migrations");
    read("s2", "packages/cli/src/index.ts");
    hook("SessionEnd", "s2", { reason: "other" });
    const next = context(hook("SessionStart", "s3", { source: "startup" }));
    expect(next).toContain("force-push");
    expect(next).toContain("migrations");
  });

  test("a last session whose window is gone leaves no pin out", () => {
    process.env.EDEN_FLAG_DELIVER_BATCH = "off";
    hook("SessionStart", "s0", { source: "startup" });
    submit("s0", "Never edit packages/cli/migrations by hand.", "q1");
    rmSync(join(process.env.EDEN_MEMORY_DIR!, "windows", "s0"), { recursive: true, force: true });
    expect(context(hook("SessionStart", "s1", { source: "startup" }))).toContain("migrations");
  });
});

describe("review round 1's probes", () => {
  /** A session that reads a folder, then states facts there, then ends; a day passes. */
  function plantAt(file: string, ...facts: string[]): void {
    hook("SessionStart", "s-at", { source: "startup" });
    read("s-at", file);
    facts.forEach((fact, n) => {
      submit("s-at", fact, `a${n}`);
      tick();
    });
    hook("SessionEnd", "s-at", { reason: "other" });
    tick(DAY);
  }

  test("a split statement's root part reaches the root and a sibling, by its own value (D5: its scope and below)", () => {
    process.env.EDEN_FLAG_DELIVER_BATCH = "off";
    plantAt("apps/web/app/login.ts", "We use pnpm and vitest.");
    hook("SessionStart", "s1", { source: "startup" });
    const atRoot = submit("s1", "should I install the deps with pnpm or npm?", "q1");
    expect(atRoot).toContain("Package manager: pnpm");
    expect(atRoot).not.toContain("vitest");
    hook("SessionStart", "s2", { source: "startup" });
    read("s2", "packages/cli/src/index.ts");
    const atCli = submit("s2", "in packages/cli which package manager do we use? pnpm or npm?", "q2");
    expect(atCli).toContain("pnpm");
    expect(atCli).not.toContain("vitest");
  });

  test("a compaction does not brief a legacy value the folder the window reads has since replaced", () => {
    process.env.EDEN_FLAG_DELIVER_BATCH = "off";
    hook("SessionStart", "s0", { source: "startup" });
    read("s0", "apps/web/app/login.ts");
    submit("s0", "The cache is Redis.", "q0");
    hook("SessionEnd", "s0", { reason: "other" });
    tick(DAY);
    hook("SessionStart", "s1", { source: "startup" });
    read("s1", "apps/web/app/login.ts");
    submit("s1", "The cache is Memcached.", "q1");
    hook("Stop", "s1", {});
    tick();
    read("s1", "apps/web/app/login.ts");
    const packet = context(hook("SessionStart", "s1", { source: "compact" }));
    expect(packet).toContain("Memcached");
    expect(packet).not.toContain("Redis");
  });

  test("a batch touching three new scopes delivers for two; the third is new at its next batch", () => {
    plant("packages/cli has no auth.", "apps/web uses Clerk for auth.", "apps/api's database is postgres.");
    hook("SessionStart", "s1", { source: "startup" });
    const first = context(read("s1", "packages/cli/src/index.ts", "apps/web/app/login.ts", "apps/api/src/index.ts"));
    expect(first).not.toContain("postgres");
    expect(context(read("s1", "apps/api/src/index.ts"))).toContain("postgres");
  });

  test("a batch naming no scope below the root reads no ledger and records nothing", () => {
    hook("SessionStart", "s1", { source: "startup" });
    read("s1", "README.md");
    expect(records("s1", "delivery.log").some((record) => record.k === "touch")).toBe(false);
  });
});
