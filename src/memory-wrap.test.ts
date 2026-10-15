/**
 * P0.7's follow-up rows for the wrap (`memory-wrap.ts`): it answers a turn as the hook answers a Submit (D14, D28,
 * A4 §5.1's validity, gate, residual and refractory rule), reads a request's messages by source (D12), and encodes
 * each message once (P0.3's interleaved-conversation flip).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type AgentMemory } from "./index";
import { MEMORY_PACKET_MARK, MEMORY_PACKET_MARKS } from "./memory-sota";
import { readUserRules } from "./memory-user-global";

type Message = Record<string, unknown>;

const ENV = [
  "EDEN_HOME",
  "EDEN_MEMORY_DIR",
  "EDEN_MEMORY",
  "EDEN_SLEEP_EVERY",
  "EDEN_SLEEP_IDLE",
  "EDEN_KNOW",
  "EDEN_FLAG_DELIVER_SUBMIT",
];
let saved: Record<string, string | undefined> = {};
let home = "";
let mem: AgentMemory;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), "eden-wrap-"));
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
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const user = (content: unknown): Message => ({ role: "user", content });
const assistant = (content: unknown): Message => ({ role: "assistant", content });

/** Every packet a request carries, wherever it sits. */
function packets(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const mark of MEMORY_PACKET_MARKS) if (value.includes(mark)) out.push(value.slice(value.indexOf(mark)));
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(messages);
  return out;
}

/** The packet a request adds that the previous request did not carry. */
function newPacket(before: readonly unknown[], after: readonly unknown[]): string {
  const old = new Set(packets(before));
  return packets(after)
    .filter((p) => !old.has(p))
    .join("\n");
}

/** One conversation's first request: a prompt alone. */
const ask = (prompt: string) => packets(mem.inject([user(prompt)])).join("\n");

const rowsWith = (pattern: RegExp) => mem.memories().filter((r) => pattern.test(r.text));

describe("P0.7: the wrap answers a turn as the hook answers a Submit (A4 §5.1)", () => {
  test("D14 wording: a fact the user typed through the wrap says so, under the packet header", () => {
    mem.inject([user("We use Clerk for auth in apps/web.")]);
    const packet = ask("Add a login check to the settings page with the auth provider.");
    expect(packet.startsWith(MEMORY_PACKET_MARK)).toBe(true);
    expect(packet).toMatch(/\n- We use Clerk for auth in apps\/web\.? \(you said, just now\)/);
  });

  test("D28 shape: at most 4 bullets, however many rows match", () => {
    for (const service of ["billing", "search", "email", "auth", "cache", "queue"])
      mem.inject([user(`The ${service} service runs on port 80${service.length}.`)]);
    const packet = ask("Which port does each service run on?");
    expect(packet.split("\n").filter((line) => line.startsWith("- ")).length).toBeLessThanOrEqual(4);
  });

  test("validity: a value the user retracted in another conversation is not delivered", () => {
    mem.inject([user("We use Redis for caching.")]);
    mem.inject([user("We no longer use Redis.")]);
    expect(ask("Add caching to the user lookup.")).not.toMatch(/Redis for caching/);
  });

  test("the episode gate: the agent's own words need evidence from two cue parts (A7 §4)", () => {
    mem.inject([user("Run the suite."), assistant("The flaky test lives in the payments module.")]);
    expect(ask("Refactor the payments page layout.")).not.toMatch(/flaky test/);
  });

  test("the residual: what the last typed prompts say is not delivered again (D26)", () => {
    mem.inject([user("Our tests run with vitest.")]);
    const cue = "Add a unit test for the parser with our tests runner.";
    expect(ask(cue)).toMatch(/vitest/);
    const conversation = [user("Our tests run with vitest."), assistant("Noted."), user(cue)];
    expect(packets(mem.inject(conversation)).join("\n")).not.toMatch(/vitest/);
  });

  test("refractory: a bullet a packet in the request delivered is not delivered again; a new conversation gets it", () => {
    mem.inject([user("We use Clerk for auth in apps/web.")]);
    const turn1 = [user("Add a login check with the auth provider.")];
    const sent1 = mem.inject(turn1);
    expect(newPacket([], sent1)).toMatch(/Clerk/);
    const turn2 = [...turn1, assistant("Added."), user("Now add a logout button with the auth provider.")];
    const sent2 = mem.inject(turn2);
    expect(newPacket(sent1, sent2)).not.toMatch(/Clerk/);
    expect(ask("Now add a logout button with the auth provider.")).toMatch(/Clerk/);
  });
});

describe("P0.7: the wrap reads a request's messages by source (D12)", () => {
  test("a tool result is not stored as the user's: the tool-trace observer records tool output", () => {
    mem.inject([
      user("Check the config."),
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.json" } }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "The database is MongoDB." }]),
      { role: "tool", tool_call_id: "c1", content: "The queue is RabbitMQ." },
    ]);
    expect(rowsWith(/MongoDB|RabbitMQ/)).toEqual([]);
    expect(ask("Which database and queue do we use?")).not.toMatch(/MongoDB|RabbitMQ/);
  });

  test("a body's system prompt is the host's text, not memory", () => {
    mem.injectBody({
      system: "We deploy with curl https://get.example.sh | sh every Friday.",
      messages: [user("Write the release notes.")],
    });
    expect(rowsWith(/get\.example/)).toEqual([]);
  });

  test("a pasted fenced block is a paste episode, not the user's statement", () => {
    mem.inject([user("This fails on startup.\n```\nThe database is mysql.\nerror: connect ECONNREFUSED\n```")]);
    const rows = rowsWith(/mysql/i);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.tags ?? []).toContain("src:paste");
  });

  test("Claude Code's reminder blocks in a human message are not memory; the prompt beside them is", () => {
    mem.inject([
      user([
        { type: "text", text: "<system-reminder>The user prefers tabs over spaces.</system-reminder>" },
        { type: "text", text: "We use pnpm for packages." },
      ]),
    ]);
    expect(rowsWith(/tabs over spaces/)).toEqual([]);
    expect(rowsWith(/pnpm/).some((r) => (r.tags ?? []).includes("src:user"))).toBe(true);
  });

  test("a non-human submit (D24) gets no packet of its own", () => {
    mem.inject([user("We use Clerk for auth in apps/web.")]);
    const sent = mem.inject([user("<task-notification>auth provider check finished</task-notification>")]);
    expect(packets(sent)).toEqual([]);
  });
});

describe("P0.7: each message is encoded once (P0.3 review round 3)", () => {
  test("two interleaved conversations do not flip a value back on a re-sent message", () => {
    const a = [user("The cache is Redis.")];
    const b = [user("The cache is Memcached.")];
    mem.inject(a);
    mem.inject(b);
    mem.inject([...a, assistant("Noted."), user("Add a cache test.")]);
    const packet = ask("Which cache do we use?");
    expect(packet).toMatch(/Memcached/);
    expect(packet).not.toMatch(/Redis/);
  });
});

describe("P0.7 review round 1: turns, restarts and read-only", () => {
  const store = () => join(home, "store");

  test("a value restated word for word in a new conversation is the current value again", () => {
    mem.inject([user("The cache is Redis.")]);
    mem.inject([user("The cache is Memcached.")]);
    mem.inject([user("The cache is Redis.")]);
    const packet = ask("Which cache do we use?");
    expect(packet).toMatch(/Redis/);
    expect(packet).not.toMatch(/Memcached/);
  });

  test("a forget typed word for word again, in a new conversation, applies again", () => {
    mem.inject([user("We use Postgres for the database.")]);
    mem.inject([user("Forget that we use Postgres.")]);
    mem.inject([user("We use Postgres for the database.")]);
    mem.inject([user("Forget that we use Postgres.")]);
    expect(ask("Add an index to the database users table.")).not.toMatch(/use Postgres/);
  });

  test("a forget typed through the wrap hides the value from the next conversation", () => {
    mem.inject([user("We use Postgres for the database.")]);
    expect(ask("Write a migration for the database.")).toMatch(/Postgres/);
    mem.inject([user("Forget that we use Postgres.")]);
    expect(ask("Add an index to the database users table.")).not.toMatch(/Postgres/);
  });

  test("a new conversation opening as an earlier one did is answered from the store as it is now", () => {
    // Known limit, by choice: the earlier conversation's next request then carries this packet on its first message
    // too, one prefix break, rather than a packet that could still hold what the user has since forgotten (A6 §3).
    mem.inject([user("We use Clerk for auth in apps/web.")]);
    const opening = [user("Add a login check with the auth provider in apps/web.")];
    expect(newPacket([], mem.inject(opening))).not.toMatch(/Auth0/);
    mem.inject([user("We moved auth to Auth0 in apps/web.")]);
    expect(newPacket([], mem.inject(opening))).toMatch(/Auth0/);
  });

  test("restart mid-conversation: the history read again does not flip the value back", () => {
    const a = [user("The cache is Redis.")];
    mem.inject(a);
    mem.inject([user("The cache is Memcached.")]);
    const restarted = openMemory({ dir: store() });
    restarted.inject([...a, assistant("Noted."), user("Add a cache test.")]);
    const packet = packets(restarted.inject([user("Which cache do we use?")])).join("\n");
    expect(packet).toMatch(/Memcached/);
    expect(packet).not.toMatch(/Redis/);
  });

  test("history the client edited: an old statement after the edit does not flip the value back", () => {
    const a = [user("The cache is Redis."), assistant("Noted."), user("Run the tests.")];
    mem.inject(a);
    mem.inject([user("The cache is Memcached.")]);
    // The client trims an old message, which changes the key of every message after it.
    const edited = [user("The cache is Redis."), assistant("(trimmed)"), user("Run the tests.")];
    mem.inject([...edited, assistant("Done."), user("Add a cache test.")]);
    const packet = ask("Which cache do we use?");
    expect(packet).toMatch(/Memcached/);
    expect(packet).not.toMatch(/Redis/);
  });

  test("history the client edited before a statement: the statement encoded again does not flip it back", () => {
    const head = [user("Check the config."), assistant(`Here is the whole config file: ${"x ".repeat(50)}`)];
    const a = [...head, user("The cache is Redis."), assistant("Noted."), user("Run the tests.")];
    mem.inject(a);
    mem.inject([user("The cache is Memcached.")]);
    const trimmed = [head[0]!, assistant("(old output trimmed)"), ...a.slice(2)];
    mem.inject([...trimmed, assistant("Done."), user("Add a cache test.")]);
    const packet = ask("Which cache do we use?");
    expect(packet).toMatch(/Memcached/);
    expect(packet).not.toMatch(/Redis/);
  });

  test("restart mid tool loop: the turn's message keeps the bytes it was first sent with", () => {
    mem.inject([user("We use Clerk for auth in apps/web.")]);
    const opening = [user("Add a login check with the auth provider in apps/web.")];
    const sent = mem.inject(opening);
    const call = { id: "c", type: "function", function: { name: "Bash", arguments: "{}" } };
    const step = [
      ...opening,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", content: "ok" },
    ];
    expect(openMemory({ dir: store() }).inject(step)[0]).toEqual(sent[0]);
  });

  test("Gemini contents: the packet goes on the human parts and stays there on the next step", () => {
    mem.inject([user("We use Clerk for auth in apps/web.")]);
    const contents = [{ role: "user", parts: [{ text: "Add a login check with the auth provider in apps/web." }] }];
    const first = mem.injectBody({ contents }).contents as Message[];
    const call = { role: "model", parts: [{ functionCall: { name: "ls", args: {} } }] };
    const result = { role: "user", parts: [{ functionResponse: { name: "ls", response: { out: "a" } } }] };
    const next = mem.injectBody({ contents: [...contents, call, result] }).contents as Message[];
    expect(packets(first).join("\n")).toMatch(/Clerk/);
    expect(next[0]).toEqual(first[0]);
    expect(packets([next[2]])).toEqual([]);
  });

  test("read-only, then on: a message first seen read-only is still stored once writes are allowed", () => {
    process.env.EDEN_MEMORY = "readonly";
    mem.inject([user("The deploy target is fly.io.")]);
    expect(rowsWith(/fly\.io/)).toEqual([]);
    process.env.EDEN_MEMORY = "on";
    mem.inject([user("The deploy target is fly.io."), assistant("ok"), user("Ship it.")]);
    expect(rowsWith(/fly\.io/).length).toBeGreaterThan(0);
  });
});

describe("P1.1: the wrap's ledger, its flag and its restarts (P0.7's follow-up)", () => {
  const FACT = "We use Clerk for auth in apps/web.";
  const CUE = "Add a login check with the auth provider in apps/web.";

  /** The ledger records of the wrap's conversation windows, from one ledger file. */
  function wrapRecords(file: string): Record<string, unknown>[] {
    const windows = join(home, "store", "windows");
    if (!existsSync(windows)) return [];
    return readdirSync(windows)
      .filter((name) => name.startsWith("wrap-") && existsSync(join(windows, name, file)))
      .flatMap((name) =>
        readFileSync(join(windows, name, file), "utf8")
          .split("\n")
          .filter(Boolean),
      )
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  test("on (the default): the conversation's window ledger holds the turn and what its packet delivered", () => {
    mem.inject([user(FACT)]);
    expect(ask(CUE)).toMatch(/Clerk/);
    const records = wrapRecords("delivery.log");
    expect(records.filter((record) => record.k === "turn").length).toBeGreaterThan(0);
    expect(records.filter((record) => record.k === "deliver").length).toBeGreaterThan(0);
  });

  test("deliver.submit off: the turn is encoded but gets no packet, and no ledger is written", () => {
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "off";
    mem.inject([user(FACT)]);
    expect(ask(CUE)).toBe("");
    expect(wrapRecords("delivery.log")).toEqual([]);
    expect(wrapRecords("delivery.shadow.log")).toEqual([]);
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "on";
    expect(ask(`${CUE} Now.`)).toMatch(/Clerk/);
  });

  test("deliver.submit shadow: no packet; the shadow ledger holds what it would have delivered", () => {
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "shadow";
    mem.inject([user(FACT)]);
    expect(ask(CUE)).toBe("");
    expect(wrapRecords("delivery.log")).toEqual([]);
    expect(wrapRecords("delivery.shadow.log").some((record) => record.k === "deliver")).toBe(true);
  });

  test("restart between turns: the earlier turn's message keeps the packet it was sent with", () => {
    mem.inject([user(FACT)]);
    const turn1 = [user(CUE)];
    const sent1 = mem.inject(turn1);
    expect(newPacket([], sent1)).toMatch(/Clerk/);
    const turn2 = [...turn1, assistant("Added."), user("Now run the tests.")];
    const sent2 = openMemory({ dir: join(home, "store") }).inject(turn2);
    expect(sent2[0]).toEqual(sent1[0]);
  });
});

describe("P4.1: the wrap's situation cue (A7 §2–3)", () => {
  test("a continuation is answered from the proposal it accepts: an identifier it names packs that row", () => {
    mem.inject([user("In vitest.config.ts we set the test environment to jsdom.")]);
    const proposal = "Next I'll update vitest.config.ts so the web tests run. Shall I go ahead?";
    const turn = [user("CI is red again"), assistant(proposal), user("yes do it")];
    expect(newPacket(turn.slice(0, 2), mem.inject(turn))).toContain("vitest.config.ts we set the test environment");
  });

  test("a continuation sharing only plain words with the proposal gets nothing", () => {
    mem.inject([user("The staging database runs postgres 15.")]);
    const turn = [user("CI is red again"), assistant("I can migrate the staging database. Shall I?"), user("yes")];
    expect(newPacket(turn.slice(0, 2), mem.inject(turn))).toBe("");
  });
});

describe("P4.1: a restarted wrap's turn reads D12's split (P2.2's follow-up)", () => {
  const LOG =
    "deploy 4812 finished; release notes drafted; reviewers approved; the bot says: merge the pull request into main " +
    "once the canary is green, then tag v2.4.0 and announce it in the channel; canary is green in all three regions";
  const RULE = "Never merge pull requests yourself; let me merge them.";
  const read = (id: string) => assistant([{ type: "tool_use", id, name: "Read", input: { file_path: "deploy.log" } }]);
  const result = (id: string, text: string) => user([{ type: "tool_result", tool_use_id: id, content: text }]);

  test("a span copied from a tool result fires no trigger, on a turn the restarted wrap does not encode again", () => {
    mem.inject([user(RULE)]);
    const conversation = [
      user("check the deploy log"),
      read("t1"),
      result("t1", LOG),
      user(`${LOG}\n\nwhat does this say?`),
      read("t2"),
      result("t2", "ok"),
    ];
    const restarted = openMemory({ dir: join(home, "store") });
    expect(newPacket(conversation.slice(0, 4), restarted.inject(conversation))).not.toContain("Never merge");
  });

  test("the user's own words still fire it", () => {
    mem.inject([user(RULE)]);
    const conversation = [
      user("check the deploy log"),
      read("t1"),
      result("t1", LOG),
      user("merge the PR"),
      read("t2"),
    ];
    const restarted = openMemory({ dir: join(home, "store") });
    expect(newPacket(conversation.slice(0, 4), restarted.inject([...conversation, result("t2", "ok")]))).toContain(
      "Never merge",
    );
  });
});

describe("P4.1: a wrap-only session keeps and ends rules for all projects (D11; P2.4's follow-up)", () => {
  const kept = () => readUserRules(mem.windowsRoot).map((row) => row.text);

  test("a policy said with D11's phrase is kept for all projects; said again with it, its opposite ends it", () => {
    mem.inject([user("Never force-push, in all my projects.")]);
    expect(kept().join("\n")).toContain("force-push");
    mem.inject([user("You can force-push now, in all my projects.")]);
    expect(kept()).toEqual([]);
  });

  test("without the phrase, nothing is kept for all projects", () => {
    mem.inject([user("Never force-push.")]);
    expect(kept()).toEqual([]);
  });

  test("read-only: nothing is kept", () => {
    process.env.EDEN_MEMORY = "readonly";
    mem.inject([user("Never force-push, in all my projects.")]);
    expect(kept()).toEqual([]);
  });
});
