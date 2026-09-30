/**
 * M50.1 — product callers stay silent inject.
 * Grep only. Does not re-run the Plan §7 walkthrough.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { AgentMemory, MEMORY_MARK, openMemory } from "./index";
import { DENSE_RAG } from "./memory-dense";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/63

const ROOT = join(import.meta.dir, "..");

const PRODUCT = [
  "packages/wrap/src/proxy.ts",
  "packages/wrap/src/know-inject.ts",
  "packages/wrap/src/tool-observe.ts",
  "packages/cli/src/memory-hook.ts",
  "packages/cli/src/hook.ts",
  "packages/cli/src/setup.ts",
  "packages/cli/src/doctor.ts",
];

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("M50.1 ship locks", () => {
  test("DENSE_RAG is false", () => {
    expect(DENSE_RAG).toBe(false);
    const dense = readFileSync(join(import.meta.dir, "memory-dense.ts"), "utf8");
    expect(dense).toMatch(/export const DENSE_RAG = false as const/);
  });

  test("wrap, hook, setup, and doctor product callers have zero memory_search", () => {
    const wrapDir = join(ROOT, "packages/wrap/src");
    const wrapSrc = readdirSync(wrapDir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
    const files = [...new Set([...PRODUCT, ...wrapSrc.map((n) => `packages/wrap/src/${n}`)])];
    for (const rel of files) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/\bmemory_search\b/);
      expect(src, rel).not.toMatch(/\bmemorable-cli\b/);
    }
  });

  test("walkthrough file still describes M36.2 steps 1–10 and M49.3", () => {
    const src = readFileSync(join(import.meta.dir, "memory-walkthrough.test.ts"), "utf8");
    for (let n = 1; n <= 10; n++) {
      expect(src).toContain(`describe("M36.2 walkthrough ${n}`);
    }
    expect(src).toContain('describe("M49.3 first session');
    expect(src).toContain("wrap OpenAI and Anthropic");
    expect(src).toContain("hook:");
  });

  test("notesFor throw returns the original messages on inject, wrap OpenAI, Anthropic, and hook", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m50-fo-"));
    const prev = process.env.EDEN_MEMORY_DIR;
    const home = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    const boom = spyOn(AgentMemory.prototype, "notesFor").mockImplementation(() => {
      throw new Error("m50 notesFor boom");
    });
    try {
      const mem = openMemory({ dir });
      const list = [{ role: "user", content: "what database do we use" }];
      expect(mem.inject(list)).toBe(list);
      const openai = { messages: [{ role: "user", content: "what database do we use" }] };
      expect(withKnowFacts(openai)).toBe(openai);
      const anth = { messages: [{ role: "user", content: "what database do we use" }] };
      const anthOut = withKnowFactsAnthropic(anth);
      expect(anthOut.messages).toEqual(anth.messages);
      expect(JSON.stringify(anthOut)).not.toContain(MEMORY_MARK);
      const hook = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what database do we use" });
      const ctx =
        String(hook?.additional_context ?? "") +
        String((hook?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "");
      expect(ctx).not.toContain(MEMORY_MARK);
    } finally {
      boom.mockRestore();
      if (prev === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prev;
      if (home === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = home;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("hook session A Stop sqlite/Clerk, session B Submit injects them; math omits", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m50-m44-"));
    const prev = process.env.EDEN_MEMORY_DIR;
    const home = process.env.EDEN_HOME;
    const memFlag = process.env.EDEN_MEMORY;
    process.env.EDEN_MEMORY_DIR = dir;
    process.env.EDEN_MEMORY = "on";
    delete process.env.EDEN_HOME;
    try {
      memoryHookResponse({
        hook_event_name: "Stop",
        session_id: "m50-a",
        messages: [
          { role: "user", content: "The database is sqlite." },
          { role: "user", content: "Auth is Clerk." },
        ],
      });
      const db = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        session_id: "m50-b",
        prompt: "what database do we use",
      });
      const auth = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        session_id: "m50-b",
        prompt: "what auth do we use",
      });
      const math = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        session_id: "m50-b",
        prompt: "what's 2+2?",
      });
      const dbTxt = String(db?.additional_context ?? "");
      const authTxt = String(auth?.additional_context ?? "");
      const mathTxt = String(math?.additional_context ?? "");
      expect(dbTxt).toContain(MEMORY_MARK);
      expect(dbTxt).toMatch(/sqlite/i);
      expect(authTxt).toMatch(/Clerk/);
      expect(mathTxt).not.toContain(MEMORY_MARK);
    } finally {
      if (prev === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prev;
      if (home === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = home;
      if (memFlag === undefined) delete process.env.EDEN_MEMORY;
      else process.env.EDEN_MEMORY = memFlag;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("second session still injects sqlite; 2+2 omits; SessionStart still briefs the pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m50-s2-"));
    const prev = process.env.EDEN_MEMORY_DIR;
    const home = process.env.EDEN_HOME;
    const memFlag = process.env.EDEN_MEMORY;
    process.env.EDEN_MEMORY_DIR = dir;
    process.env.EDEN_MEMORY = "on";
    delete process.env.EDEN_HOME;
    try {
      const first = openMemory({ dir });
      first.observe([{ role: "user", content: "Always use sqlite." }]);
      first.close();
      const second = openMemory({ dir });
      const db = second.inject([{ role: "user", content: "what database do we use" }]);
      expect(JSON.stringify(db)).toMatch(/sqlite/i);
      const math = second.inject([{ role: "user", content: "what's 2+2?" }]);
      expect(JSON.stringify(math)).not.toContain(MEMORY_MARK);
      const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: "s-m50-2" });
      const brief =
        String(start?.additional_context ?? "") +
        String((start?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "");
      expect(brief).toMatch(/sqlite/i);
      const mathHook = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        prompt: "what's 2+2?",
        session_id: "s-m50-2",
      });
      const mathCtx = String(mathHook?.additional_context ?? "");
      expect(mathCtx).not.toContain(MEMORY_MARK);
      second.close();
    } finally {
      if (prev === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prev;
      if (home === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = home;
      if (memFlag === undefined) delete process.env.EDEN_MEMORY;
      else process.env.EDEN_MEMORY = memFlag;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
