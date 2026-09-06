import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryHookResponse, messagesFromTranscript, notesFromInject } from "./memory-hook";
import { respondToHook } from "./hook";
import { MEMORY_MARK } from "../../../src/index";

describe("passive memory hooks", () => {
  test("UserPromptSubmit stores a durable fact and later injects it", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-mem-hook");
    const memDir = join(home, "memory");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_MEMORY_DIR = memDir;

    const first = await respondToHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-mem",
      prompt: "Kai's timezone is Pacific",
    });
    expect(first.ok).toBe(true);

    const later = await respondToHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-mem",
      prompt: "What time should I ping Kai about the release?",
    });
    const ctx = (later.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(ctx).toContain(MEMORY_MARK);
    expect(ctx).toMatch(/Pacific/i);

    rmSync(home, { recursive: true, force: true });
  });

  test("chatter is not stored or injected", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-mem-junk");
    const memDir = join(home, "memory");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_MEMORY_DIR = memDir;

    await respondToHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-junk",
      prompt: "ok thanks",
    });
    const later = await respondToHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-junk",
      prompt: "What timezone is Kai in?",
    });
    const ctx = (later.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(ctx).not.toMatch(/ok thanks/i);

    rmSync(home, { recursive: true, force: true });
  });

  test("SessionStart briefs stored constraints", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-start");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_MEMORY_DIR = memDir;
    memoryHookResponse({
      hook_event_name: "UserPromptSubmit",
      prompt: "Never commit .env or credentials.json",
    });
    const start = memoryHookResponse({ hook_event_name: "SessionStart" });
    const ctx = (start?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(ctx).toContain(MEMORY_MARK);
    expect(ctx).toMatch(/\.env/i);
    rmSync(memDir, { recursive: true, force: true });
  });

  test("Stop observes a Claude transcript without injecting", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-stop");
    const trans = join(memDir, "t.jsonl");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      trans,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "Always run bun test before you push." } })}\n`,
    );
    process.env.EDEN_MEMORY_DIR = memDir;
    const stop = memoryHookResponse({ hook_event_name: "Stop", transcript_path: trans });
    expect(stop).toBeNull();
    const later = memoryHookResponse({
      hook_event_name: "UserPromptSubmit",
      prompt: "What should I run before I push?",
    });
    const ctx = (later?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(ctx).toMatch(/bun test/i);
    rmSync(memDir, { recursive: true, force: true });
  });

  test("missing transcript fails open", () => {
    process.env.EDEN_MEMORY_DIR = join(import.meta.dir, "../../.tmp-eden-mem-missing");
    mkdirSync(process.env.EDEN_MEMORY_DIR, { recursive: true });
    expect(messagesFromTranscript("/no/such/transcript.jsonl")).toEqual([]);
    expect(memoryHookResponse({ hook_event_name: "PreCompact", transcript_path: "/no/such/transcript.jsonl" })).toBeNull();
    rmSync(process.env.EDEN_MEMORY_DIR, { recursive: true, force: true });
  });

  test("notesFromInject keeps only memory system notes", () => {
    expect(
      notesFromInject([
        { role: "system", content: `${MEMORY_MARK}\n- Pacific` },
        { role: "user", content: "hi" },
        { role: "system", content: "unrelated" },
      ]),
    ).toContain("Pacific");
  });

  test("plugin hook script finds this checkout and fail-opens on chatter", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-plugin");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    const script = join(import.meta.dir, "../../../plugins/eden-memory/scripts/hook.ts");
    const r = spawnSync("bun", [script], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "ok thanks" }),
      encoding: "utf8",
      env: { ...process.env, EDEN_MEMORY_DIR: memDir },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout || "{}")).toEqual({});
    rmSync(memDir, { recursive: true, force: true });
  });
});
