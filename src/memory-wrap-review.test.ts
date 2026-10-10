/**
 * P1.1 review round 2 probe (place in src/): a restarted wrap keeps the cached prefix of a conversation that has run
 * for more than an hour. The in-process memo forgets a turn unused for an hour (`WrapTurns.tail` refreshes `used` on
 * every request), so `tails.jsonl` must not drop a tail that is still in use only because it was written an hour ago.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type AgentMemory } from "./index";

type Message = Record<string, unknown>;

const ENV = ["EDEN_HOME", "EDEN_MEMORY_DIR", "EDEN_MEMORY", "EDEN_SLEEP_EVERY", "EDEN_SLEEP_IDLE", "EDEN_KNOW"];
let saved: Record<string, string | undefined> = {};
let home = "";
let mem: AgentMemory;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), "eden-wrap-review-"));
  Object.assign(process.env, {
    EDEN_HOME: home,
    EDEN_MEMORY_DIR: join(home, "memory"),
    EDEN_MEMORY: "on",
    EDEN_SLEEP_EVERY: "0",
    EDEN_SLEEP_IDLE: "0",
    EDEN_KNOW: "0",
  });
  mem = openMemory({ dir: join(home, "store") });
});

afterEach(() => {
  setSystemTime();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const user = (content: unknown): Message => ({ role: "user", content });
const assistant = (content: unknown): Message => ({ role: "assistant", content });
const MIN = 60_000;

test("a restart after 75 minutes of a live conversation keeps the first turn's packet on its message", () => {
  const t0 = Date.parse("2026-10-10T12:00:00Z");
  setSystemTime(new Date(t0));
  mem.inject([user("We use Clerk for auth in apps/web.")]);
  const turn1 = [user("Add a login check with the auth provider in apps/web.")];
  const sent1 = mem.inject(turn1);
  setSystemTime(new Date(t0 + 50 * MIN));
  const turn2 = [...turn1, assistant("Added."), user("Now run the tests.")];
  const sent2 = mem.inject(turn2);
  expect(sent2[0]).toEqual(sent1[0]);
  setSystemTime(new Date(t0 + 70 * MIN));
  const turn3 = [...turn2, assistant("Tests pass."), user("Commit it.")];
  const sent3 = mem.inject(turn3);
  // The running process still has turn 1's tail (used 20 minutes ago).
  expect(sent3[0]).toEqual(sent1[0]);
  setSystemTime(new Date(t0 + 75 * MIN));
  const turn4 = [...turn3, assistant("Committed."), user("Push it.")];
  const restarted = openMemory({ dir: join(home, "store") }).inject(turn4);
  expect(restarted[0]).toEqual(sent1[0]);
});
