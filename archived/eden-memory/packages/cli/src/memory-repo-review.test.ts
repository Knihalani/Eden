/**
 * P0.5's review probes, kept as regression tests (round 1): the migration's gate on what it derives, every writer on a
 * store some reader reads, the format rule for the wrap's store, concurrent sessions of one repo.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoIdentity, repoStoreDir, readableStore } from "../../../src/memory-repo";
import { openMemory } from "../../../src/index";
import { memoryHookResponse } from "./memory-hook";
import { importMemoryPath } from "./memory-import";

const CLI = join(import.meta.dir, "cli.ts");
const T0 = Date.parse("2026-09-20T10:00:00Z");
/** Synthetic GitHub-token shapes, built so no literal secret is committed. */
const TOKEN_A = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
const TOKEN_B = `ghp_${"Zy9Xw8Vu7Ts6".repeat(3)}`;
const AWS = `AKIA${"QWERTYUIOPASDFGH"}`;

let dir = "";
let eden = "";
let root = "";
let app = "";
const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME, now: process.env.EDEN_NOW };

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function jsonl(path: string, rows: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function migrate(args: string[]): { code: number; out: string } {
  const run = Bun.spawnSync(["bun", CLI, "memory", "migrate", ...args], {
    env: {
      ...process.env,
      HOME: dir,
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      EDEN_HOME: eden,
      EDEN_MEMORY_DIR: root,
      EDEN_NOW: String(T0),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode, out: run.stdout.toString() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-p05-probe-"));
  eden = join(dir, "eden");
  root = join(eden, "memory");
  app = join(dir, "app");
  mkdirSync(join(app, "src"), { recursive: true });
  writeFileSync(join(app, "src", "index.ts"), "export {};\n");
  git(app, "init", "-q", "-b", "main");
  git(app, "add", "-A");
  git(app, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  process.env.EDEN_MEMORY_DIR = root;
  process.env.EDEN_HOME = eden;
  delete process.env.EDEN_MEMORY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_MEMORY_DIR", prev.dir],
    ["EDEN_HOME", prev.home],
    ["EDEN_NOW", prev.now],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("migrate: secret_bytes = 0 in the new tree (A6 §4: migration still runs the gate)", () => {
  test("slot values two legacy sessions disagree on are not written raw into the new store's validity log", () => {
    jsonl(join(root, "s-one", "memories.jsonl"), [{ id: "a", text: `The deploy token is ${TOKEN_A}`, t: T0 - 2e5 }]);
    jsonl(join(root, "s-two", "memories.jsonl"), [{ id: "b", text: `The deploy token is ${TOKEN_B}`, t: T0 - 1e5 }]);
    mkdirSync(join(eden, "migrate"), { recursive: true });
    writeFileSync(join(eden, "migrate", "session-map.json"), JSON.stringify({ "s-one": app, "s-two": app }));
    expect(migrate(["--apply", "--json"]).code).toBe(0);
    const leaks = filesUnder(root).filter((path) => {
      const text = readFileSync(path, "utf8").toLowerCase();
      return text.includes(TOKEN_A.toLowerCase().slice(4)) || text.includes(TOKEN_B.toLowerCase().slice(4));
    });
    if (leaks.length) console.log(leaks.map((path) => `${path}:\n${readFileSync(path, "utf8")}`).join("\n"));
    expect(leaks).toEqual([]);
  });

  test("the root's validity log, copied into each repo, passes the gate too", () => {
    jsonl(join(root, "s-one", "memories.jsonl"), [{ id: "a", text: "The database is postgres", t: T0 - 1e5 }]);
    // A pre-P0.4 plugin logged a retraction's object as it was said.
    jsonl(join(root, "validity.jsonl"), [{ k: "retract", o: AWS.toLowerCase(), t: T0 - 2e5, w: ["key"] }]);
    mkdirSync(join(eden, "migrate"), { recursive: true });
    writeFileSync(join(eden, "migrate", "session-map.json"), JSON.stringify({ "s-one": app }));
    expect(migrate(["--apply", "--json"]).code).toBe(0);
    const leaks = filesUnder(root).filter((path) =>
      readFileSync(path, "utf8").toLowerCase().includes(AWS.toLowerCase()),
    );
    expect(leaks).toEqual([]);
  });
});

describe("D1: every writer of the memory root writes a store some reader reads", () => {
  test("`eden memory import` writes the rows into the store of the repo each record ran in", async () => {
    const transcript = join(dir, "t.jsonl");
    jsonl(transcript, [
      { type: "user", sessionId: "s-old", cwd: app, message: { role: "user", content: "The database is postgres." } },
      { type: "assistant", sessionId: "s-old", cwd: app, message: { role: "assistant", content: "Noted: postgres." } },
    ]);
    await importMemoryPath(transcript);
    // Before P0.5 the import landed in <root>/memories.jsonl, the wrap's store (processMemory with no session). Since
    // P0.5 the wrap and the hook read only <root>/repos/<key>/, and migrate calls <root>/memories.jsonl unmappable.
    const store = join(repoStoreDir(root, repoIdentity(app)!.key), "memories.jsonl");
    expect(existsSync(store) ? readFileSync(store, "utf8") : "").toContain("postgres");
  });
});

describe("EXECUTION §9: a reader never injects from a store of an unknown major", () => {
  test("a format.json whose major is not a known number is not readable", () => {
    const store = repoStoreDir(root, repoIdentity(app)!.key);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "format.json"), JSON.stringify({ major: "3" }));
    expect(readableStore(store)).toBe(false);
  });
});

describe("EXECUTION §9: the wrap's store follows the format rule too", () => {
  test("a per-repo store of an unknown major is neither read nor written", () => {
    const store = repoStoreDir(root, repoIdentity(app)!.key);
    // `before` stays open across the bump, as a long-lived wrap process would.
    const before = openMemory({ dir: store, perRepo: true });
    before.observe([{ role: "user", content: "The database is postgres." }]);
    writeFileSync(join(store, "format.json"), JSON.stringify({ major: 3 }));
    const rows = readFileSync(join(store, "memories.jsonl"), "utf8");
    const mem = openMemory({ dir: store, perRepo: true });
    const body = { messages: [{ role: "user", content: "what database do we use?" }] };
    expect(mem.injectBody(body)).toEqual(body);
    expect(before.injectBody(body)).toEqual(body);
    before.observe([{ role: "user", content: "The queue is rabbitmq." }]);
    before.close();
    mem.observe([{ role: "user", content: "The cache is redis." }]);
    mem.close();
    expect(readFileSync(join(store, "memories.jsonl"), "utf8")).toBe(rows);
  });

  test("a per-repo store this code opens says its format", () => {
    const store = repoStoreDir(root, repoIdentity(app)!.key);
    openMemory({ dir: store, perRepo: true }).close();
    expect(JSON.parse(readFileSync(join(store, "format.json"), "utf8"))).toEqual({ major: 2 });
  });
});

describe("D1: concurrent sessions of one repo share one store without losing rows", () => {
  test("24 sessions submitting at once each keep their row", async () => {
    const hook = join(import.meta.dir, "memory-hook.ts");
    const runs = Array.from({ length: 24 }, (_, n) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `const { memoryHookResponse } = await import(${JSON.stringify(hook)});
           memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-${n}", cwd: ${JSON.stringify(app)},
             prompt: "The service number ${n} is called zeta${n}x." });`,
        ],
        { env: { ...process.env, EDEN_MEMORY_DIR: root, EDEN_HOME: eden }, stdout: "ignore", stderr: "ignore" },
      ),
    );
    await Promise.all(runs.map((run) => run.exited));
    const store = repoStoreDir(root, repoIdentity(app)!.key);
    const text = [join(store, "memories.jsonl"), join(store, "pending.jsonl")]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const lost = Array.from({ length: 24 }, (_, n) => `zeta${n}x`).filter((value) => !text.includes(value));
    expect(lost).toEqual([]);
  }, 60_000);
});
