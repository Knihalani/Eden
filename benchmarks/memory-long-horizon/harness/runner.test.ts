/**
 * P0.0a target 3 and the runner's reading of hook output: one process per handler per event, Claude Code's
 * matcher rules, timeouts, environment, and stdout read by the documented rules.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  postToolUsePayload,
  sessionEndPayload,
  stopPayload,
  userPromptSubmitPayload,
  type EventContext,
  type HookEvent,
} from "./payloads";
import {
  HookRunner,
  hookEnv,
  interpretOutput,
  loadPlugin,
  matcherAccepts,
  timeoutSeconds,
  type HookGroup,
} from "./runner";
import { PROBE_PLUGIN, probeWorld, removeTempDirs, tempDir } from "./testkit";
import { readCall } from "./tools";

afterAll(removeTempDirs);

/** A plugin in a temp dir whose handlers all run the probe script. */
function pluginWith(hooks: Record<string, HookGroup[]>): string {
  const root = tempDir("eden-plugin");
  mkdirSync(join(root, "hooks"));
  writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks }));
  return root;
}

const PROBE = `sh "${join(PROBE_PLUGIN, "record.sh")}"`;
const probeHook = (extra: Record<string, unknown> = {}) => ({ type: "command" as const, command: PROBE, ...extra });

describe("matcher rules (hooks reference, Matcher patterns)", () => {
  test.each([
    [undefined, "Bash", true],
    ["", "Bash", true],
    ["*", "Read", true],
    ["Bash", "Bash", true],
    ["Bash", "BashOutput", false],
    ["Edit|Write", "Write", true],
    ["Edit, Write", "Edit", true],
    ["code-reviewer", "senior-code-reviewer", false],
    ["^Notebook", "NotebookEdit", true],
    ["Edit.*", "NotebookEdit", true],
    ["^Edit$", "NotebookEdit", false],
    ["mcp__memory__.*", "mcp__memory__search", true],
  ] as const)("%p on %p → %p", (matcher, value, expected) => {
    expect(matcherAccepts(matcher, value)).toBe(expected);
  });
});

describe("how Claude Code reads a hook's output", () => {
  test("JSON additionalContext for the right event is context", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } });
    expect(interpretOutput("PostToolUse", 0, stdout, false)).toMatchObject({ output: "json", additionalContext: "x" });
  });

  test("a hookEventName that names another event is an error, and its context is dropped", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: "x" } });
    const outcome = interpretOutput("UserPromptSubmit", 0, stdout, false);
    expect(outcome.additionalContext).toBeUndefined();
    expect(outcome.error).toContain("hookEventName");
  });

  test("plain text is context only on UserPromptSubmit and SessionStart, and only on exit 0", () => {
    expect(interpretOutput("UserPromptSubmit", 0, "note\n", false).additionalContext).toBe("note");
    expect(interpretOutput("SessionStart", 0, "note", false).additionalContext).toBe("note");
    expect(interpretOutput("PostToolUse", 0, "note", false).additionalContext).toBeUndefined();
    expect(interpretOutput("UserPromptSubmit", 1, "note", false)).toMatchObject({ error: expect.any(String) });
  });

  test("exit 2 blocks the events that can block, and only those", () => {
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolBatch", "Stop", "SubagentStop", "PreCompact"]) {
      expect(interpretOutput(event as HookEvent, 2, "", false).blocked).toBe(true);
    }
    for (const event of ["PostToolUse", "SessionStart", "SubagentStart", "SessionEnd", "PostCompact"]) {
      expect(interpretOutput(event as HookEvent, 2, "", false).blocked).toBe(false);
    }
    expect(interpretOutput("PreToolUse", 2, "", false).permissionDecision).toBe("deny");
  });

  test("decision block and continue:false block; PreToolUse decisions are read", () => {
    expect(interpretOutput("UserPromptSubmit", 0, '{"decision":"block"}', false).blocked).toBe(true);
    expect(interpretOutput("PostToolUse", 0, '{"continue":false}', false).blocked).toBe(true);
    const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } });
    expect(interpretOutput("PreToolUse", 0, ask, false).permissionDecision).toBe("ask");
  });

  test("invalid JSON, a non-zero exit with no JSON, and a timeout are errors; a timeout discards the output", () => {
    expect(interpretOutput("Stop", 0, "{not json}", false)).toMatchObject({ output: "invalid-json" });
    expect(interpretOutput("Stop", 1, "", false).error).toContain("non-blocking status code 1");
    const late = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" } });
    expect(interpretOutput("UserPromptSubmit", null, late, true)).toMatchObject({ output: "none", blocked: false });
  });

  test("an empty stdout and `{}` are both accepted silently", () => {
    expect(interpretOutput("UserPromptSubmit", 0, "", false)).toEqual({ output: "none", blocked: false });
    expect(interpretOutput("UserPromptSubmit", 0, "{}", false)).toEqual({ output: "json", json: {}, blocked: false });
  });
});

describe("timeouts (hooks reference, Common fields)", () => {
  const handler = { type: "command" as const, command: "true" };
  test("600 s by default, 30 s on UserPromptSubmit, a handler's own timeout otherwise", () => {
    expect(timeoutSeconds("PostToolUse", handler)).toBe(600);
    expect(timeoutSeconds("UserPromptSubmit", handler)).toBe(30);
    expect(timeoutSeconds("PostToolUse", { ...handler, timeout: 5 })).toBe(5);
  });

  test("SessionEnd shares 1.5 s, and a plugin hook's timeout does not raise it", () => {
    expect(timeoutSeconds("SessionEnd", handler)).toBe(1.5);
    expect(timeoutSeconds("SessionEnd", { ...handler, timeout: 10 })).toBe(1.5);
  });
});

describe("loading a plugin", () => {
  test("handler features the simulator does not model are refused, not run differently", () => {
    for (const extra of [{ if: "Bash(git *)" }, { async: true }, { type: "prompt", prompt: "x" }]) {
      const root = pluginWith({ PreToolUse: [{ hooks: [probeHook(extra) as never] }] });
      expect(() => loadPlugin(root)).toThrow("does not model");
    }
  });

  test("the plugin's name comes from its manifest", () => {
    expect(loadPlugin(PROBE_PLUGIN).name).toBe("probe");
  });
});

const ctx = (cwd: string): EventContext => ({
  sessionId: "11111111-1111-4111-8111-111111111111",
  transcriptPath: join(cwd, "t.jsonl"),
  cwd,
  promptId: "22222222-2222-4222-8222-222222222222",
  permissionMode: "default",
});

describe("processes (target 3)", () => {
  test("every invocation is its own process, and reads the payload on stdin", async () => {
    const probe = probeWorld();
    const session = probe.world.newSession();
    await session.start();
    for (let i = 0; i < 5; i++) await session.prompt(`prompt ${i}`);
    const invocations = probe.world.log.flatMap((record) => record.invocations);
    expect(invocations).toHaveLength(7);
    expect(new Set(invocations.map((invocation) => invocation.pid)).size).toBe(7);
    expect(
      probe
        .recorded()
        .map((entry) => entry.pid)
        .sort(),
    ).toEqual(invocations.map((i) => i.pid).sort());
  });

  test("a parallel batch of n Reads fires n PostToolUse processes that overlap in time", async () => {
    const probe = probeWorld({ mode: "slow", env: { PROBE_SLEEP: "0.4" } });
    const session = probe.world.newSession();
    await session.start();
    await session.prompt("read three files");
    const at = (name: string) => join(probe.world.projectDir, name);
    const ids = ["toolu_01AAAAAAAAAAAAAAAAAAAAAA", "toolu_01BBBBBBBBBBBBBBBBBBBBBB", "toolu_01CCCCCCCCCCCCCCCCCCCCCC"];
    await session.main.tools(ids.map((id, i) => readCall(id, at(`f${i}.ts`), "x")));
    const post = probe.world.log.filter((record) => record.event === "PostToolUse").flatMap((r) => r.invocations);
    expect(post).toHaveLength(3);
    const latestStart = Math.max(...post.map((invocation) => invocation.startedAt));
    const earliestEnd = Math.min(...post.map((invocation) => invocation.endedAt));
    expect(latestStart).toBeLessThan(earliestEnd);
    expect(new Set(post.map((invocation) => invocation.pid)).size).toBe(3);
  });

  test("handlers of one event run in parallel, each matched by its group's matcher", async () => {
    const out = tempDir("eden-probe-out");
    const root = pluginWith({
      PostToolUse: [
        { matcher: "Read", hooks: [probeHook()] },
        { matcher: "Read|Edit", hooks: [probeHook()] },
        { matcher: "Bash", hooks: [probeHook()] },
      ],
    });
    const plugin = loadPlugin(root);
    const home = tempDir("eden-home");
    const env = hookEnv({ home, projectDir: out, plugin, extra: { PROBE_OUT: out, PROBE_MODE: "slow" } });
    const runner = new HookRunner({ plugin, env, projectDir: out });
    const call = readCall("toolu_01DDDDDDDDDDDDDDDDDDDDDD", join(out, "a.ts"), "x");
    const invocations = await runner.dispatch(postToolUsePayload(ctx(out), call));
    expect(invocations).toHaveLength(2);
    expect(Math.max(...invocations.map((i) => i.startedAt))).toBeLessThan(
      Math.min(...invocations.map((i) => i.endedAt)),
    );
  });

  test("hooks get Claude Code's variables and a home inside the run dir, nothing from the caller", async () => {
    process.env.EDEN_LEAK_CHECK = "leaked";
    try {
      const probe = probeWorld();
      const session = probe.world.newSession();
      await session.start();
      const [entry] = probe.recorded();
      const [cwd, pluginRoot, projectDir, home, edenHome, memoryDir] = entry!.env;
      expect(cwd).toBe(probe.world.projectDir);
      expect(pluginRoot).toBe(PROBE_PLUGIN);
      expect(projectDir).toBe(probe.world.projectDir);
      expect(home).toBe(probe.world.home);
      expect(edenHome).toBe(join(probe.world.home, ".eden"));
      expect(memoryDir).toBe(join(probe.world.home, ".eden", "memory"));
      // What the process saw, less the variables the shell itself sets (PWD, SHLVL, _, OLDPWD).
      const shell = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
      expect(entry!.envNames.filter((name) => !shell.has(name))).toEqual([
        "CLAUDE_PLUGIN_DATA",
        "CLAUDE_PLUGIN_ROOT",
        "CLAUDE_PROJECT_DIR",
        "EDEN_HOME",
        "EDEN_MEMORY_DIR",
        "HOME",
        "LANG",
        "PATH",
        "PROBE_MODE",
        "PROBE_OUT",
        "TMPDIR",
      ]);
    } finally {
      delete process.env.EDEN_LEAK_CHECK;
    }
  });

  test("a hook that outlives its timeout is killed and its output discarded", async () => {
    const out = tempDir("eden-probe-out");
    const root = pluginWith({ SessionEnd: [{ hooks: [probeHook()] }] });
    const plugin = loadPlugin(root);
    const env = hookEnv({
      home: tempDir("eden-home"),
      projectDir: out,
      plugin,
      extra: { PROBE_OUT: out, PROBE_MODE: "slow", PROBE_SLEEP: "5" },
    });
    const runner = new HookRunner({ plugin, env, projectDir: out });
    const started = performance.now();
    const [invocation] = await runner.dispatch(sessionEndPayload(ctx(out), "other"));
    expect(invocation!.timedOut).toBe(true);
    expect(invocation!.exitCode).toBeNull();
    expect(performance.now() - started).toBeLessThan(4_000);
  });

  test("a hook that exits without reading a large payload does not stall the runner", async () => {
    const out = tempDir("eden-probe-out");
    const root = pluginWith({ Stop: [{ hooks: [{ type: "command", command: "exit 0" }] }] });
    const plugin = loadPlugin(root);
    const runner = new HookRunner({
      plugin,
      env: hookEnv({ home: tempDir("eden-home"), projectDir: out, plugin }),
      projectDir: out,
    });
    const big = { ...ctx(out), lastAssistantMessage: "x".repeat(4_000_000) };
    const [invocation] = await runner.dispatch(stopPayload(big, { lastAssistantMessage: big.lastAssistantMessage }));
    expect(invocation!.exitCode).toBe(0);
  });

  test("an event with no matching handler runs nothing", async () => {
    const out = tempDir("eden-probe-out");
    const root = pluginWith({ PreToolUse: [{ matcher: "Bash", hooks: [probeHook()] }] });
    const plugin = loadPlugin(root);
    const env = hookEnv({ home: tempDir("eden-home"), projectDir: out, plugin, extra: { PROBE_OUT: out } });
    const runner = new HookRunner({ plugin, env, projectDir: out });
    expect(await runner.dispatch(userPromptSubmitPayload(ctx(out), "hi"))).toEqual([]);
  });
});
