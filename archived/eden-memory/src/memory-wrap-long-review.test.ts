/**
 * P1.1 review round 3 probe (place in src/; passes on 815bf4ac6): a wrap conversation in steady use for over 2.5 h
 * (a turn every 4 minutes), then a restart: every earlier turn keeps the packet it was sent with.
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
  home = mkdtempSync(join(tmpdir(), "eden-wrap-long-"));
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

test("steady use for 160 minutes, then a restart: every turn keeps its packet on its message", () => {
  const t0 = Date.parse("2026-10-10T12:00:00Z");
  setSystemTime(new Date(t0));
  for (let i = 0; i < 8; i++) mem.inject([user(`Fact ${i}: the service-${i} port is ${4000 + i} in apps/web.`)]);
  mem.inject([user("We use Clerk for auth in apps/web.")]);
  let messages: Message[] = [];
  const sent: unknown[] = [];
  for (let turn = 0; turn < 40; turn++) {
    setSystemTime(new Date(t0 + turn * 4 * MIN));
    const prompt = user(`Turn ${turn}: check the service-${turn % 8} port and the auth provider in apps/web.`);
    messages = [...messages, ...(turn ? [assistant(`Done ${turn}.`)] : []), prompt];
    sent.push(mem.inject(messages)[2 * turn]);
  }
  setSystemTime(new Date(t0 + 165 * MIN));
  const restarted = openMemory({ dir: join(home, "store") }).inject([...messages, assistant("ok"), user("Push it.")]);
  for (let turn = 0; turn < 40; turn++) expect(restarted[2 * turn]).toEqual(sent[turn]);
});
