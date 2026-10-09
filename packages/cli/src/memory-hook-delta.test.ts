/**
 * P0.6 at the hook: each event encodes the window's delta (A4 §3.3) instead of re-reading the transcript, a rewind
 * takes back what the abandoned turns said, PostToolBatch records its batch (A4 §5.5), and Stop is split into a sync
 * `stop-fast` and an async `stop-sleep` (D34, A4 §5.7).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GistStore } from "../../../src/gist-store";
import { storeRows, superseded, type MemoryRecord } from "../../../src/index";
import { storeFor } from "../../../src/memory-repo";
import { memoryHookResponse, type HookStage } from "./memory-hook";

const SESSION = "s-delta";
const T0 = Date.parse("2026-09-01T09:00:00.000Z");

let dir = "";
let transcript = "";
const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME, now: process.env.EDEN_NOW };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-delta-"));
  transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "");
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(T0 + 3_600_000);
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

type Line = Record<string, unknown>;
const at = (second: number) => new Date(T0 + second * 1000).toISOString();
const typed = (uuid: string, parentUuid: string | null, promptId: string, text: string): Line => ({
  parentUuid,
  promptId,
  type: "user",
  message: { role: "user", content: text },
  uuid,
  timestamp: at(1),
  origin: { kind: "human" },
});
const said = (uuid: string, parentUuid: string, text: string, second = 2): Line => ({
  parentUuid,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
  uuid,
  timestamp: at(second),
});
const write = (...lines: Line[]) => appendFileSync(transcript, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));

function hook(event: string, fields: Record<string, unknown> = {}, stage?: HookStage) {
  return memoryHookResponse(
    { hook_event_name: event, session_id: SESSION, transcript_path: transcript, ...fields },
    stage,
  );
}

const rows = (): MemoryRecord[] => storeRows(join(storeFor(join(dir, "memory")), "memories.jsonl"));
const live = (text: string) => rows().filter((row) => row.text.includes(text) && !superseded(row));
const windowFile = (name: string) => join(dir, "memory", "windows", SESSION, name);

describe("A4 §3.3: the delta, not the whole transcript", () => {
  test("Submit encodes the lines since the mark; each row names its line, its turn and the line's time", () => {
    write(typed("u1", null, "p1", "set up the project"), said("a1", "u1", "The build uses esbuild here.", 5));
    hook("UserPromptSubmit", { prompt: "run the build", prompt_id: "p2" });
    const [row] = live("The build uses esbuild here");
    expect(row).toMatchObject({ srcUuid: "a1", promptId: "p1", at: T0 + 5000 });
    expect(live("run the build")[0]?.promptId).toBe("p2");
    const count = rows().length;
    hook("UserPromptSubmit", { prompt: "and again", prompt_id: "p3" });
    expect(rows().filter((r) => r.text.includes("esbuild"))).toHaveLength(1);
    expect(rows().length).toBeGreaterThan(count);
  });

  test("a rewind sends the abandoned turn's rows to history; what the new branch says again stays", () => {
    write(typed("u1", null, "p1", "start"), said("a1", "u1", "Ready."));
    hook("UserPromptSubmit", { prompt: "start", prompt_id: "p1" });
    hook("UserPromptSubmit", { prompt: "The test runner is jest. The cache is redis.", prompt_id: "p2" });
    write(typed("u2", "a1", "p2", "The test runner is jest. The cache is redis."), said("a2", "u2", "Noted."));
    hook("Stop", { last_assistant_message: "Noted.", prompt_id: "p2" });
    expect(live("The test runner is jest")).toHaveLength(1);
    // The user rewinds to the second prompt and says only part of it again.
    hook("UserPromptSubmit", { prompt: "The cache is redis.", prompt_id: "p3" });
    write(typed("u3", "a1", "p3", "The cache is redis."));
    hook("PostToolBatch", { prompt_id: "p3", tool_calls: [] });
    expect(live("The test runner is jest")).toHaveLength(0);
    expect(live("The cache is redis")).toHaveLength(1);
    expect(readFileSync(windowFile("hwm.json"), "utf8")).toContain("p2");
  });
});

describe("A4 §5.5: PostToolBatch", () => {
  test("one ctx.log record for the batch: paths, exit codes and error signatures; then the delta", () => {
    write(typed("u1", null, "p1", "build it"), said("a1", "u1", "Running the build now."));
    hook("PostToolBatch", {
      prompt_id: "p1",
      tool_calls: [
        { tool_name: "Read", tool_input: { file_path: "/r/src/a.ts" }, tool_use_id: "t1", tool_response: "1\tx" },
        {
          tool_name: "Bash",
          tool_input: { command: "make" },
          tool_use_id: "t2",
          tool_response: "Exit code 2\nerror: no rule",
        },
      ],
    });
    const records = readFileSync(windowFile("ctx.log"), "utf8").trim().split("\n");
    expect(records.map((line) => JSON.parse(line))).toEqual([
      { k: "batch", prompt_id: "p1", paths: ["/r/src/a.ts"], exit: [2], sig: ["error: no rule"] },
    ]);
    expect(live("Running the build now")).toHaveLength(1);
  });
});

describe("D34: Stop's two handlers", () => {
  test("stop-fast keeps the agent's last message for the next Submit and stores nothing", () => {
    hook("UserPromptSubmit", { prompt: "merge the branch", prompt_id: "p1" });
    const before = rows().length;
    expect(hook("Stop", { last_assistant_message: "Shall I open the pull request?" }, "stop-fast")).toBeNull();
    expect(JSON.parse(readFileSync(windowFile("qprev.json"), "utf8"))).toMatchObject({
      text: "Shall I open the pull request?",
    });
    expect(rows().length).toBe(before);
  });

  test("the next Submit reads the agent's last message from qprev.json while the transcript lags", () => {
    write(typed("u1", null, "p1", "merge the branch"), said("a1", "u1", "Looking at the branch."));
    hook("Stop", { last_assistant_message: "Shall I open the pull request?" }, "stop-fast");
    hook("UserPromptSubmit", { prompt: "yes", prompt_id: "p2" });
    const events = readdirSync(join(dir, "memory", "hook.log.d"))
      .flatMap((name) =>
        readFileSync(join(dir, "memory", "hook.log.d", name), "utf8")
          .trim()
          .split("\n"),
      )
      .map((line) => JSON.parse(line) as { ev: string; turn_mode?: string; stage?: string });
    expect(events.find((event) => event.ev === "UserPromptSubmit")?.turn_mode).toBe("continuation");
    expect(events.find((event) => event.ev === "Stop")?.stage).toBe("stop-fast");
  });

  test("stop-sleep stores the turn and rewrites the session gist; one Stop hook (no stage) does both", () => {
    hook("UserPromptSubmit", { prompt: "The database is postgres.", prompt_id: "p1" });
    hook("Stop", { last_assistant_message: "Postgres noted for the service." }, "stop-sleep");
    expect(live("Postgres noted for the service")).toHaveLength(1);
    const gists = () => new GistStore(storeFor(join(dir, "memory"))).latest(SESSION, 3).map((gist) => gist.text);
    expect(gists().join(" ")).toContain("postgres");
    expect(existsSync(windowFile("qprev.json"))).toBe(false);
    hook("Stop", { last_assistant_message: "Done with the database." });
    expect(existsSync(windowFile("qprev.json"))).toBe(true);
    expect(live("Done with the database")).toHaveLength(1);
  });
});

describe("the plugin's registrations", () => {
  const hooks = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../plugins/eden-memory/hooks/hooks.json"), "utf8"),
  ) as { hooks: Record<string, { hooks: { command: string; async?: boolean }[] }[]> };
  const handlers = (event: string) => (hooks.hooks[event] ?? []).flatMap((group) => group.hooks);

  test("PostToolBatch records batches; PostToolUse is not registered (A4 §3.3)", () => {
    expect(handlers("PostToolBatch")).toHaveLength(1);
    expect(handlers("PostToolUse")).toHaveLength(0);
  });

  test("Stop runs a sync stop-fast and an async stop-sleep; SubagentStop is async (D34, A4 §5.7b)", () => {
    const stop = handlers("Stop");
    expect(stop.map((h) => [h.command.includes("stop-fast"), h.command.includes("stop-sleep"), !!h.async])).toEqual([
      [true, false, false],
      [false, true, true],
    ]);
    expect(handlers("SubagentStop").every((h) => h.async)).toBe(true);
    expect(handlers("UserPromptSubmit").some((h) => h.async)).toBe(false);
  });
});
