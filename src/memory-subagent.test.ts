/**
 * M45.3: subagent windows and shared writers. Since P0.5 a subagent's rows go to its repo's store and its window is
 * `session--agent` (D1, D2); the per-session child stores the M45 tests pinned are gone (#64).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { HowToStore } from "./howto-store";
import { childSessionName, MEMORY_MARK, openMemory, injectedPackets } from "./index";
import { SemanticStore } from "./semantic-store";
import { cuesBelowTau } from "../scripts/test-below-tau";

cuesBelowTau();

const PARENT = "parent";
const AGENT = "agent-1";
const CHILD = `${PARENT}--${AGENT}`;
const DB_CUE = "what database do we use";
const SQLITE = "The database is sqlite.";
const CHILD_CHATTER = "We shipped the m45child widget.";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "eden-m45-"));
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const QUIET = {
  EDEN_MEMORY: "on",
  EDEN_HOME: undefined,
  EDEN_KNOW: "0",
  EDEN_SLEEP_EVERY: "0",
  EDEN_SLEEP_IDLE: "0",
  EDEN_MEMORY_MIN: undefined,
  EDEN_MEMORY_PARENT: undefined,
  EDEN_MEMORY_SESSION: undefined,
  EDEN_MEMORY_CHILD: undefined,
  EDEN_MEMORY_AGENT: undefined,
  EDEN_MEMORY_PROJECT: undefined,
} as const;

function packet(messages: unknown[]): string {
  return injectedPackets(messages).join("\n");
}

function hookContext(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const spec = raw.hookSpecificOutput;
  const extra = spec && typeof spec === "object" ? (spec as { additionalContext?: unknown }).additionalContext : "";
  return [raw.additional_context, extra].map((x) => String(x ?? "")).join("\n");
}

function parentStop(messages: { role: string; content: string }[]): void {
  memoryHookResponse({
    hook_event_name: "Stop",
    session_id: PARENT,
    messages,
  });
}

function childSubmit(prompt: string, messages?: { role: string; content: string }[]): Record<string, unknown> | null {
  return memoryHookResponse({
    hook_event_name: "UserPromptSubmit",
    session_id: PARENT,
    agent_id: AGENT,
    prompt,
    ...(messages ? { messages } : {}),
  });
}

describe("M45 subagent share", () => {
  test("childSessionName suffixes with --", () => {
    expect(childSessionName(PARENT, AGENT)).toBe(CHILD);
    expect(childSessionName("s-parent")).toBe("s-parent");
  });

  test("EDEN_MEMORY_PARENT alone does not make a parent Submit a parent--sub window (D2)", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir, EDEN_MEMORY_PARENT: PARENT }, () => {
        parentStop([{ role: "user", content: SQLITE }]);
        const hit = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: PARENT,
          prompt: DB_CUE,
        });
        expect(hookContext(hit)).toMatch(/sqlite/i);
      });
      expect(existsSync(join(dir, "windows", PARENT))).toBe(true);
      expect(existsSync(join(dir, "windows", `${PARENT}--sub`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two batched semantic writers keep both parent facts", () => {
    const dir = tmpDir();
    try {
      const a = new SemanticStore(dir);
      const b = new SemanticStore(dir);
      a.beginBatch();
      b.beginBatch();
      a.put("database", "is", "sqlite", 10);
      b.put("auth", "is", "Clerk", 11);
      a.endBatch();
      b.endBatch();
      const live = new SemanticStore(dir).live().map((row) => row.o);
      expect(live.some((o) => /sqlite/i.test(o))).toBe(true);
      expect(live.some((o) => /clerk/i.test(o))).toBe(true);
      const raw = readFileSync(join(dir, "semantic.jsonl"), "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two howto writers keep both exit-0 rows", () => {
    const dir = tmpDir();
    try {
      const a = new HowToStore(dir);
      const b = new HowToStore(dir);
      const left = a.put({
        cue: "auth pytest flake",
        steps: [{ name: "Bash", exit: 0 }],
        files: ["auth.ts"],
        exit: 0,
        t: 1,
      });
      const right = b.put({
        cue: "lint the api",
        steps: [{ name: "Bash", exit: 0 }],
        files: ["api.ts"],
        exit: 0,
        t: 2,
      });
      expect(left?.id).toBeTruthy();
      expect(right?.id).toBeTruthy();
      const ids = new HowToStore(dir).latest("auth api lint pytest", 10).map((r) => r.id);
      expect(ids).toContain(left!.id);
      expect(ids).toContain(right!.id);
      const raw = readFileSync(join(dir, "howto.jsonl"), "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chat-only child injects no [procedure]", async () => {
    const dir = tmpDir();
    try {
      const child = openMemory({ dir, session: CHILD, child: true });
      child.observe([{ role: "user", content: CHILD_CHATTER }]);
      await child.sleep({ session: CHILD });
      const pkt = packet(child.inject([{ role: "user", content: "how do I fix the auth flake" }]));
      expect(pkt).not.toMatch(/\[procedure(?:\s*[·|][^\]]*)?\]/i);
      expect(existsSync(join(dir, "howto.jsonl"))).toBe(false);
      child.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SessionStart briefs the pin; child math cue stays silent", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        parentStop([
          { role: "user", content: "always use sqlite" },
          { role: "user", content: SQLITE },
        ]);
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: PARENT });
        expect(hookContext(start)).toMatch(/sqlite/i);
        expect(JSON.stringify(start ?? {})).not.toMatch(/\b(?:verify|unknown): /);
        const math = childSubmit("what is 2 + 2");
        expect(hookContext(math)).not.toContain(MEMORY_MARK);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("child observe redacts secrets and does not store session or email", async () => {
    const dir = tmpDir();
    const secret = "sk-m45childsecretkeyvalue";
    try {
      const child = openMemory({ dir, session: CHILD, child: true, cwd: "/tmp/eden-m45-cwd" });
      child.observe([
        {
          role: "user",
          content: `The token is ${secret}. Mail me at ada@example.com about session ${CHILD}.`,
        },
      ]);
      child.close();
      const text = readFileSync(join(dir, CHILD, "memories.jsonl"), "utf8");
      expect(text).not.toContain(secret);
      expect(text).toMatch(/REDACTED/i);
      expect(text).not.toContain("ada@example.com");
      expect(text).not.toContain(CHILD);
      expect(text).not.toContain("/tmp/eden-m45-cwd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
