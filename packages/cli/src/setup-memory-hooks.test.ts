/**
 * P0.7's follow-up rows for `eden setup`'s Claude hooks: they run memory as the plugin does (PostToolBatch records a
 * batch, Stop is a sync `stop-fast` and an async `stop-sleep`, D34, A4 §5.5, §5.7), and they keep EXECUTION §5's
 * fail-open contract: exit 0, and print nothing when memory has nothing to say.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeRows } from "../../../src/index";
import { storeFor } from "../../../src/memory-repo";
import { respondToHook, type HookIn } from "./hook";
import { hookCommand, installedHooks, preHookCommand } from "./setup";

const CLI = join(import.meta.dir, "cli.ts");
const ENV = ["EDEN_HOME", "EDEN_MEMORY_DIR", "EDEN_MEMORY", "EDEN_SLEEP_IDLE"];
let saved: Record<string, string | undefined> = {};
let dir = "";

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "eden-setup-hooks-"));
  Object.assign(process.env, {
    EDEN_HOME: join(dir, "home"),
    EDEN_MEMORY_DIR: join(dir, "memory"),
    EDEN_MEMORY: "on",
    EDEN_SLEEP_IDLE: "off",
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

type Handler = { type: string; command: string; async?: boolean };
const handlers = (hooks: Record<string, { hooks: Handler[] }[]>, event: string): Handler[] =>
  (hooks[event] ?? []).flatMap((entry) => entry.hooks);

describe("P0.7: eden setup's Claude hooks run memory as the plugin does", () => {
  const hooks = installedHooks((stage) => hookCommand("/abs/cli.ts", 8794, { stage })) as unknown as Record<
    string,
    { hooks: Handler[] }[]
  >;

  test("Stop is a sync stop-fast and an async stop-sleep; SubagentStop is async (D34)", () => {
    const [fast, sleep, ...rest] = handlers(hooks, "Stop");
    expect(rest).toEqual([]);
    expect(fast!.command).toContain("/hook?stage=stop-fast");
    expect(fast!.command).toContain("bun '/abs/cli.ts' hook stop-fast");
    expect(fast!.async).toBeUndefined();
    expect(sleep!.command).toContain("bun '/abs/cli.ts' hook stop-sleep");
    expect(sleep!.async).toBe(true);
    expect(handlers(hooks, "SubagentStop").map((h) => h.async)).toEqual([true]);
  });

  test("PostToolBatch records memory, so PostToolUse leaves it to the batch (A4 §5.5)", () => {
    expect(handlers(hooks, "PostToolUse")[0]!.command).toContain("bun '/abs/cli.ts' hook batched");
    expect(handlers(hooks, "PostToolBatch")[0]!.command).toMatch(/' hook 2>\/dev\/null \|\| true$/);
  });

  test("no command prints on failure: each ends in `|| true` (EXECUTION §5)", () => {
    for (const handler of Object.keys(hooks).flatMap((event) => handlers(hooks, event))) {
      expect(handler.command).not.toContain("echo");
      expect(handler.command.endsWith("|| true")).toBe(true);
    }
    expect(preHookCommand(9001).endsWith("|| true")).toBe(true);
  });

  test("a command whose every call fails exits 0 and writes nothing, stderr included (review round 1)", () => {
    // No hookd on the port, no key file, and a CLI path that does not exist: curl and bun both fail.
    for (const command of [hookCommand("/nonexistent/cli.ts", 9, { stage: "stop-fast" }), preHookCommand(9)]) {
      const run = Bun.spawnSync(["sh", "-c", command], {
        stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "Stop", session_id: "s" })),
        env: { ...process.env, EDEN_HOOKD: "0" },
      });
      expect({ code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
    }
  });
});

/** `eden hook [stage]` as Claude Code runs it: the payload on stdin. */
function runHook(payload: Record<string, unknown>, stage?: string) {
  const proc = Bun.spawnSync(["bun", CLI, "hook", ...(stage ? [stage] : [])], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    // No hookd: `eden hook` would start one in the background and wait for it.
    env: { ...process.env, EDEN_HOOKD: "0" },
    cwd: dir,
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString() };
}

describe("P0.7: eden hook prints nothing when memory has nothing to say (EXECUTION §5)", () => {
  test("a Submit with an empty store, a Stop and each Stop stage", () => {
    const base = { session_id: "s-p07", cwd: dir };
    expect(runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "Fix the parser." })).toEqual({
      code: 0,
      stdout: "",
    });
    expect(runHook({ ...base, hook_event_name: "Stop" })).toEqual({ code: 0, stdout: "" });
    expect(runHook({ ...base, hook_event_name: "Stop" }, "stop-fast")).toEqual({ code: 0, stdout: "" });
    expect(runHook({ ...base, hook_event_name: "Stop" }, "stop-sleep")).toEqual({ code: 0, stdout: "" });
  });
});

describe("P0.7: respondToHook records batches and honours the stage", () => {
  const rows = () => storeRows(join(storeFor(join(dir, "memory")), "memories.jsonl"));

  test("PostToolBatch writes its batch record to the window's ctx.log (A4 §5.5)", async () => {
    const transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, "");
    await respondToHook({
      hook_event_name: "PostToolBatch",
      session_id: "s-batch",
      transcript_path: transcript,
      prompt_id: "p1",
      tool_calls: [
        { tool_name: "Bash", tool_input: { command: "make" }, tool_use_id: "t1", tool_response: "Exit code 2\nerror" },
      ],
    } as HookIn);
    const ctx = join(dir, "memory", "windows", "s-batch", "ctx.log");
    expect(existsSync(ctx)).toBe(true);
    expect(readFileSync(ctx, "utf8")).toContain('"k":"batch"');
  });

  test("a batched PostToolUse encodes nothing: its batch will", async () => {
    await respondToHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s-each",
        tool_name: "Bash",
        tool_input: { command: "cat deploy.md" },
        tool_response: "The deploy target is fly.io.",
      },
      undefined,
      "batched",
    );
    expect(rows().filter((r) => /fly\.io/.test(r.text))).toEqual([]);
  });
});
