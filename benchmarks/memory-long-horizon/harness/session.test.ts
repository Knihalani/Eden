/**
 * What hooks see and what their answers do: the lagging transcript, blocked prompts, saved contexts,
 * permission decisions, rewinds, subagents, compaction, resume and /clear.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlugin } from "./runner";
import { DECLINED, SimWorld, type SimSession } from "./session";
import { generateSession, play } from "./shape";
import { probeWorld, readLines, removeTempDirs, tempDir, type Probe } from "./testkit";
import { bashCall, readCall } from "./tools";

afterAll(removeTempDirs);

async function started(probe: Probe): Promise<SimSession> {
  const session = probe.world.newSession();
  await session.start();
  return session;
}

/** A session whose only prompt was blocked never wrote a line, so its file may not exist. */
const linesOf = (path: string) => (existsSync(path) ? readLines(path) : []);

const typedPrompts = (path: string) =>
  linesOf(path).filter((line) => line.type === "user" && (line.origin as { kind?: string })?.kind === "human");

describe("the transcript a hook reads", () => {
  test("lagging (default): UserPromptSubmit runs before its prompt line is on disk", async () => {
    const probe = probeWorld({ snapshot: true });
    const session = await started(probe);
    await session.prompt("first prompt");
    await session.prompt("second prompt");
    const submits = probe.recorded().filter((entry) => entry.payload.hook_event_name === "UserPromptSubmit");
    const atSecond = submits.find((entry) => entry.payload.prompt === "second prompt")!.transcript!;
    expect(atSecond).toContain("first prompt");
    expect(atSecond).not.toContain("second prompt");
    expect(typedPrompts(session.transcriptPath)).toHaveLength(2);
  });

  test("eager: every line is on disk before the next hook runs", async () => {
    const probe = probeWorld({ snapshot: true, flush: "eager" });
    const session = await started(probe);
    await session.prompt("only prompt");
    const submit = probe.recorded().find((entry) => entry.payload.hook_event_name === "UserPromptSubmit")!;
    expect(submit.transcript).toContain("only prompt");
  });
});

describe("what hook answers do", () => {
  test("exit 2 on UserPromptSubmit erases the prompt, and the turn does not run", async () => {
    for (const flush of ["lagging", "eager"] as const) {
      const probe = probeWorld({ mode: "block", flush });
      const session = await started(probe);
      expect(await session.prompt("please do it")).toBe(false);
      expect(typedPrompts(session.transcriptPath)).toHaveLength(0);
    }
  });

  test("additionalContext is saved as a hook_additional_context attachment where Claude Code puts it", async () => {
    const probe = probeWorld({ mode: "context" });
    const session = await started(probe);
    await session.prompt("hello");
    await session.main.tools([bashCall("toolu_01EEEEEEEEEEEEEEEEEEEEEE", "ls", "List files", "a")]);
    const lines = readLines(session.transcriptPath);
    const attachments = lines.filter((line) => line.type === "attachment");
    const events = attachments.map((line) => (line.attachment as { hookEvent: string }).hookEvent);
    expect(events).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolBatch"]);
    const submit = attachments[1]!.attachment as Record<string, unknown>;
    expect(submit.content).toEqual(["probe saw UserPromptSubmit"]);
    expect(String(submit.toolUseID)).toMatch(/^hook-[0-9a-f-]{36}$/);
    const prompt = lines.find((line) => line.type === "user" && line.message && line.promptSource === "typed")!;
    expect(attachments[1]!.parentUuid).toBe(prompt.uuid);
    const result = lines.findIndex((line) => Array.isArray((line.message as { content?: unknown })?.content));
    expect(lines.indexOf(attachments[2]!)).toBeGreaterThan(result);
  });

  test("a Stop hook's context is not saved: its continuation is not simulated, only logged", async () => {
    const probe = probeWorld({ mode: "context" });
    const session = await started(probe);
    await session.prompt("hello");
    await session.main.assistant("hi");
    await session.stop();
    const stop = probe.world.log.find((record) => record.event === "Stop")!;
    expect(stop.invocations[0]!.outcome.additionalContext).toBe("probe saw Stop");
    const events = readLines(session.transcriptPath)
      .filter((line) => line.type === "attachment")
      .map((line) => (line.attachment as { hookEvent: string }).hookEvent);
    expect(events).not.toContain("Stop");
  });

  test("a declined ask stops the call: no PostToolUse, and the result is Claude Code's rejection", async () => {
    const probe = probeWorld({ mode: "ask", askAnswer: "decline" });
    const session = await started(probe);
    await session.prompt("merge it");
    const [ran] = await session.main.tools([bashCall("toolu_01FFFFFFFFFFFFFFFFFFFFFF", "gh pr merge", "Merge", "ok")]);
    expect(ran!.result).toEqual({ ok: false, error: DECLINED, isInterrupt: false });
    const events = probe.world.log.map((record) => record.event);
    expect(events).not.toContain("PostToolUse");
    expect(events).not.toContain("PostToolUseFailure");
    expect(events.at(-1)).toBe("PostToolBatch");
  });

  test("an ask in bypassPermissions runs the call; in dontAsk it is a denial", async () => {
    const bypass = probeWorld({ mode: "ask", askAnswer: "decline", permissionMode: "bypassPermissions" });
    const runs = await started(bypass);
    await runs.prompt("merge it");
    const [ran] = await runs.main.tools([bashCall("toolu_01GGGGGGGGGGGGGGGGGGGGGG", "gh pr merge", "Merge", "ok")]);
    expect(ran!.result.ok).toBe(true);
    const dontAsk = probeWorld({ mode: "ask", permissionMode: "dontAsk" });
    const denied = await started(dontAsk);
    await denied.prompt("merge it");
    const [refused] = await denied.main.tools([bashCall("toolu_01HHHHHHHHHHHHHHHHHHHHHH", "gh pr merge", "M", "ok")]);
    expect(refused!.result.ok).toBe(false);
  });
});

describe("conversation structure", () => {
  test("a rewind re-submits from the old prompt's parent; the abandoned branch stays in the file", async () => {
    const probe = probeWorld();
    const session = await started(probe);
    await session.prompt("db is postgres");
    await session.main.assistant("ok");
    await session.prompt("what db do we use");
    await session.rewind(1, "db is sqlite");
    const prompts = typedPrompts(session.transcriptPath);
    expect(prompts.map((line) => (line.message as { content: string }).content)).toEqual([
      "db is postgres",
      "what db do we use",
      "db is sqlite",
    ]);
    expect(prompts[2]!.parentUuid).toBe(prompts[1]!.parentUuid);
  });

  test("a background subagent is in Stop's background_tasks until it completes, then notifies", async () => {
    const probe = probeWorld();
    const session = await started(probe);
    await session.prompt("look into it in the background");
    const spec = { agentType: "Explore", description: "Scan", task: "Scan the repo", background: true, report: "Done" };
    const run = (await session.subagent(spec, async () => {}))!;
    await session.main.assistant("started it");
    await session.stop();
    const done = await session.completeBackground(run, async (window) => {
      await window.tools([readCall("toolu_01JJJJJJJJJJJJJJJJJJJJJJ", join(probe.world.projectDir, "a.ts"), "x")]);
    });
    await session.taskNotification(done);
    await session.stop();
    const stops = probe.world.log.filter((record) => record.event === "Stop");
    expect((stops[0]!.payload.background_tasks as unknown[]).length).toBe(1);
    expect(stops[1]!.payload.background_tasks).toEqual([]);
    const submit = probe.world.log.filter((record) => record.event === "UserPromptSubmit").at(-1)!;
    expect(String(submit.payload.prompt).startsWith("<task-notification>")).toBe(true);
    expect(String(submit.payload.prompt)).toContain(`<task-id>${run.launch.agentId}</task-id>`);
    const order = probe.world.log.map((record) => `${record.event}@${record.window}`);
    const child = run.launch.agentId;
    expect(order.indexOf(`SubagentStart@${child}`)).toBeLessThan(order.indexOf("PostToolUse@main"));
    expect(order.indexOf(`SubagentStop@${child}`)).toBeGreaterThan(order.indexOf("Stop@main"));
  });

  test("SubagentStop reports the session's other running background subagents", async () => {
    const probe = probeWorld();
    const session = await started(probe);
    await session.prompt("two scans");
    const spec = (task: string) => ({ agentType: "Explore", description: task, task, background: true, report: "ok" });
    const first = (await session.subagent(spec("first scan"), async () => {}))!;
    const second = (await session.subagent(spec("second scan"), async () => {}))!;
    await session.completeBackground(first, async () => {});
    const stop = probe.world.log.find((record) => record.event === "SubagentStop")!;
    expect(stop.payload.background_tasks).toEqual([
      {
        id: second.launch.agentId,
        type: "subagent",
        status: "running",
        description: "second scan",
        agent_type: "Explore",
      },
    ]);
  });

  test("after compaction, prompts of the compacted conversation are no longer rewind targets", async () => {
    const probe = probeWorld();
    const session = await started(probe);
    await session.prompt("before compaction");
    await session.compact("auto", "Summary.");
    await expect(session.rewind(0, "edited")).rejects.toThrow("no human prompt #0");
    await session.prompt("after compaction");
    expect(await session.rewind(0, "edited after")).toBe(true);
  });

  test("compaction writes the boundary and summary, and its events come in the captured order", async () => {
    const probe = probeWorld();
    const session = await started(probe);
    await session.prompt("long work");
    await session.compact("auto", "Summary: the db is sqlite.");
    const lines = readLines(session.transcriptPath);
    const boundary = lines.find((line) => line.subtype === "compact_boundary")!;
    expect(boundary.parentUuid).toBeNull();
    expect(boundary.logicalParentUuid).toBe(lines[lines.indexOf(boundary) - 1]!.uuid);
    expect(lines[lines.indexOf(boundary) + 1]!.isCompactSummary).toBe(true);
    const events = probe.world.log.slice(-5).map((record) => record.event);
    expect(events).toEqual(["PreCompact", "SubagentStop", "SessionStart", "PostCompact", "InstructionsLoaded"]);
  });

  test("exit 2 on PreCompact blocks compaction", async () => {
    const probe = probeWorld({ mode: "block" });
    const session = await started(probe);
    expect(await session.prompt("x")).toBe(false);
    expect(await session.compact("manual", "s")).toBe(false);
    expect(linesOf(session.transcriptPath).some((line) => line.subtype === "compact_boundary")).toBe(false);
  });

  test("/clear ends the session and starts a new one with source clear", async () => {
    const probe = probeWorld();
    const session = await started(probe);
    await session.prompt("x");
    const next = await session.clear();
    expect(next.sessionId).not.toBe(session.sessionId);
    const tail = probe.world.log
      .slice(-3)
      .map((record) => [record.event, record.payload.reason ?? record.payload.source]);
    expect(tail).toEqual([
      ["SessionEnd", "clear"],
      ["InstructionsLoaded", undefined],
      ["SessionStart", "clear"],
    ]);
  });
});

describe("nested instruction files (R0 F17; captured on Claude Code 2.1.294)", () => {
  const NESTED = "# Web\n\nThe web app uses vitest.\n";

  test("a Read under a folder with its own CLAUDE.md loads it once: an attachment, then a lazy InstructionsLoaded", async () => {
    const probe = probeWorld({ projectFiles: { "CLAUDE.md": "# Root\n", "apps/web/CLAUDE.md": NESTED } });
    const session = await started(probe);
    await session.prompt("open the web login");
    const at = (path: string) => join(probe.world.projectDir, path);
    await session.main.tools([readCall("toolu_1", at("apps/web/login.ts"), "export {};")]);
    await session.main.tools([readCall("toolu_2", at("apps/web/page.ts"), "export {};")]);
    const loads = probe.world.log.filter((record) => record.event === "InstructionsLoaded");
    expect(loads.map((record) => record.payload.load_reason)).toEqual(["session_start", "nested_traversal"]);
    // The captured key order of a lazy load.
    expect(Object.keys(loads[1]!.payload)).toEqual([
      "session_id",
      "transcript_path",
      "cwd",
      "prompt_id",
      "effort",
      "hook_event_name",
      "file_path",
      "memory_type",
      "load_reason",
      "trigger_file_path",
    ]);
    expect(loads[1]!.payload.trigger_file_path).toBe(at("apps/web/login.ts"));
    const attachment = readLines(session.transcriptPath).find(
      (line) => (line.attachment as { type?: string } | undefined)?.type === "nested_memory",
    );
    expect((attachment?.attachment as { displayPath?: string }).displayPath).toBe("apps/web/CLAUDE.md");
    expect(session.main.seen.snapshot().text).toContain("The web app uses vitest.");
  });

  test("a compaction drops the nested file from the window; the next access loads it again", async () => {
    const probe = probeWorld({ projectFiles: { "apps/web/CLAUDE.md": NESTED } });
    const session = await started(probe);
    await session.prompt("open the web login");
    const read = (id: string) => readCall(id, join(probe.world.projectDir, "apps/web/login.ts"), "export {};");
    await session.main.tools([read("toolu_1")]);
    await session.compact("manual", "Summary: the login page was opened.");
    expect(session.main.seen.snapshot().text).not.toContain("The web app uses vitest.");
    await session.prompt("open it again");
    await session.main.tools([read("toolu_2")]);
    const lazy = probe.world.log.filter((record) => record.payload.load_reason === "nested_traversal");
    expect(lazy).toHaveLength(2);
    expect(session.main.seen.snapshot().text).toContain("The web app uses vitest.");
  });

  test("a subagent's file access loads nothing (R0 F35)", async () => {
    const probe = probeWorld({ projectFiles: { "apps/web/CLAUDE.md": NESTED } });
    const session = await started(probe);
    await session.prompt("explore the web app");
    const spec = {
      agentType: "Explore",
      description: "Look",
      task: "Read the login.",
      background: false,
      report: "ok",
    };
    await session.subagent(spec, async (window) => {
      await window.tools([readCall("toolu_1", join(probe.world.projectDir, "apps/web/login.ts"), "export {};")]);
    });
    expect(probe.world.log.filter((record) => record.payload.load_reason === "nested_traversal")).toEqual([]);
  });
});

describe("generated sessions play through", () => {
  test("200 R6-shaped scripts replay without error (plugin with no hooks)", async () => {
    const root = tempDir("eden-empty-plugin");
    mkdirSync(join(root, "hooks"));
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
    const plugin = loadPlugin(root);
    for (let seed = 1; seed <= 200; seed++) {
      const world = new SimWorld({ runDir: tempDir("eden-play"), plugin, seed });
      const script = generateSession(seed, { toolScale: 0.1, growthScale: 0.05 });
      const { skipped } = await play(script, world);
      expect({ seed, skipped }).toEqual({ seed, skipped: 0 });
      const files = readdirSync(join(world.home, ".claude", "projects"), { recursive: true });
      expect(files.some((name) => String(name).endsWith(".jsonl"))).toBe(true);
    }
  }, 120_000);
});
