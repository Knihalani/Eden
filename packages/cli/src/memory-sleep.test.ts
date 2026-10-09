/** P0.6: the idle sleeper (D34, A4 §6): the repo store's full sleep, once its hooks have been quiet. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../../src/index";
import { memorySleepCli, noteRepoActivity, spawnIdleSleeper } from "./memory-sleep";

let dir = "";
let store = "";
const prev = { home: process.env.EDEN_HOME, idle: process.env.EDEN_SLEEP_IDLE };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-sleep-"));
  process.env.EDEN_HOME = join(dir, "home");
  store = join(dir, "store");
  const mem = openMemory({ dir: store, session: "s1", perRepo: true });
  mem.observe([{ role: "user", content: "We use postgres for the database. Never merge on Fridays.", src: "user" }]);
  mem.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_HOME", prev.home],
    ["EDEN_SLEEP_IDLE", prev.idle],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** What only the full sleep writes: its postings snapshot (`writeSleepPostings`). */
const slept = () => existsSync(join(store, "sleep-postings.jsonl"));

describe("D34: the idle sleeper", () => {
  test("it waits until the repo's hooks have been quiet for --after, and activity restarts the wait", async () => {
    noteRepoActivity(store);
    const started = Date.now();
    const touch = setTimeout(() => noteRepoActivity(store), 300);
    await memorySleepCli(["--idle", "--after", "0.5", "--store", store, "--session", "s1"]);
    clearTimeout(touch);
    expect(Date.now() - started).toBeGreaterThanOrEqual(750);
    expect(slept()).toBe(true);
    expect(existsSync(join(store, "sleep.pending"))).toBe(false);
  });

  test("a sleeper that finds another one named in sleep.pending leaves the store to it", async () => {
    noteRepoActivity(store);
    const claim = setTimeout(() => writeFileSync(join(store, "sleep.pending"), JSON.stringify({ pid: 1 })), 100);
    await memorySleepCli(["--idle", "--after", "0.3", "--store", store]);
    clearTimeout(claim);
    expect(slept()).toBe(false);
    expect(JSON.parse(readFileSync(join(store, "sleep.pending"), "utf8"))).toEqual({ pid: 1 });
  });

  test("without --idle it sleeps now; a missing store is left alone", async () => {
    await memorySleepCli(["--store", store, "--session", "s1"]);
    expect(slept()).toBe(true);
    await memorySleepCli(["--idle", "--after", "0", "--store", join(dir, "missing")]);
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });

  test("a hook starts a detached sleeper unless one is pending, and none while EDEN_SLEEP_IDLE is off", async () => {
    process.env.EDEN_SLEEP_IDLE = "off";
    spawnIdleSleeper(store, "s1");
    await Bun.sleep(400);
    expect(existsSync(join(store, "sleep.pending"))).toBe(false);
    process.env.EDEN_SLEEP_IDLE = "200";
    writeFileSync(join(store, "sleep.pending"), JSON.stringify({ pid: process.pid }));
    spawnIdleSleeper(store, "s1");
    await Bun.sleep(400);
    expect(slept()).toBe(false);
    rmSync(join(store, "sleep.pending"));
    spawnIdleSleeper(store, "s1");
    for (let waited = 0; waited < 10_000 && !slept(); waited += 100) await Bun.sleep(100);
    expect(slept()).toBe(true);
    for (let waited = 0; waited < 5_000 && existsSync(join(store, "sleep.pending")); waited += 100)
      await Bun.sleep(100);
    expect(existsSync(join(store, "sleep.pending"))).toBe(false);
  }, 20_000);
});
