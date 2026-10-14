/**
 * P3.4: D34's heavy tier. The idle sleeper mines the repo's files (D8) once the store has been quiet for 30 minutes
 * (`EDEN_SLEEP_HEAVY`), by the memory clock; `--after 0` runs at once what the quiet time allows; `--heavy`
 * (SessionStart's detached launch) mines at once; and `eden sleep` in a repo with no store gives it one, so a first
 * session meets the repo's facts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openMemory, storeRows, superseded } from "../../../src/index";
import { readCitations } from "../../../src/memory-citations";
import { repoIdentity, repoStoreDir } from "../../../src/memory-repo";
import { buildCatalog, readCatalog } from "../../../src/memory-scopes";
import { noteRepoActivity, sleepCli, sleepHeavyMs } from "./memory-sleep";

const T0 = Date.parse("2026-10-14T09:00:00Z");
const MIN = 60_000;
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_NOW", "EDEN_SLEEP_HEAVY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const cwd = process.cwd();

let dir = "";
let top = "";
let store = "";

function git(...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: top,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-sleep-heavy-")));
  top = join(dir, "repo");
  const files = {
    "package.json": JSON.stringify({ name: "demo", workspaces: ["apps/*"] }),
    "package-lock.json": "{}",
    "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { "@clerk/nextjs": "5" } }),
    "apps/web/app/login.ts": "export {};\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "c");
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_NOW = String(T0);
  delete process.env.EDEN_SLEEP_HEAVY;
  store = repoStoreDir(process.env.EDEN_MEMORY_DIR, repoIdentity(top)!.key);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A store as a session leaves it: its catalog, and its hooks' last activity at `minutes` after T0. */
function sessionStore(minutes = 0): void {
  buildCatalog(store, top);
  const mem = openMemory({ dir: store, session: "s1", perRepo: true });
  mem.observe([{ role: "user", content: "Never merge on Fridays.", src: "user" }]);
  mem.close();
  process.env.EDEN_NOW = String(T0 + minutes * MIN);
  noteRepoActivity(store);
}

const mined = () =>
  storeRows(join(store, "memories.jsonl"))
    .filter((row) => row.cite && !superseded(row))
    .map((row) => row.text);
const slept = () => existsSync(join(store, "sleep-postings.jsonl"));

describe("D34's heavy tier", () => {
  test("--after 0 mines once the store has been quiet 30 minutes by the memory clock, not before", async () => {
    sessionStore();
    process.env.EDEN_NOW = String(T0 + 10 * MIN);
    await sleepCli(["--idle", "--after", "0", "--store", store]);
    expect(slept()).toBe(true);
    expect(mined()).toEqual([]);
    process.env.EDEN_NOW = String(T0 + 45 * MIN);
    await sleepCli(["--idle", "--after", "0", "--store", store]);
    expect(mined()).toEqual(["The package manager is npm", "In apps/web the auth provider is clerk"]);
    expect(readCitations(store).map((c) => c.files.join(" "))).toEqual(["package-lock.json", "apps/web/package.json"]);
    expect(existsSync(join(store, "sleep.pending"))).toBe(false);
  });

  test("a waiting sleeper mines when the heavy quiet time passes; EDEN_SLEEP_HEAVY=off never does", async () => {
    sessionStore();
    process.env.EDEN_NOW = "";
    noteRepoActivity(store);
    process.env.EDEN_SLEEP_HEAVY = "600";
    await sleepCli(["--idle", "--after", "0.2", "--store", store]);
    expect(mined()).toHaveLength(2);
    rmSync(join(store, "memories.jsonl"));
    rmSync(join(store, "citations.json"));
    process.env.EDEN_SLEEP_HEAVY = "off";
    noteRepoActivity(store);
    const started = Date.now();
    await sleepCli(["--idle", "--after", "0.2", "--store", store]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(mined()).toEqual([]);
  }, 20_000);

  test("--heavy mines at once, whatever the quiet time", async () => {
    sessionStore();
    await sleepCli(["--heavy", "--store", store]);
    expect(mined()).toHaveLength(2);
    expect(slept()).toBe(false);
  });

  test("sleepHeavyMs", () => {
    expect([undefined, "", "600", "off", "0", "soon"].map((raw) => sleepHeavyMs(raw))).toEqual([
      30 * MIN,
      30 * MIN,
      600,
      0,
      0,
      30 * MIN,
    ]);
  });
});

describe("eden sleep in a repo with no store", () => {
  test("gives the repo its store and catalog, sleeps and mines", async () => {
    process.chdir(join(top, "apps", "web"));
    expect(existsSync(store)).toBe(false);
    await sleepCli(["--idle", "--after", "0"]);
    expect(readCatalog(store)?.scopes).toEqual(["", "apps/web"]);
    expect(JSON.parse(readFileSync(join(store, "format.json"), "utf8"))).toEqual({ major: 2 });
    expect(mined()).toEqual(["The package manager is npm", "In apps/web the auth provider is clerk"]);
  });

  test("outside a repo it creates nothing", async () => {
    process.chdir(dir);
    await sleepCli(["--idle", "--after", "0"]);
    expect(existsSync(join(process.env.EDEN_MEMORY_DIR!, "repos"))).toBe(false);
  });
});
